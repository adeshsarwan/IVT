# Ad Pass: pending database changes

Status: **proposal only. Nothing here is applied.** The Ad Pass hot path works today without any of
it (KV + signed tokens). These changes add attribution, audit and reporting, and are meant to ship
together in one reviewed migration (`0005_ad_pass.sql`), following the release steps in
`docs/DEVELOPER_HANDOFF.md` (isolated bindings first, D1 backup, additive migration, then deploy).

The SQL below is kept in this document on purpose, not in `migrations/`, so that
`wrangler d1 migrations apply` cannot pick it up before review.

## 1. Decisions to settle first

| # | Question | Current Ad Pass behaviour | Recommendation |
|---|---|---|---|
| D1 | Is an "affiliate" the same thing as a `media_buyers` row? The schema already has `media_buyers` and `traffic_sessions.buyer_id` (never populated). | `?aff=<id>` matched against ids in the KV ad config | Yes: `aff` value = `media_buyers.buyer_key`. One concept, one table. |
| D2 | The README invariant says no client-provided buyer ID is trusted. `?aff=` is client-provided. | Accepted risk: a wrong id sends revenue to someone else's ad units, so there is no payout gain | Keep `?aff=` for now, but store it as **claimed** (`claimed_affiliate`) and only set `buyer_id` when it resolves to a known, enabled buyer for that site. Move to server-owned tracking routes (`tracking_routes`) later, as the handoff doc asks. |
| D3 | Which store is the authority for ad config? The handoff proposes D1 `site_monetization_configs`; Ad Pass reads KV. | KV `adunits:site:<siteKey>` | D1 is the source of truth with an audit trail; a publish step writes the KV document. The hot path keeps reading KV only. |
| D4 | Where do per-pageview Ad Pass counts live? | Nowhere | Workers Analytics Engine, not D1 (see section 2E). |

## 2. Changes

### 2A. `traffic_sessions`: record the affiliate and the Ad Pass outcome per visit

`/v1/admit` already inserts this row, so recording the outcome adds no extra database write.

```sql
ALTER TABLE traffic_sessions ADD COLUMN claimed_affiliate TEXT;   -- raw ?aff= (format-checked), claimed only
ALTER TABLE traffic_sessions ADD COLUMN ad_pass_status TEXT;      -- ISSUED | OFF | NOT_ELIGIBLE | KILLED | NO_CONFIG
                                                                  -- | UNKNOWN_AFFILIATE | NO_HOUSE_UNITS | NO_BINDING | NO_SECRET
ALTER TABLE traffic_sessions ADD COLUMN ad_pass_mode TEXT;        -- off | observe | enforce at issue time
ALTER TABLE traffic_sessions ADD COLUMN ad_pass_tag TEXT;         -- ivt_t (12 hex) of the issued pass, joins to GAM impressions
CREATE INDEX IF NOT EXISTS idx_sessions_site_buyer_created ON traffic_sessions(site_id, buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_adpass_created ON traffic_sessions(ad_pass_status, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_adpass_tag ON traffic_sessions(ad_pass_tag);
```

- `buyer_id` (existing column) is set only when `claimed_affiliate` matches an enabled buyer for that site.
- The status codes stay server-side, as the README requires.

### 2B. Ad config authority (aligned with the handoff's `site_monetization_configs`)

```sql
CREATE TABLE IF NOT EXISTS site_monetization_configs (
  site_id INTEGER PRIMARY KEY REFERENCES sites(id),
  provider TEXT NOT NULL DEFAULT 'GAM',
  enabled INTEGER NOT NULL DEFAULT 0,
  network_code TEXT NOT NULL,
  house_units_json TEXT,                 -- optional {slots, targeting} for visits without ?aff=
  config_version INTEGER NOT NULL DEFAULT 1,
  published_at TEXT,                     -- last time this was written to KV
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_buyer_ad_units (
  site_id INTEGER NOT NULL REFERENCES sites(id),
  buyer_id INTEGER NOT NULL REFERENCES media_buyers(id),
  slots_json TEXT NOT NULL,              -- [{div, path, sizes}], paths under /<network_code>/
  targeting_json TEXT,                   -- extra key-values; aff/ivt_* are reserved
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (site_id, buyer_id)
);

CREATE TABLE IF NOT EXISTS monetization_config_audit (  -- append-only
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  buyer_id INTEGER,
  action TEXT NOT NULL,                  -- CREATE | UPDATE | DISABLE | PUBLISH
  config_version INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_config_audit_site_created ON monetization_config_audit(site_id, created_at);
```

- **Publish step:** a small admin script or endpoint builds the v2 KV document from these tables,
  checks it with `parseAdUnitConfig`, writes `adunits:site:<siteKey>`, and logs `PUBLISH`.
- `config_version` should go into the pass as well, so that publishing a new config can
  invalidate outstanding passes for that site.

### 2C. Kill switch audit

KV holds the live switch; D1 records who flipped it and why.

```sql
CREATE TABLE IF NOT EXISTS ad_kill_switch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kv_key TEXT NOT NULL,                  -- ads:global | ads:site:<siteKey> | ads:aff:<buyerKey>
  value TEXT NOT NULL,                   -- off | on (deleted)
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kill_events_key_created ON ad_kill_switch_events(kv_key, created_at);
```

### 2D. GAM reconciliation (bypass detection)

Fits the handoff's `reconciliation_runs` design: one import run per report date.

```sql
CREATE TABLE IF NOT EXISTS gam_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,             -- UTC date, same day boundary as ivt_k
  status TEXT NOT NULL,                  -- RUNNING | COMPLETE | FAILED
  rows_imported INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS gam_daily_delivery (
  report_date TEXT NOT NULL,
  site_key TEXT NOT NULL,
  aff TEXT NOT NULL,                     -- key-value as reported (buyer_key or 'house'; '' if missing)
  ad_unit_path TEXT NOT NULL,
  ivt_k TEXT NOT NULL,                   -- '' when the impression had no ivt_k
  ivt_e TEXT NOT NULL,                   -- '1' | '0' | ''
  impressions INTEGER NOT NULL,
  revenue_micros INTEGER NOT NULL,
  import_run_id INTEGER NOT NULL REFERENCES gam_import_runs(id),
  PRIMARY KEY (report_date, site_key, aff, ad_unit_path, ivt_k, ivt_e)
);
CREATE INDEX IF NOT EXISTS idx_gam_delivery_date_aff ON gam_daily_delivery(report_date, aff);
```

The daily checks this enables:
- **Bypass:** impressions where `ivt_k` is empty or differs from `ivt_k(date, site)`. Group by `aff`
  and ad unit to name the affiliate.
- **Volume:** GAM impressions per site and affiliate should be at most passes redeemed × slots,
  with redemptions taken from Analytics Engine (2E).
- **Quality:** revenue split by `ivt_e` (only meaningful while running in observe mode).

### 2E. Analytics Engine (not a D1 change, same release)

`/v1/ad-units` runs on every pageview with ads and again for late slots, so it should not write to
D1. Instead, write one data point per call with `env.AD_PASS_EVENTS.writeDataPoint()`. The call is
fire-and-forget and does not slow the response.

```jsonc
// wrangler.jsonc
"analytics_engine_datasets": [{ "binding": "AD_PASS_EVENTS", "dataset": "thebes_ad_pass" }]
```

| Field | Value |
|---|---|
| `indexes[0]` | site key |
| `blobs` | event (`ISSUE` / `REDEEM`), outcome (`OK` or internal deny reason), affiliate (`house` if none), mode, key id |
| `doubles` | slots returned, pass age in seconds |

Queried with SQL over the Analytics Engine API, joined to `gam_daily_delivery` by date, site and affiliate.

## 3. Code changes that ship with the migration

- `maybeIssueAdPass` returns `{ pass, status }`. `/v1/admit` writes `claimed_affiliate`,
  `ad_pass_status`, `ad_pass_mode`, `ad_pass_tag` and the resolved `buyer_id` in its existing INSERT.
- Pass claims gain `cv` (config version); `/v1/ad-units` checks it against the KV document.
- Analytics Engine writes in `/v1/admit` (issue outcome) and `/v1/ad-units` (redeem outcome).
- Admin publish path: D1 config → validated KV document → audit row.
- Kill-switch helper that writes KV and `ad_kill_switch_events` together.
- GAM report import job (Ad Manager API, daily, idempotent per `report_date`).
- Tests for each item; production verification stays read-only.

## 4. Order of work

1. Settle D1–D4 with the partner.
2. Write `0005_ad_pass.sql` from sections 2A–2D. Test on an isolated D1 database, then back up production.
3. Implement section 3 behind the existing `AD_PASS_MODE=off`, so nothing changes for live traffic.
4. Apply the migration, deploy, seed `media_buyers` and the configs, publish to KV.
5. Turn on `observe`, run the GAM import for a few days, then `enforce`.
