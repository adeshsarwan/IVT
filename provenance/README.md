# Traffic Provenance (TPS): sampling and reconciliation logic

Checks that an affiliate's traffic **really comes from the paid platform they claim** (Google Ads or Meta Ads), and that the paid traffic itself is clean. The output is a trust tier per affiliate and a plan for the Ad Pass kill switch `ads:aff:<id>`.

- **Pure logic.** No network, no DB, no clock. Plain objects in, a report out. The same input always gives the same report (tested).
- **Isolated.** Lives in `provenance/`. Not imported by `src/worker.ts`. Nothing here writes to KV. It only *plans* the writes.
- Design: `../docs/03-traffic-provenance-architecture.md` (outside the repo), §4 ④ and ⑤. This module is the "Reconciliation & Sampling Engine" plus the breaker part of the "Policy Service".
- How to get the platform data (tokens, access, queries): [`docs/PARTNER_DATA_ACCESS.md`](docs/PARTNER_DATA_ACCESS.md).

| Path | What |
|---|---|
| `src/types.ts` | All input/output shapes (requests, `click_view` rows, Insights rows, report) |
| `src/config.ts` | Every threshold and default (§5 below) |
| `src/normalize.ts` | Our side: parse a logged landing → click IDs, ValueTrack / Meta params, platform claim |
| `src/windows.ts` | Windows: every N requests or T time, per affiliate × source |
| `src/google.ts` | Google: click-level gclid matching plus day ratio, network, placement, device, timing |
| `src/meta.ts` | Meta: aggregate reconciliation vs Insights, Audience Network, fbclid evidence |
| `src/rules.ts` | Wilson-based rule helpers, click-ID reuse index, placement blocklist, hour curve |
| `src/breaker.ts` | Circuit breaker with hysteresis |
| `src/engine.ts` | `runProvenance()`: the whole pipeline plus the KV plan |
| `src/scenarios.ts` | Seeded synthetic fixtures (13 presets) used by the tests and the demo |
| `tests/*.test.ts` | `node:test` suites (`npm run test:provenance`; also part of `npm test`) |
| `demo/index.html` | Self-contained lab page. Open it as a file. Rebuild with `npm run build:provenance-demo` |

```bash
npm run test:provenance
```

```bash
npm run build:provenance-demo && open provenance/demo/index.html
```

---

## 1. Flow

```
logged landings (IVT D1 / Edge Collector)        platform pulls (separate job, partner access)
  id, ts, site, aff, route, URL params,            Google: click_view / ClickStats rows (GclId…)
  ipHash, uaDevice                                 Meta:   Insights rows per ad × day × publisher
            │                                                   │
            ▼                                                   │
 ① normalize  → click IDs, ValueTrack/Meta params,              │
                platform claim, macro check,                    │
                deterministic sample flag, de-dup               │
            ▼                                                   │
 ② windows    → per affiliate × claimed source:                 │
                close every N requests (5k / 10k) or T (24h)    │
            ▼                                                   ▼
 ③ evaluate   → Google: gclid lookup, day ratio, network/placement/device/timing
                Meta:   day ratio vs inline_link_clicks / LPV, AN share, ad-level, fbclid evidence
                both:   no-ID share, malformed/macro IDs, reuse, blocked placements, flat hour curve
            ▼
 ④ verdict    → reasons (each OK/WATCH/THROTTLE/BLOCK, hard?, edge-only?) → window severity + status
            ▼
 ⑤ breaker    → per affiliate × source, hysteresis → tier
            ▼
 ⑥ plan       → affiliate tier = worst source → KV plan (BLOCK = recommend ads:aff:<id> = off; a human applies it)
```

`runProvenance({ requests, platform, now, previous? }, configOverrides)` returns:

- `windows[]`: span, closedBy, status, severity, stats, reasons, freshness, breaker tier after the window.
- `breakers{}`: state per `aff|source`. Feed it back as `previous` next run.
- `affiliates[]`: tier, per-source tiers, access level, KV actions, notes.

`now` is an input (not `Date.now()`), so time-closed windows and freshness are reproducible.

## 2. Our side: what we read from a landing

| Field | Read from | Notes |
|---|---|---|
| Google click IDs | `gclid`, `gbraid`, `wbraid` | `gbraid`/`wbraid` = iOS privacy clicks: not matchable per click |
| Meta click ID | `fbclid` | Evidence only (presence, format, reuse) |
| Google ValueTrack | `campaignid`\|`cid`, `adgroupid`\|`ag`, `creative`\|`cr`, `keyword`\|`kw`, `placement`\|`plc`, `network`\|`net`, `device`\|`dev`, `matchtype`\|`mt` | Short names = our template (doc 03); raw names also accepted |
| Meta dynamic params | `campaign_id`\|`fb_cid`\|`cid`, `adset_id`\|`as`, `ad_id`\|`ad`, `site_source_name`\|`ss`, `placement`\|`plc` | From `{{campaign.id}}`, `{{adset.id}}`, `{{ad.id}}`, `{{site_source_name}}`, `{{placement}}` |
| UTM | `utm_source`, `utm_medium`, `utm_campaign` | Fallback claim only |
| Platform claim | `config.routes[route]` → `?src=` → `utm_source` → click-ID type | **Route is the only claim an affiliate can't forge.** URL claims are attacker-controlled |
| Unexpanded macros | any value like `{gclid}`, `{{ad.id}}`, `%7B…` | Hand-built or broken URLs → counted as invalid IDs |

- Requests with no `id` or an unparseable `ts` are dropped (`totals.invalidDropped`).
- Exact duplicate request ids are dropped; the first one wins by `(ts, id)` (`totals.duplicatesDropped`).
- Different requests that share a click ID are **not** duplicates. That's the reuse signal (§4).
- `aff` missing → `(none)` (house traffic). It's evaluated, but there's no per-affiliate kill switch for it.

## 3. Windows and sampling

- Group by `aff | claimedSource` (`google`, `meta`, `unknown`).
- Walk the group in `(ts, id)` order. Close the window when it reaches **N** requests (`windowSize`, default 5,000; 10,000 is supported), or when the next request is **≥ T** after the window's first request (`windowMaxMs`, default 24h).
- The last window is `closedBy: 'time'` if `now − start ≥ T`. Otherwise it is **OPEN**: shown, but the breaker ignores it.
- **Deterministic sampling.** `inSample = fnv1a(salt + ":" + id) / 2³² < sampleRate`. The same id is always in or always out. The salt is secret, so affiliates can't predict which requests get checked. Default `sampleRate = 1` (check everything; a gclid lookup is cheap). Lower it for expensive per-request checks.
- **Counts and ratios use all requests.** Per-request checks (matching, format, reuse, device, timing, placement) use the sample.

Why N = 5,000: a rate measured on n requests has 95% precision of about ±1.96·√(p(1−p)/n). At p = 0.5 that's ±1.4% for 5k and ±1.0% for 10k (asserted in tests). That's enough to tell an 88% match rate from a 95% one.

## 4. Formulas

All rates carry a **95% Wilson interval** (z = 1.96):

```
p̂ = k/n
centre = (p̂ + z²/2n) / (1 + z²/n)
half   = z·√(p̂(1−p̂)/n + z²/4n²) / (1 + z²/n)
CI     = [centre − half, centre + half]
```

Decisions use the **bound**, not the point estimate, for anything above WATCH. So we THROTTLE or BLOCK only when we are statistically confident the affiliate is that bad. WATCH uses the point estimate (early warning).

### Google (click level)

Each sampled Google-claimed request gets exactly one outcome:

| Outcome | Condition |
|---|---|
| `invalid_click_id` | gclid fails the format check (length 20–512, base64url-ish, not `test`/`null`/macro) or any param has an unexpanded macro |
| `pending` | the landing's **account-local date** > `coveredThrough` (import not complete). Not counted as unmatched |
| `matched` | gclid found in the click rows |
| `unlinked_campaign` | gclid not found, but its `campaignid` isn't in the linked accounts' campaign list (`campaignIds`). Access problem, not proof of forgery |
| `unmatched` | gclid not found, data complete |
| `braid_only` | only `gbraid`/`wbraid`. Covered by the day ratio only |
| `no_click_id` | no Google click ID at all (includes requests with an `fbclid` on a Google route) |

```
match rate          = matched / (matched + unmatched + invalid_click_id)
no-click-ID rate    = no_click_id / sampled
invalid rate        = (invalid gclids + any-param macros) / sampled
reuse rate          = IDs seen from > maxIpsPerClickId IPs or > maxHitsPerClickId hits (whole run) / sampled with an ID
timing anomaly rate = matched with (landing − click) outside tolerance / matched
                      exact ClickTimestamp: −clockSkew (2 min) … +maxClickToLand (1h)
                      else by date: 0 … +dateToleranceDays (1) days, in account time zone
device mismatch     = Google Device (or {device}) ≠ UA device class / pairs with both known
risky network       = AdNetworkType ∈ {SEARCH_PARTNERS, CONTENT} (or {network} ∈ {s, d} if unmatched) / with network known
blocked placement   = placement contains a blocklist term / with placement
unlinked campaign   = unlinked_campaign / (matched + unmatched + unlinked_campaign)
day ratio           = our Google-claimed landings (ALL, not sampled) on complete account days touched by the window
                      ÷ Google clicks (click rows) on those days
```

The day ratio includes no-ID and braid traffic on purpose. Mixed-source top-ups inflate it, and iOS braid clicks are counted on both sides.

### Meta (aggregate only)

Meta has no click-level export, so the unit is the **account-local day**.

```
day ratio      = our Meta-claimed landings on complete days touched ÷ Σ inline_link_clicks on those days
LPV ratio      = same ÷ Σ landing_page_views (only if the pixel reports any)
AN share       = max( Insights audience_network link clicks / all link clicks,
                      our {{site_source_name}} = an (or placement an_…) / with param )
per-ad check   = ours(ad) > link_clicks(ad) × 1.2 + 5  → ad listed as inflated
unknown ad ids = {{ad.id}} not in adIds ∪ Insights ad_ids / with ad id on complete days
fbclid         = missing share, malformed/macro share, reuse share (never looked up)
```

### Shared

- **Flat hour curve:** normalized Shannon entropy of the hour-of-day histogram over the 24h of this affiliate × source ending at the window's last request. Needs ≥ 480 requests and ≥ 23h of span. Humans have a daily curve (entropy ≈ 0.94); 24/7 farms are flat (≈ 1.0).

## 5. Thresholds (defaults in `src/config.ts`)

High-is-bad rules: **WATCH** when the point estimate > watch; **THROTTLE** when the CI *lower* bound > throttle; **BLOCK** when the CI lower bound > block.
Low-is-bad (match rate): **WATCH** when the point < watch; **THROTTLE** when the CI *upper* bound < throttle; **BLOCK** when the CI upper bound < block.

| Metric | WATCH | THROTTLE | BLOCK | Hard (1 window) |
|---|---|---|---|---|
| gclid match rate (low bad) | < 95% | upper < 90% | upper < 75% | upper < 50% |
| no-click-ID share | > 5% | > 15% | > 40% | – |
| invalid / macro click IDs | > 0.5% | > 2% | > 5% | lower > 20% |
| reused click IDs | > 1% | > 3% | > 10% | – |
| timing anomalies | > 2% | > 5% | > 15% | – |
| risky network (Search Partners, Display) | > 10% | > 30% | > 60% | – |
| blocked placement | > 0.1% | > 1% | > 5% | lower > 20% |
| device mismatch | > 10% | > 25% | never | – |
| unlinked campaign (Google) | > 5% | > 20% | never (cap THROTTLE) | – |
| landings ÷ clicks (G and M) | > 1.05× | > 1.2× | > 1.5× | > 2.0× or platform = 0 |
| landings ÷ clicks, low side | < 0.5× (G) / < 0.3× (M) | – | – | – |
| Meta AN share (point) | > 5% | > 20% | > 50% | – |
| Meta unknown ad ids / missing `{{ad.id}}` | > 5% | > 20% | never (cap) | – |
| fbclid missing | > 10% | > 50% | never | – |
| landings ÷ LPV | – | – | – | WATCH only, > 1.2× |
| flat hour curve (entropy) | ≥ 0.985 | – | – | – |

Guards:

- `minWindowRequests` (300): smaller windows get **NO_VERDICT**.
- `minSample` (200): a rate with a smaller denominator is skipped (`insufficient_sample` lists them).
- `minRatioClicks` (100): a ratio is skipped when both sides are below it.

These numbers are **starting points**. Run in shadow mode, look at real distributions per affiliate, then calibrate.

## 6. Window status

| Status | When | Reasons used | Breaker |
|---|---|---|---|
| `VERDICT` | Data complete for (most of) the window | all | applied |
| `PROVISIONAL` | > 50% of click-level samples (Meta: ad-ids / days) are after `coveredThrough` | all, but platform metrics only on mature rows (each still needs `minSample`) | applied |
| `NO_ACCESS` | No platform data, `status: 'no_access'`, or no linked account | edge-only + `no_partner_access` floor | applied |
| `UNKNOWN` | `status: 'error'` (pull failed) | edge-only only | holds; THROTTLE after `unknownGraceMs` (48h) |
| `NO_VERDICT` | < `minWindowRequests` | none (info only) | holds |
| `OPEN` | window not closed yet | shown, not applied | holds |

**Edge-only** reasons need no platform data (IDs on our side, macros, reuse, our placement/network params, no-ID share, hour curve, access). Late or missing platform data never hides a bot farm that's visible from our own logs.

## 7. Every reason code

| Code | Severity | Meaning / what to do |
|---|---|---|
| `low_match_rate` | W/T/B, hard | gclids not in the affiliate's Google clicks: fake or replayed IDs. Ask for an explanation; check `unlinked_campaign` first |
| `no_click_id` | W/T/B, edge | Google-claimed landings without any click ID: mixed sources or crafted URLs |
| `autotagging_off` | THROTTLE, edge | Account has auto-tagging disabled (contract breach): can't verify per click. Replaces `no_click_id` |
| `autotagging_off_suspected` | THROTTLE, edge | < 5% carry IDs although our template params are present |
| `invalid_click_id` | W/T/B, hard, edge | Malformed IDs (`test`, `abc123`) or unexpanded macros (`{gclid}`, `{{ad.id}}`) |
| `reused_click_id` | W/T/B, edge | Same click ID from > 2 IPs or > 5 hits: click laundering / replay |
| `timing_anomaly` | W/T/B | Landing before the click or long after it (replay) |
| `device_mismatch` | W/T | Google says desktop, browser says mobile (or vice versa) |
| `risky_network` | W/T/B, edge | Search Partners / Display share above policy |
| `blocked_placement` | W/T/B, hard, edge | Porn, junk apps (`mobileapp::`) and other blocklisted placements |
| `partial_account_access` | W/T (cap) | gclids from campaigns outside the linked accounts. Get the other account linked |
| `unlinked_accounts` | floor (WATCH) | Some of the affiliate's accounts aren't shared with us |
| `no_partner_access` | floor (THROTTLE), edge | No read access at all. Can't verify (§8) |
| `landings_exceed_clicks` | W/T/B, hard > 2× | More landings than platform clicks: injected traffic |
| `platform_reports_zero_clicks` | BLOCK, hard | Fresh, linked account reports 0 clicks for days we have ≥ 100 landings |
| `clicks_not_landing` | WATCH | Platform clicks ≫ landings: accidental / bot clicks that never load, or slow pages |
| `landings_exceed_lpv` | WATCH | More landings than the Meta pixel's landing_page_views |
| `audience_network_share` | W/T/B (edge if from our params) | Meta AN share above policy (FB/IG feeds & stories only) |
| `unknown_ad_ids` | W/T (cap) | `{{ad.id}}` not in the shared accounts: unshared account or forged params |
| `meta_params_missing` | W/T (cap), edge | Meta-claimed landings without `{{ad.id}}`: URL parameters not set up |
| `fbclid_missing` | W/T, edge | Meta-claimed landings without fbclid. iOS can strip it (verify), so never BLOCK alone |
| `ad_level_inflation` | WATCH | Specific ads with more landings than link clicks |
| `flat_hour_curve` | WATCH, edge | 24/7 flat traffic curve |
| `unattributed_traffic` | WATCH, edge | No platform claim and no click ID at all (`unknown` source window) |
| `ios_braid_share` | info | > 30% braid-only: verified by ratio only |
| `data_not_mature` | info | Window is PROVISIONAL |
| `platform_data_stale` | info | Import older than `maxStaleMs` (36h) |
| `platform_data_unavailable` | info | Pull failed: UNKNOWN |
| `insufficient_sample` | info | Metrics skipped for small denominators |
| `window_too_small` | info | NO_VERDICT |

(W/T/B = WATCH/THROTTLE/BLOCK depending on the value. **hard** = may BLOCK on a single window. **edge** = applies even without platform data.)

## 8. Tiers, breaker and the kill switch

> **Blocking is manual for now.** The engine never writes KV. With the default `enforcement.autoBlock: false`, every KV write in the plan is `op: 'suggest'` and BLOCK adds the note "review, then turn the kill switch on by hand".

Window severity = worst applicable reason. The **breaker** keeps a tier per `aff|source`:

- **Up fast.** A window worse than the current tier moves straight to WATCH or THROTTLE. BLOCK needs `blockConfirmWindows` (2) *consecutive* BLOCK windows, unless a reason is **hard**. Until confirmed, it sits at THROTTLE.
- **Down slow.** `recoverWindows` (3) consecutive windows *below* the current tier step it down **one** tier. A window at the current tier resets the count.
- **BLOCK is sticky.** With `manualUnblock: true` (default) it never auto-recovers. After the clean windows it reports `awaitingManualUnblock`; a human calls `manualReset()` (audit it).
- **Data gaps hold.** NO_VERDICT and OPEN hold. UNKNOWN holds for 48h, then THROTTLE. Edge-only evidence still escalates during UNKNOWN.
- **Access floor.** Through the `no_partner_access` / `unlinked_accounts` reasons: no access means at least THROTTLE (`accessFloor.none`); partial means at least WATCH.

Affiliate tier = worst of its sources. KV plan (applied by a separate audited job, shadow first):

| Tier | Plan |
|---|---|
| OK | no change (`ads:aff:<id>` absent or `on`) |
| WATCH | no change; alert and review |
| THROTTLE | keep `ads:aff:<id>` on; **proposed** `adcap:aff:<id> = reduced` (the Worker doesn't read it yet; open question) |
| BLOCK | **Manual (default).** `suggest ads:aff:<id> = off`: flagged for review; a human sets the key by hand. Then the Ad Pass refuses passes and ad units for this affiliate on every site. Set `enforcement.autoBlock: true` to emit a `put` instead (later, once trusted) |
| `(none)` affiliate | no per-affiliate switch; use `ads:site:<siteKey>` manually if needed |

## 9. Edge cases covered (each has a test)

| Case | Handling |
|---|---|
| Zero platform data | Linked + fresh + 0 clicks → `platform_reports_zero_clicks` (hard). Missing / no access → NO_ACCESS, not "0" |
| Late / delayed data | `coveredThrough` per platform; later days are `pending` (never unmatched); window PROVISIONAL; `freshness` reported |
| Stale import | `importedAt` age > 36h → `platform_data_stale` + `freshness.stale` |
| Pull failed | `status: 'error'` → UNKNOWN; breaker holds for 48h grace |
| Partial accounts | `accounts[].linked=false` → `unlinked_accounts`; gclids from unlisted campaigns → `unlinked_campaign` (not unmatched); Meta unknown ad ids capped at THROTTLE |
| Time zone / day boundary | All day logic uses the **ad account's** IANA zone (`Intl.DateTimeFormat`). Ratios only use **complete** days. Click date tolerance is 0…+1 day |
| Small samples | Window < 300 → NO_VERDICT; each rate < 200 → skipped; ratios < 100 clicks → skipped |
| Duplicates | Same request id → dropped. Same click ID on different requests → reuse check |
| iOS gbraid / wbraid | `braid_only`: not unmatched, not "no ID"; ratio covers them; info reason above 30% |
| Auto-tagging off | Known (`autoTaggingEnabled:false`) or suspected → THROTTLE; ratio still enforced |
| Unexpanded macros | `{gclid}`, `{{ad.id}}`, `%7B` → invalid click ID |
| Sources mixed on a route | fbclid on a Google route → `no_click_id`; no-ID traffic inflates the day ratio |
| No affiliate | `(none)`: evaluated, no kill switch |
| Unknown source | Own window → `unattributed_traffic` (WATCH) |
| Determinism | Sorted input, seeded fixtures, `now` as input, hash sampling. Report is byte-identical across runs (tested) |

## 10. Improvements over doc 03

- **Edge-only vs platform reasons.** Late or failed platform data no longer means "no evidence". Our own IDs, reuse, macros, placements and hour curve still count. Doc 03 had UNKNOWN as "never pass or fail".
- **Route is the platform claim.** URL `utm_source` is attacker-controlled. Map `route → platform` in config. Doc 03 implied this but didn't say the URL must not decide.
- **`unlinked_campaign` vs `unmatched`.** Partial access is not treated as forgery.
- **Pending ≠ unmatched.** Explicit `coveredThrough` per import. A click from a day not yet imported is never counted against the affiliate.
- **Day ratio on complete account-local days only.** This avoids false inflation at time-zone boundaries and on partial days.
- **The hour curve looks back 24h.** 5k windows are often shorter than a day.
- **BLOCK needs confirmation or a hard reason, and unblock is manual.** This adds hysteresis that doc 03 only sketched.
- **Auto-tagging off is its own reason (THROTTLE),** not a BLOCK through the no-ID share.
- **`click_view` has no exact click time** (only the date; verify). Timing uses date tolerance unless a `ClickTimestamp` is available, for example from our own `/t/g` parallel-tracking beacon.

## 11. Not in scope (next steps)

- Edge Collector `/t/g` beacon and the landing-without-beacon check (doc 03 ①).
- Real connectors (the API pulls in `docs/PARTNER_DATA_ACCESS.md`), the warehouse, and the job that applies the KV plan.
- Geo consistency (`{loc_physical_ms}` vs IP geo) and Google `invalid_clicks` per campaign. These are easy to add as rules once the data is in.
- A Worker reader for a THROTTLE key (`adcap:aff:<id>`). Today the Ad Pass is on/off only.
