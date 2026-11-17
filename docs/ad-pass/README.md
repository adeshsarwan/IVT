# Ad Pass: how to use it

The Ad Pass blocks ads unless the IVT server has approved the visit.

- `ivt.js` checks the visitor. If the visit is approved, the server hands out a short-lived signed **Ad Pass**.
- The ad script (Price Optimiser, or any script that loads ads) asks the server to confirm the pass
  before it does anything. **No confirmation → the ad script never starts.**
- Every failure means no ads: blocked visitor, server down or slow, edited or stolen pass, kill switch on.

The server does **not** manage ad units. Ad units, slots, sizes and floors live in the ad script.
The server only answers "ads allowed for this visit?" and adds a few key-values for GAM reporting.

Design and threat model: [DESIGN.md](DESIGN.md) · Pending DB work: [DB_CHANGES.md](DB_CHANGES.md)

## The pieces

| Piece | Where | What it does |
|---|---|---|
| `ivt.js` | `src/sdk/ivt.ts` → `/v1/ivt.js` | Existing IVT sensor. Now also passes along `?aff=` and exposes the pass. Knows nothing about ads. |
| `POST /v1/admit` | `src/worker.ts` | Existing admission. Adds `adPass` to the response when ads are allowed. |
| `POST /v1/ad-check` | `src/adpass.ts` | Confirms the pass: returns `{ ok: true, targeting }`, or an empty 403. |
| `ad-gate.js` | [`docs/ad-pass/ad-gate.js`](ad-gate.js) | ~50 lines the ad script runs first. Returns the approval or `null`. |
| Kill switches | KV `IVT_CONFIG` | Turn ads off for everything, one site, or one affiliate. |

## Setup

### 1. Server (once)

```bash
openssl rand -base64 48 | npx wrangler secret put AD_PASS_SECRET
```

Vars in `wrangler.jsonc`:

| Var | Default | Meaning |
|---|---|---|
| `AD_PASS_MODE` | `off` | `off` = no passes at all · `observe` = every admitted visitor gets ads, bots tagged `ivt_e=0` · `enforce` = only approved visits get ads |
| `AD_PASS_TTL_SECONDS` | `1800` | Pass lifetime (30 min), allowed range 15–3600 |
| `AD_PASS_REQUIRE_AFFILIATE` | `off` | `on` = visits without `?aff=` get no ads |
| `AD_PASS_SINGLE_USE` | `off` | `on` = each pass works once (uses the ReplayGuard Durable Object) |
| `AD_PASS_KID` / `AD_PASS_POLICY_VERSION` | `k1` / `1` | Key id and policy version. Bumping the policy version invalidates every outstanding pass |

Nothing else needs to be set up on the server: no ad config and no database tables.

### 2. The page

```html
<script src="https://ivt.thebesads.com/v1/ivt.js" data-auto-init="true"
        data-endpoint="https://ivt.thebesads.com" data-site-key="gamewhame.com"></script>
<script src="https://<price-optimiser-script>.js" async></script>
```

- The site must be registered in `sites` and listed in `ALLOWED_ORIGINS` (as today).
- Affiliate links carry `?aff=<id>`, e.g. `https://gamewhame.com/word-sprint?aff=42`.
  - `ivt.js` remembers the id for the rest of the visit in that tab.
  - The server signs it into the pass, so it can't be changed later.
  - Any well-formed id (`A–Z a–z 0–9 _ -`, up to 32 characters) is accepted.
  - A malformed id means no ads.
  - No id gives `aff=none`, unless `AD_PASS_REQUIRE_AFFILIATE=on`.

### 3. The ad script (Price Optimiser or any other)

Paste [`ad-gate.js`](ad-gate.js) at the top of the ad script, then:

```js
const approval = await thebesAdGate();      // { endpoint, timeoutMs } optional
if (!approval) return;                      // stop: no GPT, no bids, nothing
startAds(approval.targeting);               // your own ad units, slots and floors, plus these key-values
```

`approval` looks like this:

```json
{
  "ok": true,
  "expiresAt": 1763352000,
  "targeting": { "aff": "42", "ivt_k": "21984a12d2", "ivt_t": "ca859808fdda", "ivt_e": "1" }
}
```

- Set **every** key-value in `targeting` on GPT (and pass it to bidders):
  - `aff`: the affiliate from `?aff=`, or `none`
  - `ivt_k`: changes daily; used to spot ads loaded without the gate
  - `ivt_t`: identifies this visit's pass
  - `ivt_e`: `1` = clean visit, `0` = would have been blocked (only seen in observe mode)
- **Pick ad units however you like** (per site, per affiliate, using `approval.targeting.aff`).
  Using separate GAM ad units per affiliate makes abuse traceable and easy to cut off.
- **Long visits:** run `thebesAdGate()` again before adding new slots (infinite scroll, page
  changes without a reload), or every few minutes before refreshing. If it returns `null`, stop
  refreshing. This is how a kill switch reaches pages that are already open.
  `expiresAt` (unix seconds) is when the pass runs out.
- The gate waits up to 8 s by default (`timeoutMs`). On timeout it returns `null`; never load ads anyway.

`thebesAdGate()` returns `null` when:

| Situation | Calls `/v1/ad-check`? |
|---|---|
| `ivt.js` missing, failed or too slow | no |
| Visit not approved, so no pass | no |
| Server refused (bad, expired or stolen pass, kill switch) | yes, got 403 |
| Server unreachable or too slow | yes, failed |

## Which sites may show ads

Three layers decide it. The first two already existed in the IVT; the KV kill switches are new with the Ad Pass.

| Layer | Where | Existed before? | Checked on | Effect when it says no |
|---|---|---|---|---|
| Domain allowlist | `ALLOWED_ORIGINS` var in `wrangler.jsonc` | yes | `/v1/admit` and `/v1/ad-check` | 403 for anything from that domain |
| Site registry | D1 table `sites` (`site_key`, `hostname`, `enabled`, `mode`) | yes | `/v1/admit` only | visit refused, so no pass and no ads (IVT stops too) |
| Ad kill switches | KV `IVT_CONFIG`: `ads:global`, `ads:site:<siteKey>`, `ads:aff:<id>` | **new** | `/v1/admit` and every `/v1/ad-check` | no pass / 403. Only ads stop; IVT keeps running |

### KV kill switch keys

| Key | Turns off ads for | Example |
|---|---|---|
| `ads:global` | every site | `ads:global` = `off` |
| `ads:site:<siteKey>` | one site (the `site_key` from the `sites` table) | `ads:site:gamewhame.com` = `off` |
| `ads:aff:<id>` | one affiliate, on every site | `ads:aff:42` = `off` |

### What each value means

| State of the key | Example | Ads? |
|---|---|---|
| Key not set | (no `ads:site:gamewhame.com` key) | ✅ allowed (the normal state) |
| `on` (any case, spaces trimmed) | `on`, `ON`, ` on ` | ✅ allowed |
| `off` | `off` | ❌ off |
| Any other value | `0`, `false`, `disabled`, `no`, empty string | ❌ off (anything that isn't `on` turns ads off) |
| KV can't be read | Cloudflare KV outage or error | ❌ off (fails closed) |

Several switches can apply to one visit. Ads run only if **every** one that applies allows them:

| `ads:global` | `ads:site:gamewhame.com` | `ads:aff:42` | Visit to gamewhame.com with `?aff=42` | Visit to gamewhame.com, no `?aff=` |
|---|---|---|---|---|
| not set | not set | not set | ✅ ads | ✅ ads |
| `off` | not set | not set | ❌ | ❌ |
| not set | `off` | not set | ❌ | ❌ |
| not set | not set | `off` | ❌ | ✅ ads (no affiliate, so `ads:aff:*` doesn't apply) |
| `on` | `off` | not set | ❌ (the site switch still wins) | ❌ |
| not set | `on` | `off` | ❌ | ✅ ads |

### Samples

Run these from the repo folder. Add `--remote` to act on production KV; without it, wrangler uses a local copy.

```bash
# Turn ads off
npx wrangler kv key put --binding IVT_CONFIG "ads:global" off --remote
npx wrangler kv key put --binding IVT_CONFIG "ads:site:gamewhame.com" off --remote
npx wrangler kv key put --binding IVT_CONFIG "ads:aff:42" off --remote
```

```bash
# Turn ads back on: delete the key (preferred) or set it to "on"
npx wrangler kv key delete --binding IVT_CONFIG "ads:site:gamewhame.com" --remote
npx wrangler kv key put --binding IVT_CONFIG "ads:site:gamewhame.com" on --remote
```

```bash
# See what is set
npx wrangler kv key list --binding IVT_CONFIG --prefix "ads:" --remote
npx wrangler kv key get --binding IVT_CONFIG "ads:site:gamewhame.com" --remote
```

Typical uses:

| Situation | Command |
|---|---|
| GAM flagged gamewhame.com, stop it now | `kv key put ... "ads:site:gamewhame.com" off` |
| Affiliate 42 is sending bot traffic | `kv key put ... "ads:aff:42" off` |
| Something is wrong everywhere | `kv key put ... "ads:global" off` |
| Issue resolved | `kv key delete ...` on the same key |
| Check what is currently switched off | `kv key list ... --prefix "ads:"` |

- Use the exact `site_key` from the `sites` table, e.g. `gamewhame.com`, not `www.gamewhame.com` or a full URL.
- `ads:aff:` uses the same id as `?aff=`.
- Keep a note of who flipped what and why. The audit table for that is proposed in [DB_CHANGES.md](DB_CHANGES.md) §2C.
- **KV errors:** if KV can't be read, ads are off. The design always fails closed.
- **Same KV as before:** these keys live in the existing `IVT_CONFIG` namespace, which so far only cached IPinfo lookups. No new Cloudflare resource is needed.
- **Speed:** a change applies to new visits and to open pages on their next re-check, usually within seconds and at most about a minute (KV propagation).
- **Ads only:** turning a switch off doesn't touch IVT scoring or telemetry.

### Which one to use

| Goal | Do this | How fast |
|---|---|---|
| Stop ads on a site now | `ads:site:<siteKey>` = `off` | seconds to a minute, including open pages |
| Stop one affiliate everywhere | `ads:aff:<id>` = `off` | seconds to a minute |
| Stop all ads (emergency) | `ads:global` = `off` | seconds to a minute |
| Take a site out of the IVT completely | D1 `sites.enabled = 0` **and** `ads:site:<siteKey>` = `off` | new visits right away. Without the KV switch, passes already issued keep working until they expire (up to 30 min), because `/v1/ad-check` does not read D1 |
| Stop a domain calling us at all | remove it from `ALLOWED_ORIGINS` | next deploy |

To add a new site, register it in `sites` and add its domains (with and without `www.`) to
`ALLOWED_ORIGINS`, as before. It needs no KV entry; with no kill switch key set, ads are allowed.

## Running it

**Kill switches** are checked on every call. Commands and examples are in [Samples](#samples) above.

**Rollout**

1. Set the secret, keep `AD_PASS_MODE=off`, deploy. Nothing changes.
2. Add `?aff=` to affiliate links. Make the Price Optimiser script start through `ad-gate.js`.
3. Set `AD_PASS_MODE=observe` and compare GAM numbers (`ivt_e`, `ivt_k` coverage) for a few days.
4. Set `AD_PASS_MODE=enforce`. Move the other sites over one at a time.

**Spotting bypass:** in GAM, report impressions by `aff` and `ivt_k`. Impressions with no `ivt_k`
or an old one come from ads loaded without the gate. Turn on that affiliate's kill switch.

## Limits

- Whoever controls the page HTML can delete the gate from a downloaded copy of the ad script.
  The server never sees that copy, so it can't block it. `ivt_k` reveals it within a day.
- To make it impossible rather than just detectable, serve the sites through our Cloudflare and
  add a Content-Security-Policy that allows only the exact approved ad script. The browser then
  refuses edited copies. Price Optimiser can also check the pass on its own servers. Both are
  covered in [DESIGN.md](DESIGN.md) §8.
- `?aff=` comes from the URL, so it can be typed by anyone. Mislabelled traffic sends revenue
  to the other affiliate's reporting, so there's little reason to fake it. Signed tracking links
  can replace it later.

## Testing

```bash
npm run check
npm test
npm run build:demo
```

- `npm run check` type-checks the code; `npm test` runs the unit tests (all offline).
- `npm run build:demo` builds the interactive demo at `.wrangler/demo/ad-pass-demo.html`.
- The demo runs the real Worker, `ivt.js` and `ad-gate.js` in your browser, with a stand-in for the ad script.
- Open it over `http://*.localhost` or HTTPS; it doesn't work from a `file://` path.
