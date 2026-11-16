# Ad Pass

Ads load **only** after the IVT Worker approves the visit. If the server says no, is unreachable,
is slow, or anything is malformed, **no ads load** (fail closed).

Scope: the gating mechanism only. *How* the IVT decides eligibility is out of scope here.

## 1. Flow

```
Partner page (no GPT tag, no ad unit IDs):
  <script src="https://ivt.thebesads.com/v1/ivt.js" data-auto-init="true"
          data-endpoint="https://ivt.thebesads.com" data-site-key="gamewhame.com"></script>
  <script src="https://ivt.thebesads.com/v1/ads.js" async></script>
  <div data-ad-slot="top"></div>
  <div data-ad-slot="mid"></div>

Browser                                    Worker
ivt.js  ── POST /v1/admit ─────────────▶   score visit (unchanged)
                                           AD_PASS_MODE gate + eligibility
                                           kill switches + site ad config (KV)
        ◀── {..., adPass?} ──────────────   pass only if all OK
ads.js  ── POST /v1/ad-units {adPass} ──▶   origin allowlist, signature, kid, expiry,
                                           policy version, origin, IP /24|/64 + UA binding
                                           kill switches + config re-checked
                                           single-use nonce claim (Durable Object)
        ◀── 403 (empty) ─────────────────   any failure
        ◀── {gpt, networkCode, slots, targeting} (no-store)
ads.js: load GPT, define slots on [data-ad-slot], set targeting, display
```

- `ivt.js` only exposes the opaque `adPass` string on its admission result. It contains no GAM
  URL, ad unit path or slot logic (asserted by `tests/ads-sdk.test.ts`).
- `ads.js` (`src/sdk/ads.ts`) is a separate bundle. It waits for `window.__THEBES_IVT_INIT__`
  (or the `thebes:ivt-init` event if it loads first) within one deadline (`data-timeout-ms`,
  default 8000, clamped 50–20000). It redeems the pass once, removes it from the shared admission
  result, and validates the response (exact GPT URL, slot paths under the network code). Any
  error, timeout or missing placeholder → no GPT request. No fallback, no cache, no retry.
- The GPT URL is a server constant; the KV config cannot change which script loads.

## 2. Modes (`AD_PASS_MODE`)

| Value | `/v1/admit` | `/v1/ad-units` |
|---|---|---|
| `off` (default, release value) | never returns `adPass`; response identical to before | always 403 |
| `observe` | pass to **every** admitted session that clears kill switches + config; claim `e` = would-be eligibility | serves config; targeting `ivt_e=0/1` |
| `enforce` | pass **only** when eligible (and kill switches + config OK) | serves config |

Eligibility = `CLEAN` + `WOULD_PASS` when the site is in IVT shadow mode (the would-be decision),
or `CLEAN` + `PASS` when the site is in IVT enforce mode. The existing runtime capability,
telemetry token and `monetization.eligible` field are unchanged in every mode. Unknown values = `off`.

`observe` lets the loader replace hard-coded GPT without losing revenue while GAM reports split
revenue by `ivt_e`; switch to `enforce` to actually gate.

## 3. Token format

`<kid>.<payload>.<sig>`

- `payload` = base64url(JSON claims), `sig` = base64url(HMAC-SHA256(key, "adpass.v1.<kid>.<payload>")).
- Verified with constant-time comparison; the kid only selects the key (current or previous).

| Claim | Meaning |
|---|---|
| `v` | format version (1) |
| `typ` | `"adpass"` |
| `sid` | IVT session id |
| `site`, `sk` | `sites.id`, site key |
| `o` | exact origin (`https://www.x` ≠ `https://x`) |
| `iat`, `exp` | unix seconds; `exp - iat` = `AD_PASS_TTL_SECONDS` (default 60, clamped 15–300) |
| `n` | 128-bit random nonce (single-use key, `ivt_t` source) |
| `pv` | `AD_PASS_POLICY_VERSION`; bump it to invalidate every outstanding pass |
| `aff` | affiliate id from the site config (null if none) |
| `e` | 1 = eligible at issuance (always 1 in `enforce`) |
| `ih`, `uh` | keyed hashes (16 bytes) of the client IP prefix (IPv4 /24, IPv6 /64, from `CF-Connecting-IP`) and the `User-Agent` header |

The pass contains no raw IP/UA and no ad information.

## 4. Single use

`AD_PASS_SINGLE_USE` (default `on`): `/v1/ad-units` claims `adpass:<nonce>` in the existing
`ReplayGuard` Durable Object (`POST /claim`; first claim wins, storage wiped by an alarm at
`exp + 60s`). Nothing is written at admission and there is no D1 table.

`off` = purely stateless. Trade-off: a pass can then be replayed until it expires, but only from
the same IP prefix and User-Agent and the same origin. Cost of `on`: one DO round trip per
pageview with ads. If the DO is unreachable the request is denied.

## 5. KV keys (`IVT_CONFIG`)

### Kill switches (read on **both** calls)

| Key | Effect |
|---|---|
| `ads:global` | all ads |
| `ads:site:<siteKey>` | one site, e.g. `ads:site:gamewhame.com` |
| `ads:aff:<affiliate>` | one affiliate (the `affiliate` in the site's ad config) |

Absent or `on` = allowed. **Any other value** (`off`, `0`, …) = disabled. KV read error = disabled.
Takes effect on the next call (KV propagation: seconds to ~60s).

```bash
npx wrangler kv key put --binding IVT_CONFIG "ads:site:gamewhame.com" off --remote
npx wrangler kv key delete --binding IVT_CONFIG "ads:site:gamewhame.com" --remote
```

### Ad-unit config `adunits:site:<siteKey>`

```json
{
  "v": 1,
  "networkCode": "1234567",
  "affiliate": "42",
  "slots": [
    { "div": "top", "path": "/1234567/aff_42/top", "sizes": [[300, 250], [336, 280]] },
    { "div": "mid", "path": "/1234567/aff_42/mid", "sizes": [[300, 250]] }
  ],
  "targeting": { "aff": "42" }
}
```

Strict schema (`parseAdUnitConfig`): unknown fields rejected; 1–20 slots; unique `div`; `path` must
start with `/<networkCode>/`; sizes are integer pairs 1–2000; targeting keys `[a-z0-9_]{1,20}`,
values `[A-Za-z0-9_.:-]{1,40}` (or arrays of up to 10); `ivt_k`, `ivt_t`, `ivt_e` are reserved.
Missing or invalid config → no pass and 403. There is **no global/fallback config**. The config is
read at admission too, so sites without one never cost a pass.

## 6. Audit key-values (stateless)

Returned in `/v1/ad-units` `targeting` and set on GPT:

- `ivt_k` = first 5 bytes (10 hex) of `HMAC(AD_PASS_SECRET, "ivt_k.<YYYY-MM-DD UTC>.<siteKey>")`.
  Recomputable later for any date/site; no storage.
- `ivt_t` = first 6 bytes (12 hex) of `HMAC(AD_PASS_SECRET, "ivt_t.<nonce>")`: per-pass tag for
  optional impression-level audit.
- `ivt_e` = `1`/`0` eligibility at issuance.

Detection: GAM report of impressions per ad unit by `ivt_k`; impressions where `ivt_k` is missing
or not today's value = ads loaded without our loader → kill that affiliate. Uses the **current**
key; rotate `AD_PASS_SECRET` at UTC midnight, or check both keys for the rotation day.

## 7. Secrets and vars

| Name | Type | Notes |
|---|---|---|
| `AD_PASS_SECRET` | secret | ≥32 chars, separate from `IVT_HASH_SECRET`. Missing/short = no passes. |
| `AD_PASS_KID` | var | id of the current key (default `k1`, `[A-Za-z0-9_-]{1,16}`) |
| `AD_PASS_SECRET_PREVIOUS` | secret | previous key during rotation (optional) |
| `AD_PASS_PREVIOUS_KID` | var | its kid (optional) |
| `AD_PASS_MODE` | var | `off` / `observe` / `enforce` |
| `AD_PASS_TTL_SECONDS` | var | default 60 |
| `AD_PASS_SINGLE_USE` | var | `on` (default) / `off` |
| `AD_PASS_POLICY_VERSION` | var | default `1` |

```bash
openssl rand -base64 48 | npx wrangler secret put AD_PASS_SECRET
```

Rotation: set `AD_PASS_SECRET_PREVIOUS` = old secret, `AD_PASS_PREVIOUS_KID` = old kid, new
`AD_PASS_SECRET` + new `AD_PASS_KID`; after one TTL (60s) remove the previous pair.

## 8. Threat model

| Attack | Result |
|---|---|
| No / failed / slow admission, `ivt.js` blocked | no pass → no ads |
| Forged or edited pass | signature fails → 403 |
| Expired pass, retired key, policy bump | 403 |
| Pass from site A used on site B or another origin | origin mismatch → 403 |
| Pass harvested by a bot farm and replayed elsewhere | IP prefix / UA binding → 403 |
| Same pass reused | DO claim → 403 (when single use is on) |
| Kill switch or config change after admission | re-checked at redemption → 403 |
| KV/DO outage | deny |
| Config tampering in KV pointing to a foreign script | GPT URL is a server constant; config schema is strict |
| Error-detail probing | every failure is an empty 403 |

**Honest limit.** Once an approved visitor receives the config, the ad unit paths are visible in
the browser. A partner can hard-code GPT with those paths for blocked traffic; JavaScript alone
cannot stop that. Mitigations: per-affiliate ad units (`/net/aff_42/...`) make abuse attributable
and one-click revocable in GAM; `ivt_k` exposes impressions served without our loader (missing or
stale value) in GAM reports; impressions per affiliate should be ≤ passes redeemed × slots. To make
bypass physically impossible, add the edge add-on (Worker strips partner ad tags + CSP).

Also: IP binding means a visitor whose IP prefix changes within the TTL (rare mobile handover)
gets no ads for that pageview.

## 9. Rollout

1. `wrangler secret put AD_PASS_SECRET` (keep `AD_PASS_MODE=off`). Deploy. No behaviour change.
2. Create per-affiliate ad units in GAM; write `adunits:site:<siteKey>` for one site.
3. Set `AD_PASS_MODE=observe`. On that site: remove hard-coded GPT/ad unit IDs, add `ads.js` and
   `data-ad-slot` placeholders. Watch fill, `ivt_e` split and `ivt_k` coverage in GAM.
4. Add the daily GAM report job for missing/stale `ivt_k` (not in this repo yet).
5. Set `AD_PASS_MODE=enforce` once the eligibility policy is trusted. Roll site by site
   (sites without config get no ads, so onboard config before moving a site's tags).
6. Practise the kill switches (`ads:site:*`, `ads:global`).
