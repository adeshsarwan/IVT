# Thebes IVT v2 — Telemetry + Network Intelligence

## Product objective

Thebes IVT is not a generic bot blocker. Its objective is to maximise collectible advertising revenue from valid users while reducing Google Ad Manager invalid-traffic/clawback exposure. False positives are therefore a first-class cost.

The system must prefer evidence fusion and shadow observation over single-signal blocking.

## Trust boundary

`ivt.js` is an untrusted browser sensor. It never contains monetisation URLs, GAM configuration, Price Optimiser logic, authoritative IVT thresholds, buyer identity, or a client-side PASS decision.

The Cloudflare Worker is authoritative. It owns site validation, server-side HMAC identities, source classification, network enrichment, risk-component scoring, telemetry acceptance, replay/velocity state, and admission/runtime capabilities.

## V2 evidence model

Each session is scored from independent components. Component scores and reasons are persisted separately so historical traffic can be re-scored when policy changes.

### 1. Network / edge

Inputs:
- Cloudflare-observed country, ASN, colo and connecting IP (raw IP is used only in-memory).
- IP intelligence provider output.
- ASN/category heuristics and known-abuse lists.
- IP/session velocity.

Normalized provider fields follow the IPinfo Privacy Detection sample format:
- `hosting`
- `proxy`
- `tor`
- `relay`
- `vpn`
- `service`

The provider abstraction must also support future `residential_proxy`, ASN type, device-count and carrier datasets without changing the browser SDK.

Important policy: VPN, relay or hosting are features, not automatic IVT verdicts. A legitimate human behind a privacy service can still be monetisable.

### 2. Browser authenticity

Inputs:
- webdriver/headless indicators
- UA/browser capability consistency
- platform, language, timezone and screen consistency
- cookie/storage capability
- coarse browser-evidence HMAC

Do not persist a raw invasive fingerprint. The Worker HMACs canonical evidence using `IVT_HASH_SECRET`.

### 3. Identity / replay graph

Inputs:
- click-ID reuse
- browser-evidence reuse across IP/network changes
- excessive IP-to-device or device-to-IP fanout
- repeated admission/runtime capability use
- short-window velocity

Durable Objects are used for hot replay/velocity state; D1 stores auditable outcomes.

### 4. Behavioral telemetry

The SDK records aggregate interaction counters, not raw mouse paths.

Initial metrics:
- page visible time
- page focused time
- active time
- maximum scroll depth
- pointer/touch/key event counts
- visibility/focus transitions
- session heartbeat count
- pagehide/final summary

Publisher/game integrations may emit generic custom events such as `game_start`, `game_end`, `level_start`, `level_end`, but IVT does not know or control monetisation.

Telemetry is authenticated with a server-issued IVT-only telemetry capability. This capability does not unlock monetisation and contains no Price Optimiser/GAM information.

### 5. Source integrity

Inputs:
- Thebes tracking route (future authoritative buyer attribution)
- click-ID presence: gclid/gbraid/wbraid/fbclid/ttclid/ScCid
- referrer/UTM classification
- later reconciliation against connected Google/Meta/TikTok/Snap accounts

UTM/referrer values are reporting evidence only; they never establish authoritative buyer identity.

## Risk components

Persist at least:
- `network_risk`
- `browser_risk`
- `identity_risk`
- `behavior_risk`
- `source_risk`
- `total_risk`

Initial thresholds remain experimental and shadow-only. The long-term model is calibrated from actual monetisation quality and downstream adjustment/clawback outcomes.

## Decision states

- `WOULD_PASS`
- `WOULD_OBSERVE`
- `WOULD_CHALLENGE`
- `WOULD_BLOCK`

During shadow mode every protocol-valid session continues to receive the opaque runtime capability, including sessions that would otherwise be blocked. This prevents revenue loss while calibrating false positives.

Enforcement later maps to `PASS`, `OBSERVE`, `CHALLENGE`, and `BLOCK_MONETISATION`. Blocking monetisation does not require blocking access to the website/game.

## Network intelligence provider architecture

The Worker calls a provider abstraction only when needed:

1. Extract connecting IP at the Worker.
2. Compute HMAC(IP) immediately.
3. Look up `net:<ip_hmac>` in KV.
4. If fresh, reuse cached normalized intelligence.
5. If absent/stale and a provider is configured, call provider using the raw IP in-memory.
6. Normalize response to the common schema.
7. Cache normalized result in KV with provider timestamp/version.
8. Persist only normalized flags + IP HMAC in D1; do not persist raw IP by default.

This design allows IPinfo API initially and later a downloadable-database/range lookup service without changing the IVT scoring API.

Suggested cache TTLs:
- clean residential/ISP: 24h
- hosting/VPN/proxy: 6–24h
- Tor: 1–6h
- provider errors: 5–15m negative cache

Provider failures must fail open in shadow mode and normally fail soft in enforcement. `UNKNOWN_NETWORK` is a risk feature, not an automatic block.

## IPinfo fit

The supplied sample contains `network`, `hosting`, `proxy`, `tor`, `relay`, `vpn`, `service` and mixes single IPs with CIDRs. IPinfo also offers the same privacy data via API and database downloads. V2 therefore treats IPinfo as a replaceable provider rather than coupling Worker code directly to one lookup mode.

For initial traffic, API + KV caching is operationally simplest. At high volume, database downloads can eliminate per-request API calls while keeping the same normalized provider contract.

## Revenue-safe policy

Strong single signals may trigger high risk, but most decisions require multiple independent signals. Examples:
- VPN alone: weak/moderate network risk only.
- hosting alone: moderate risk, normally observe/challenge.
- webdriver + missing browser APIs + hosting + high velocity: high confidence.
- confirmed click replay or one-time capability replay: high confidence.

The system should measure false-positive cost and clawback reduction together. Buyer success is ultimately judged on risk-adjusted ROI, not on lowest IVT percentage alone.
