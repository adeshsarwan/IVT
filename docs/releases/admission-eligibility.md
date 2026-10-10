# Generic admission eligibility release

## Pre-change inspection (2026-10-10)

- Successful admission has no Worker response interface; its JSON is `{status:"ADMITTED", runtime:string, telemetryToken:string, expiresIn:number}`. SDK Admission has status plus optional runtime/token/expiry; IVTResult has admitted and optional stopTelemetry.
- RiskClass is CLEAN, OBSERVE, SUSPICIOUS, HIGH_RISK, PROBABLE_IVT at score thresholds 0, 20, 40, 60, 80. Decisions are currently string-returning functions: shadow WOULD_PASS, WOULD_OBSERVE, WOULD_CHALLENGE, WOULD_BLOCK; enforcement PASS, OBSERVE, CHALLENGE, BLOCK.
- Site mode overrides IVT_MODE; shadow admits all classes. Only enforcement BLOCK suppresses runtime. Wrangler specifies IVT_MODE=shadow and IPINFO_MODE=observe.
- Admission sums browser, source, identity, behavior and network components, capped at 100. Initial behavior and observe-only network risk are zero. IPinfo is persisted separately. Telemetry may later update behavior, classification and decision; admission is a point-in-time result.
- Telemetry token: HMAC-SHA256 over telemetry-prefixed base64url JSON with sid, origin, millisecond exp, v=1. TTL defaults to 7200s (clamped 300–14400). No eligibility claim is signed into this token.
- Runtime: 64 hex random capability, stored hashed in D1 and registered in ReplayGuard, origin-bound, expiring, single-use. Default TTL 60s (clamped 15–300). Runtime dispatches the existing thebes:ivt-admitted event; it does not mean clean/pass.
- D1 sites contains id, unique site_key, unique hostname, enabled, mode, created_at. There is no arbitrary metadata column. Origin must exactly match ALLOWED_ORIGINS; site hostname then matches normalized Origin (www stripped), with a page-host check when parseable. OPTIONS also requires an allowed origin. Runtime supports allowed Origin or Referer.
- Registration is already data-driven: D1 row plus Wrangler origin allowlist. Smallest onboarding path is a reviewed per-site SQL file and additive origin configuration; no schema or routing redesign required. A future consolidated origin table can be considered separately if config deployments become a bottleneck.

## Intended contract and security assessment

Use the explicitly permitted minimum-signal alternative: add only `monetization: {eligible:boolean}` to admitted responses. Keep classification and decision internal because exposing five risk tiers and decision tiers offers unnecessary tuning feedback. The pure central policy returns true only for CLEAN AND WOULD_PASS; every other pair, including enforcement PASS, is false. Existing scoring, thresholds, modes and persistence stay unchanged.

SDK adds required `monetizationEligible:boolean` to its initialization result, defaulting false for old responses, rejection or missing/malformed eligibility. Existing admitted and stopTelemetry behavior stays intact. Runtime/telemetry continue for admitted but ineligible sessions.

This is an authoritative engine-computed admission snapshot, not a tamper-proof browser credential or a continuously updated verdict. Consumers must require literal true; admitted, the runtime event and the telemetry token do not establish eligibility. No scores, reasons, provider details, identifiers or secrets are added to browser output.

## Pre-deployment review

Files in this release:
- `src/eligibility.ts`: pure generic eligibility policy.
- `src/worker.ts`: additive response field derived from the already persisted result.
- `src/sdk/ivt.ts`: explicit eligibility result, literal-true check, legacy response fallback.
- `wrangler.jsonc`: append https://jobsqualified.com and https://www.jobsqualified.com; keep both GameWhame origins and all other configuration.
- `config/sites/jobsqualified.sql`: insert site_key=jobsqualified.com, hostname=jobsqualified.com, enabled=1, mode=shadow using the production hostname-as-key convention.
- `tests/admission.test.ts`, `tests/sdk.test.ts`, `package.json`: expanded complete test suite, including built SDK verification.
- `scripts/verify-admission.mjs`: controlled production admissions/runtime/telemetry verification, with sensitive tokens omitted from output.
- `docs/releases/admission-eligibility.md`: inspection, review and release procedure.

Before:
```json
{"status":"ADMITTED","runtime":"/v1/runtime/...","telemetryToken":"...","expiresIn":60}
```
After:
```json
{"status":"ADMITTED","monetization":{"eligible":true},"runtime":"/v1/runtime/...","telemetryToken":"...","expiresIn":60}
```

| Existing classification / decision | Eligible |
| --- | --- |
| CLEAN / WOULD_PASS | true |
| OBSERVE / WOULD_OBSERVE | false |
| SUSPICIOUS / WOULD_CHALLENGE | false |
| HIGH_RISK or PROBABLE_IVT / WOULD_BLOCK | false |
| Any other pair | false |

Validation: `npm run check`, `npm test` (55 passing tests). Five full admission cases assert persisted scores 0/20/45/60/100 and unchanged classification/decision, ADMITTED status, response key allowlist, runtime URL/expiry, token claims, runtime execution and replay rejection. Both GameWhame and JobsQualified origins are covered. Built SDK tests cover true, false, legacy, missing, null and malformed eligibility, rejection, duplicate initialization, runtime loading and stopTelemetry. Existing IPinfo tests compare off/observe admissions and prove equal scores, classification, decisions and response (apart from random tokens/capabilities).

Compatibility: only two Worker lines change (policy import and response). Scoring, identity, network, runtime, telemetry, signing and validation code are unchanged. Existing fields retain their types and meaning. The SDK keeps admitted/stopTelemetry and document-level deduplication. No Price Optimiser integration or publisher decision logic is added. public/v1/ivt.js is generated by the existing build, not tracked; unrelated pre-existing untracked files stay uncommitted.

Live pre-deployment observations: D1 has only GameWhame (id=1, site_key=gamewhame.com, hostname=gamewhame.com, enabled=1, mode=shadow). Active version is c970c373-0a67-4f42-9ecc-6df680755211; version bindings confirm IVT_MODE=shadow and IPINFO_MODE=observe. Public responses have a pre-existing wildcard CORS header and duplicated allow-methods headers, differing from Worker-generated headers. The cause is not established; this release does not alter it. Admission still rejects an unregistered origin with 403. SDK requests omit credentials, so wildcard CORS supports the existing request flow.

## Rollback

Restore the recorded prior Worker version (including its assets/config):
```sh
bash scripts/cf.sh rollback c970c373-0a67-4f42-9ecc-6df680755211 --message 'Rollback generic admission eligibility'
```
Disable only the new registration if needed (retain session history):
```sh
bash scripts/cf.sh d1 execute thebes-ivt --remote --command "UPDATE sites SET enabled=0 WHERE site_key='jobsqualified.com' AND hostname='jobsqualified.com'"
```
No schema migration or historical session rewrite is involved. Revert the release commit before a future source-based deployment. The old Worker and SDK do not expose eligibility; consumers must treat its absence as false. Do not delete existing site or telemetry data.

## Downstream contract

Require `response.status === "ADMITTED" && response.monetization?.eligible === true`, or `result.admitted && result.monetizationEligible === true` from initIVT. Never infer eligibility from status, runtime loading or the admitted event. Missing/false eligibility must not authorize monetization. This release provides an admission-time client signal, not server-verifiable monetization authorization; the existing telemetry token is solely for IVT telemetry. Classification/decision remain internal by deliberate minimum-disclosure choice.


## Completed release and production evidence

Released 2026-10-10 (Asia/Kolkata). Implementation commit: `741c5ee106555892480b5e4ea66de20681993c9b`, pushed to `feature/ivt-v1-shadow`. Exactly one Worker release deployed: `010df5d6-50df-4a85-bfee-ad837fcc7b24`. The subsequent report-only commit does not require a deployment.

Registration applied successfully: JobsQualified id=2, site_key=jobsqualified.com, hostname=jobsqualified.com, enabled=1, mode=shadow. Existing GameWhame id=1 and all registration fields remain unchanged. New version inspection confirms IVT_MODE=shadow and IPINFO_MODE=observe. The served `/v1/ivt.js` is byte-for-byte identical to the tested local build.

Controlled live requests (synthetic test sessions, not publisher traffic measurements):

| Phase | Origin | Input | Persisted score / class / decision | Eligible |
| --- | --- | --- | --- | --- |
| Before | https://gamewhame.com | normal | 0 / CLEAN / WOULD_PASS | absent (old contract) |
| Before | https://www.gamewhame.com | normal | 0 / CLEAN / WOULD_PASS | absent (old contract) |
| Before | https://gamewhame.com | webdriver | 45 / SUSPICIOUS / WOULD_CHALLENGE | absent (old contract) |
| After | https://gamewhame.com | normal | 0 / CLEAN / WOULD_PASS | true |
| After | https://www.gamewhame.com | normal | 0 / CLEAN / WOULD_PASS | true |
| After | https://gamewhame.com | webdriver | 45 / SUSPICIOUS / WOULD_CHALLENGE | false |
| After | https://jobsqualified.com | normal | 0 / CLEAN / WOULD_PASS | true |
| After | https://www.jobsqualified.com | normal | 0 / CLEAN / WOULD_PASS | true |
| After | https://jobsqualified.com | webdriver | 45 / SUSPICIOUS / WOULD_CHALLENGE | false |

Every row returned admission HTTP 200 / ADMITTED, runtime HTTP 200, replay HTTP 404 and telemetry HTTP 200. Every persisted row has mode=shadow, network_risk=0 and ipinfo_lookup_status=hit. Automated comparison confirms old response fields and behavior match across GameWhame before/after cases after excluding random session/capability/token values and the additive monetization field. Both releases reject the unregistered test origin with HTTP 403. Public wildcard CORS behavior is unchanged.

Local audit evidence (untracked, no bearer tokens or IPs): `.wrangler/eligibility-before.json`, `.wrangler/eligibility-after.json`, `.wrangler/eligibility-database-evidence.json`, `.wrangler/eligibility-tests.log`. Live test session IDs in these files allow D1 cross-checks. No Price Optimiser changes were made.
