# IVT

Standalone traffic-integrity and admission layer for Thebes properties.

## Developer handoff

**Start with [docs/DEVELOPER_HANDOFF.md](docs/DEVELOPER_HANDOFF.md).** It covers verified hosting, IPinfo and Cloudflare, current limitations, the requested IVT-to-Price-Optimiser flow, a proposed per-domain script table, and open GCLID reconciliation decisions.

The implementation baseline is `feature/ivt-v1-shadow` (`f85f599`); the handoff is on `codex/developer-handoff`, based on that branch. At the 12 November 2026 inspection, `main` was older. Continue development from the implementation baseline.

## Current objective

GameWhame is the first shadow-mode integration. The browser SDK (`ivt.js`) is an untrusted sensor/loader. It never knows about Price Optimiser, GAM, ad units, or monetisation URLs. The Cloudflare Worker is the authority that classifies traffic and, after admission, returns a short-lived opaque runtime capability.

## Trust model

Assume an attacker can read, modify, replay, or replace `ivt.js`. No client-provided source, buyer ID, risk score, or PASS decision is trusted. Server-side Cloudflare request signals, campaign/tracking mappings, replay state, and persisted session history are authoritative.

## Initial flow

1. Browser loads `ivt.js`.
2. SDK creates a cryptographically-random nonce and collects coarse browser evidence.
3. SDK POSTs evidence to `/v1/admit`.
4. Worker enriches with Cloudflare edge signals and persists an IVT session.
5. Worker returns a coarse decision and, for admitted sessions, an opaque short-lived runtime capability.
6. SDK loads only that opaque runtime URL. It does not know what monetisation code lies behind it.
7. Shadow mode records `would_pass`, `would_observe`, `would_challenge`, or `would_block` without suppressing legitimate monetisation during calibration.

## Repository layout

- `src/sdk/ivt.ts` - browser sensor/loader
- `src/worker.ts` - Cloudflare Worker API
- `migrations/0001_initial.sql` - D1 schema
- `wrangler.jsonc` - Worker bindings; real deployment resource IDs and bindings

## Cloudflare resources required

- Worker: `thebes-ivt`
- D1: `thebes-ivt`
- KV: `IVT_CONFIG`
- Durable Object: `ReplayGuard` for expiring, origin-bound runtime capability consumption; it does not enforce admission nonce replay or velocity
- Optional/enhanced: Cloudflare Bot Management signals where available

## IPinfo observe-only enrichment

The Worker can enrich admissions with IPinfo when `IPINFO_MODE=observe` and the
`IPINFO_TOKEN` Worker secret is configured. The code default is `off`. IPinfo calls
are server-side only, use the existing `IVT_CONFIG` KV cache, and persist normalized
evidence separately from Cloudflare country/ASN values. This release does not use
IPinfo evidence in risk scores, classifications, or admission decisions.

## Security invariants

- `ivt.js` never contains IVT thresholds or authoritative scoring rules.
- `ivt.js` never contains Price Optimiser/GAM knowledge.
- Buyer attribution must be server-owned; tracking-route resolution is not implemented yet.
- Raw click IDs should not be exposed in dashboards; store encrypted values only where later reconciliation requires recovery, otherwise keyed hashes.
- Runtime capabilities are short-lived, origin/site-bound, admission-bound, random, and single-use.
- Detailed rejection reason codes remain server-side.

## Status

Production was checked on 12 November 2026: shadow mode, enabled GameWhame and JobsQualified registrations, latest listed Worker version `010df5d6-50df-4a85-bfee-ad837fcc7b24`. Publisher adoption must be verified separately.

The current runtime only emits `thebes:ivt-admitted`; it does **not** load Price Optimiser. Admission and that event do not authorize ads. Eligibility currently requires `CLEAN` plus `WOULD_PASS`. Platform click verification, authoritative buyer assignment, source-policy blocking and revenue reconciliation are not implemented.

## Requested next implementation

IVT should authorize monetization and hand eligible traffic to the domain's approved Price Optimiser runtime, selected server-side from a fresh D1 configuration table. Price Optimiser retains responsibility for placements and the ad lifecycle. Its server-side authorization contract remains to be agreed.

Daily reconciliation should compare received click IDs against platform records and apply suspicious campaign/route decisions the following day. Do not wait for each current-day click to appear in Google Ads. See the handoff for the agreed direction, proposed schema, source restrictions and unresolved thresholds. These features are planned, not deployed.

## Hosting and development

The API and SDK are served by Cloudflare Workers at `https://ivt.thebesads.com`; `public/v1/ivt.js` is generated with esbuild and served through Workers Static Assets. IPinfo calls use `https://api.ipinfo.io/lookup/{IP}` with a Worker-side bearer secret.

```sh
npm install
npm run check
npm test
npm run build
```

Prepare isolated development bindings before running `npm run dev`: checked-in D1 and KV bindings use `remote: true` with production IDs. No lockfile is tracked at this baseline. Never commit secrets, `.wrangler`, `node_modules` or production exports. Configure `IVT_HASH_SECRET` and `IPINFO_TOKEN` as Worker secrets. The maintainer's untracked Keychain helper is not required by a fresh clone; authenticate Wrangler through approved account access.

For deployment, rollback, code navigation and acceptance criteria, use the [developer handoff](docs/DEVELOPER_HANDOFF.md).
