# IVT developer handoff

Prepared 12 November 2026 (Asia/Kolkata). This document separates deployed behavior from the requested next implementation. This handoff changes documentation only; it does not deploy code, apply migrations, or enable blocking.

## Start here

Repository: https://github.com/adeshsarwan/IVT. The implementation baseline is `feature/ivt-v1-shadow`, commit `f85f5990f013a121753c22b3a6bd53e84521eb51`. This handoff is on `codex/developer-handoff`, based on that implementation. `main` is older (`312804e` at inspection); do not start development from it without incorporating the implementation branch.

The product responsibility is: **IVT decides whether a visit may monetize and, when permitted, hands it to the correct domain's Price Optimiser runtime.** Price Optimiser owns the ad lifecycle, placements, GAM interaction and auctions. The generic browser IVT script remains an untrusted sensor and opaque-runtime loader; the Worker owns the decision and domain configuration.

The next developer should first implement the domain-to-Price-Optimiser handoff, then authoritative traffic attribution and daily reconciliation. GCLID matching is an additional control under design, not an existing guarantee.

## Verified hosting and services

Read-only production checks on 12 November 2026 found `/health` reporting `shadow`, evidence version `v2`; the latest listed deployment is Worker version `010df5d6-50df-4a85-bfee-ad837fcc7b24` (deployed 10 October 2026). D1 has enabled `gamewhame.com` and `jobsqualified.com`, both in shadow mode. This does not prove every publisher page loads IVT or respects eligibility.

| Component | Current hosting / use |
| --- | --- |
| API and runtime | Cloudflare Worker `thebes-ivt`, TypeScript entry `src/worker.ts`, custom domain `https://ivt.thebesads.com`; `workers.dev` disabled |
| Browser script | `https://ivt.thebesads.com/v1/ivt.js`; esbuild generates `public/v1/ivt.js`; Cloudflare Workers Static Assets serves `public/` |
| Routing | Worker handles `/v1/admit`, `/v1/runtime/*`, `/v2/telemetry`, `/health` before static assets |
| Database | Cloudflare D1 `thebes-ivt`, binding `DB`; migrations in `migrations/` |
| Cache | Workers KV binding `IVT_CONFIG`; currently caches IPinfo evidence, not campaign decisions or PO configuration |
| Runtime replay | SQLite-backed Durable Object `ReplayGuard`, binding `REPLAY_GUARD`; registers and consumes origin-bound, expiring runtime capabilities |
| Request evidence | `CF-Connecting-IP`, Cloudflare country, colo, ASN; optional `cf.botManagement.score`, verified-bot status and JA4 when supplied |
| Secrets | Worker secrets `IVT_HASH_SECRET` and `IPINFO_TOKEN`; never put values in Git or the browser |
| Scheduler | No Cron Trigger, scheduled handler, Google Ads importer or reconciliation queue exists yet |
| Publisher / PO hosting | Publisher code and actual PO bundles are outside this repository; obtain approved URLs and integration contracts from their owners |

Resource identifiers and bindings are in `wrangler.jsonc`. There is no application VM or standalone database server in this implementation. Do not assume Cloudflare Bot Management entitlement, WAF rules, Turnstile or managed rate limiting: this repository does not provision or verify them. Missing optional bot signals remain unknown.

Current variables: `IVT_MODE=shadow`, runtime TTL 60 seconds, telemetry TTL 7,200 seconds, `IPINFO_MODE=observe`, lookup timeout 1,500 ms, success cache TTL 86,400 seconds, error cache TTL 600 seconds. Origin allowlist contains HTTPS apex and `www` origins for GameWhame and JobsQualified. Site mode in D1 takes precedence over global `IVT_MODE`.

## IPinfo integration

Implementation: `src/network.ts`. The Worker obtains the IP from `CF-Connecting-IP` and calls `GET https://api.ipinfo.io/lookup/{encoded-IP}` with `Authorization: Bearer <IPINFO_TOKEN>`. The provider receives the raw IP for lookup; application persistence and KV keys use an HMAC of the IP. Do not describe this as anonymous processing end to end.

The normalizer supports the current `anonymous`, `as` and `geo` objects and legacy `privacy` fields. It records VPN, proxy, Tor, hosting, relay, residential proxy, privacy, service, ASN, AS name/type and country. Missing fields stay null, not false. Provider coverage depends on the account's plan; the purchased plan and quota need owner confirmation.

KV keys are `ipinfo:v2:<ipHash>`. Successes and failures have separate TTLs. Lookup status, cache status and latency are persisted in `network_evidence`; Cloudflare location/ASN remain separate from IPinfo values. Timeouts, malformed responses and provider failures become unknown/error evidence.

**IPinfo is observe-only: it contributes zero risk and does not block traffic.** Changing that is a separate policy change requiring calibration. Preserve the tests that prove `off` and `observe` produce the same admission decision.

## Current request and monetization behavior

1. `src/sdk/ivt.ts` collects browser evidence, URL attribution and referrer, and sends a random nonce to `POST /v1/admit`. Initialization is deduplicated within one document.
2. The Worker checks registered site, allowed origin and page hostname, hashes identifiers using `IVT_HASH_SECRET`, enriches network evidence, and calculates browser/source/identity risk.
3. It persists the session, component scores, network and identity evidence. Behavioral telemetry starts after admission and can later update classification.
4. In shadow mode, protocol-valid sessions receive a runtime capability even if their risk classification is unfavorable. The response separately includes `monetization.eligible`.
5. The SDK starts signed-token telemetry and loads `/v1/runtime/<opaque-capability>`.
6. **The current runtime only dispatches `thebes:ivt-admitted`. It does not load PO.** Admission, this event and successful runtime loading are not permission to show ads.

`src/eligibility.ts` currently returns true only for `CLEAN` plus `WOULD_PASS`. Even enforcement `CLEAN/PASS` returns false. Do not simply flip `IVT_MODE` to enforce and assume monetization works. Define and test the replacement policy explicitly.

Current telemetry tokens are for IVT telemetry only. They are not monetization credentials. Current eligibility is an admission-time browser-visible result; telemetry changes do not revoke already-loaded scripts or ad requests.

Current source classification trusts click-ID presence enough to label traffic (`gclid`, `gbraid`, `wbraid` => Google; `fbclid` => Meta; `ttclid` => TikTok). Referrer/UTM evidence is untrusted. The SDK collects more attribution than the database retains: full referrer and UTMs are not retained as structured evidence. `tracking_routes` and `media_buyers` tables exist, but admissions do not resolve them or populate buyer/route assignments.

Click IDs are HMACed, and `click_reconciliation` rows are inserted with status `CAPTURED`; no importer completes them. The 12 November database check found 7 Google rows and 1 Meta row, all `CAPTURED`, with no campaign or checked timestamp. These may include test traffic and do not establish misconduct or revenue.

Existing identity checks count same-site click reuse over 24 hours and IP/browser velocity/fanout. They do not distinguish an acquisition from every subsequent page admission. The nonce is hashed but not uniquely enforced; Durable Objects currently protect runtime consumption, not admission nonce replay or velocity calculations. Do not describe these as completed protections.

## Requested next implementation: IVT hands approved traffic to PO

The browser loads IVT first. The Worker evaluates IVT risk, source policy, effective campaign/route policy and domain configuration. Only a monetization-authorized session receives a capability that can bootstrap the approved PO script. A denied session may continue IVT telemetry, but must not initialize PO or make ad requests.

Proposed flow:

```text
Publisher page -> generic ivt.js -> Worker admission
                                     |
                    IVT risk + source + daily policy + domain config
                              /                     \
                       deny monetization       allow monetization
                              |                     |
                       telemetry only       opaque runtime capability
                                                    |
                                  recheck policy/config; consume capability
                                                    |
                                  bootstrap domain's Price Optimiser once
                                                    |
                                  PO manages placements / ad lifecycle
```

Keep scores, rules, buyer mappings and PO configuration selection server-side. The generic SDK should not contain per-site PO URLs or GAM inventory. Browser-loaded PO URLs remain observable; an opaque bootstrap cannot make public JavaScript secret or prevent a determined caller from loading it directly.

For enforceable protection, agree a server-verifiable authorization contract with PO and enforce it at the monetization boundary. Bind authorization to session, site, config/policy version, expiry and intended use. Do not reuse the telemetry token. If PO cannot validate authorization, document the integration as cooperative browser gating, not bypass-proof protection. An Origin or Referer header alone is not authentication against non-browser callers.

Recheck disabled sites/configuration and campaign blocks at capability redemption. Define refresh authorization for long-lived pages so a newly blocked campaign cannot keep requesting ads indefinitely. Avoid duplicate PO execution across script tags, framework remounts and retries. A page-load failure after consuming a capability needs a controlled retry contract, not reuse of a consumed token.

### Proposed fresh D1 table: `site_monetization_configs`

This is a schema proposal, not an applied migration. Use `site_id` as the unique foreign key to `sites`, so the registered hostname determines the configuration. Do not select a script URL from client parameters.

| Proposed field | Purpose |
| --- | --- |
| `site_id` (primary key / foreign key) | One active domain configuration |
| `provider` | Initially `PRICE_OPTIMISER` |
| `script_url` | Approved HTTPS PO bundle URL |
| `enabled` | Default off until integration is verified |
| `config_version` | Audit/version binding for issued capabilities |
| `integrity` (nullable) | Only for immutable bundles with a supported integrity/CORS contract |
| `init_config_json` | Validated, non-secret provider initialization options, if required |
| `updated_at`, `updated_by` | Change ownership and audit metadata |

Keep an append-only config-change audit table as well. Prefer a URL plus validated options over arbitrary JavaScript or HTML in D1. Validate approved script hosts and prevent browser-supplied URL overrides; if a server fetch/proxy is introduced, constrain redirects and destinations too. Missing, malformed or disabled configuration must not fall back to a global monetization script. D1 is the authority; if caching is added, define invalidation and maximum revocation delay.

Before coding the adapter, obtain each domain's actual PO URL, initialization method, required data attributes, lifecycle events, CSP/CORS requirements and server authorization capabilities. This repository has no canonical PO URL to seed. Register domains in `sites` and `ALLOWED_ORIGINS` as well as the new table.

## Traffic-source requirement

Record source evidence for all traffic, while explicitly separating claimed source from verified source. Required evidence includes first landing, parsed referrer host, allowlisted UTM fields, click-ID type/hash, observation timestamp and server-owned route/buyer assignment. Avoid persisting unrestricted full URLs with potentially sensitive query parameters.

Google, Meta and TikTok are the requested allowed acquisition platforms. Other sources, direct and unknown traffic need inspection and no ads unless an explicitly approved exception or verified acquisition-continuity policy applies. This is the requested future policy, not current behavior. A claimed allowed source or the mere presence of an ID is insufficient.

Establish server-owned campaign/route mappings and define how a visit is bound to them. A static tracking route can itself be copied, so route registration proves ownership/configuration, not origin-platform provenance. Buyers must not evade a block by changing UTMs, inventing campaign IDs or creating fresh routes. New route approval and any buyer-level escalation need audited controls.

Preserve acquisition context across legitimate page navigation with a defined first-party session mechanism; otherwise subsequent internal/direct pageviews could be incorrectly denied. Distinguish traffic allowed provisionally under yesterday's policy from traffic whose individual ID has been matched.

## GCLID reconciliation: agreed direction, still to implement

**Do not wait for today's individual click to appear in Google Ads before allowing ads.** The requested model is retrospective: today's traffic runs under the latest completed campaign/route assessment; suspicious traffic discovered in today's reconciliation stops monetization for the affected scope the next day. Immediate IVT protections still apply. This knowingly permits first-day exposure.

Proposed data model:

| Record/table | Responsibility |
| --- | --- |
| Acquisition records / `received_clicks` | First/last seen, ID type + keyed hash/version, site, authoritative route/buyer, acquisition/session association; preserve raw events separately from deduplicated counts |
| `platform_clicks` | Imported customer/account, campaign, ad group, click date, keyed GCLID hash and import-run ID; idempotent unique key scoped by platform/account/date/ID |
| `reconciliation_runs` | Account timezone/date, import coverage, pagination completion, freshness, errors, start/end timestamps and rule version |
| `campaign_daily_assessments` | Distinct received/imported/matched/unmatched IDs, suspicious reuse, coverage, denominators, reasons and assessment status |
| `monetization_policies` | Server-owned scope, allow/block/review state, evidence-run ID, effective timestamp, version and audited override |

Reuse or migrate `click_reconciliation` deliberately; do not introduce two conflicting authorities. Import Google IDs and HMAC them with the same algorithm/key version used on receipt. Raw ID recovery is not needed for bulk hash matching. Plan key rotation before changing `IVT_HASH_SECRET`, which is currently shared with other HMAC operations.

Reconciliation must compare sets, not just counts. Example: 1,000 received IDs and 1,000 Google IDs with no overlap is a failed match despite equal totals. Track received-but-unmatched separately from Google clicks with no observed landing: their causes differ. Report metrics by account, campaign, route, buyer and site where attribution supports that grouping; unmatched IDs cannot identify their true campaign without independent route context.

Deduplicate acquisition visits; refreshes, navigation and later visits are not automatically injected clicks. Track suspicious reuse across unrelated acquisition contexts and across day boundaries. IP/browser signatures are imperfect evidence, not unique person identities. A copied valid ID used once may escape duplicate detection; matching alone never proves visitor legitimacy.

Implementation should fetch each account/date separately using Google Ads `click_view`, paginate fully, retry idempotently and backfill recent dates. The API permits one-day queries with a 90-day lookback. ClickView includes valid and invalid interactions; not every campaign type exposes GCLIDs, and GCLID availability is not equivalent to all campaign clicks. Validate actual campaign coverage. `gbraid` and `wbraid` require separate treatment and must not be counted as missing GCLIDs. See [Google ClickView](https://developers.google.com/google-ads/api/fields/v26/click_view).

Google reporting is delayed and can be adjusted retrospectively. Import completion is not proof that platform reporting is final; define a maturity window and rechecks. An API error, missing account or partial page of results must never become a zero-click fraud verdict. See [Google data freshness](https://support.google.com/google-ads/answer/2544985).

Use the Google Ads account timezone for daily matching; record UTC timestamps and display operational reports in Asia/Kolkata. Define the next-day enforcement cutoff explicitly. Publish decisions atomically only after an eligible completed run. Cron Triggers or a scheduled worker/queue are proposed infrastructure, not currently configured. The browser reads only the effective decision via the Worker and never calls Google Ads directly.

### Open decisions for the owner and developer

- Which Google Ads customer/MCC accounts and campaigns are approved? Obtain API developer token, OAuth access and account permissions through secret management.
- Thresholds and minimum sample sizes for unmatched IDs, unusual reuse and volume discrepancy; calibrate before automatic campaign-wide blocking. No percentage threshold has been approved.
- Reporting maturity, import schedule, timezone cutoff, backfill window and maximum stale-policy grace period. Incomplete data is `UNKNOWN`, not `PASS` or `FAIL`; specify what happens after grace expires.
- First-day policy for new campaigns with no history, and protection against repeated campaign/route creation to reset that history.
- Exact blocking scope and escalation from route/campaign to buyer; who can override/unblock, and what evidence permits recovery. No traffic after a block is not evidence of recovery.
- Definition of an acquisition/session, repeat-visit treatment, cross-device evidence and retention periods.
- Whether GCLIDs should additionally validate campaign ownership, site/destination expectations, acquisition timing and buyer accounting; verify field availability before promising these checks.
- Google privacy identifiers and unsupported campaign types; Meta/TikTok API capabilities and reconciliation equivalents. Do not assume they expose a Google-style per-click ledger.
- Direct/organic and returning-visitor exceptions, if any, to the requested source policy.
- PO's server-side enforcement and per-session impression/revenue reporting. Without that integration, reports can measure admissions and bootstrap loads, not prove revenue attribution.

## Delivery order and acceptance criteria

1. **Domain PO handoff:** additive config migration, audited configuration, server decision, capability redemption and PO adapter. Test correct domain selection, disabled/missing config, denied sessions loading no PO, expiry/replay, cross-site use, duplicate initialization, changed policy and controlled load failure.
2. **Attribution and evidence:** authoritative route mapping plus first-party acquisition continuity; store claimed/verified source separately. Test forged UTMs/click IDs, changed routes, nonallowed sources and legitimate navigation.
3. **Daily reconciliation in observation mode:** importer, complete-run ledger, deduplication, cohort metrics and proposed next-day decisions. Test equal totals with disjoint IDs, timezone/day boundaries, repeated imports, pagination failure, late data, key versions and known limitations.
4. **Enable next-day enforcement:** calibrated thresholds, atomic effective policy, bounded staleness, inspected recovery and PO enforcement. Test that yesterday's failed scope cannot monetize today or evade the block by changing client attribution.
5. **Revenue visibility:** join server session/authorization IDs to PO impressions/revenue, report matched/provisional/unattributed traffic separately and audit every policy/config change.

Keep network enrichment observe-only unless a separately approved policy changes it. Preserve telemetry for denied monetization where protocol/site validation permits it. Do not interpret current shadow runtime issuance as permission to bootstrap PO for every session.

## Build, access and operations

Use a supported Node/npm environment and install the dependencies declared in `package.json`. No lockfile is tracked at this baseline; establish and review one for reproducible development. Commands from the repository root:

```sh
npm install
npm run check
npm test
npm run build
```

`npm test` builds the browser SDK, bundles tests into `.wrangler/test`, then runs Node's test runner. `public/v1/ivt.js` is generated. Do not commit `.wrangler`, credentials, downloaded production data or `node_modules`.

Authenticate Wrangler through the owner's approved Cloudflare access; secrets must be transferred separately. The maintainer's local `scripts/cf.sh` retrieves a token from macOS Keychain and is untracked/not portable. A fresh clone must not depend on that helper.

**Development caveat:** checked-in D1 and KV bindings have `remote: true` and production resource IDs. Prepare an isolated development Wrangler configuration/resources before `npm run dev`; do not assume local development is disconnected from production.

Read-only operations with authorized Wrangler credentials:

```sh
npx wrangler deployments list
npx wrangler d1 migrations list thebes-ivt --remote
curl -fsS https://ivt.thebesads.com/health
```

For a future release, test on isolated bindings, back up D1, review additive migrations, record the active Worker version, apply the reviewed migration, then deploy the tested build (`npm run deploy`). Verify registered origins, eligibility, correct PO selection, blocked traffic, telemetry, replay and secret-free logs. Code rollback uses `wrangler rollback <recorded-version>`; additive schemas must remain compatible, and policy/config changes need their own rollback. The existing release record is [admission-eligibility.md](releases/admission-eligibility.md).

Developer access required: GitHub implementation branch, Cloudflare Worker/D1/KV/Durable Objects and appropriate deploy permissions, securely provisioned Worker secrets, IPinfo account/plan details, publisher code, PO owner/contracts, and Google Ads credentials when reconciliation development begins. No secret values belong in this handoff.

## Code map

- `src/worker.ts`: endpoints, origin/site validation, persistence, risk combination, runtime capabilities and telemetry.
- `src/sdk/ivt.ts`, `src/sdk/telemetry.ts`: untrusted browser evidence, loader and behavioral aggregates.
- `src/eligibility.ts`: current narrow monetization policy.
- `src/identity.ts`: retrospective reuse and velocity signals.
- `src/network.ts`: IPinfo normalization/cache and observe-only risk.
- `migrations/0001_initial.sql` through `0004_ipinfo_observe_telemetry.sql`: existing D1 schema.
- `wrangler.jsonc`: deployment routing, bindings and non-secret variables.
- `tests/`: admission, SDK and network tests; `scripts/verify-admission.mjs` sends synthetic production traffic and is not a passive health check.
- `docs/ARCHITECTURE_V2.md`: earlier design context. For current limitations and this requested development scope, use this handoff where the older design is aspirational.
