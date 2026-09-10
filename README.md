# IVT

Standalone traffic-integrity and admission layer for Thebes properties.

## v1 objective

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
- `wrangler.jsonc` - Worker bindings; production IDs intentionally left as placeholders

## Cloudflare resources required

- Worker: `thebes-ivt`
- D1: `thebes-ivt`
- KV: `IVT_CONFIG`
- Durable Object: `ReplayGuard` for admission/runtime replay and velocity coordination
- Optional/enhanced: Cloudflare Bot Management signals where available

## Security invariants

- `ivt.js` never contains IVT thresholds or authoritative scoring rules.
- `ivt.js` never contains Price Optimiser/GAM knowledge.
- Buyer attribution from Thebes tracking routes is server-owned.
- Raw click IDs should not be exposed in dashboards; store encrypted values only where later reconciliation requires recovery, otherwise keyed hashes.
- Runtime capabilities are short-lived, origin/site-bound, admission-bound, random, and single-use.
- Detailed rejection reason codes remain server-side.

## Status

Foundation scaffold only. Do not treat the current scoring stub as production IVT logic.
