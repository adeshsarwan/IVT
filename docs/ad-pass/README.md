# Ad Pass: how to use it

The Ad Pass blocks ads unless the IVT server has approved the visit.

- `ivt.js` checks the visitor. If the visit is approved, the server hands out a short-lived signed **Ad Pass**.
- The ad script (Price Optimiser, a GPT tag, anything that loads ads) trades the pass for that
  visit's ad config. **No pass → no config → the ad script never starts.**
- Every failure means no ads: blocked visitor, server down or slow, edited or stolen pass, kill switch on, missing config.

Design and threat model: [DESIGN.md](DESIGN.md) · Pending DB work: [DB_CHANGES.md](DB_CHANGES.md)

## The pieces

| Piece | Where | What it does |
|---|---|---|
| `ivt.js` | `src/sdk/ivt.ts` → `/v1/ivt.js` | Existing IVT sensor. Now also passes along `?aff=` and exposes the pass. Knows nothing about ads. |
| `POST /v1/admit` | `src/worker.ts` | Existing admission. Adds `adPass` to the response when ads are allowed. |
| `POST /v1/ad-units` | `src/adpass.ts` | Checks the pass and returns the ad config, or an empty 403. |
| `ad-gate.js` | [`docs/ad-pass/ad-gate.js`](ad-gate.js) | ~50 lines the ad script runs first. Returns the config or `null`. |
| Ad config + kill switches | KV `IVT_CONFIG` | Per-site ad units per affiliate; on/off switches. |

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
| `AD_PASS_SINGLE_USE` | `off` | `on` = each pass works once (uses the ReplayGuard Durable Object) |
| `AD_PASS_KID` / `AD_PASS_POLICY_VERSION` | `k1` / `1` | Key id and policy version. Bumping the policy version invalidates every outstanding pass |

### 2. Ad config for each site (KV)

Key `adunits:site:<siteKey>`, for example `adunits:site:gamewhame.com`:

```json
{
  "v": 2,
  "networkCode": "1234567",
  "affiliates": {
    "42": { "slots": [{ "div": "top", "path": "/1234567/aff_42/top", "sizes": [[300, 250]] }] },
    "77": { "slots": [{ "div": "top", "path": "/1234567/aff_77/top", "sizes": [[300, 250]] }],
            "targeting": { "camp": "spring" } }
  },
  "house": { "slots": [{ "div": "top", "path": "/1234567/house/top", "sizes": [[300, 250]] }] }
}
```

```bash
npx wrangler kv key put --binding IVT_CONFIG "adunits:site:gamewhame.com" --path ./gamewhame.json --remote
```

- Give each affiliate its own ad units in GAM, so any abuse can be traced to one affiliate.
- `house` is optional. It covers visits that arrive without `?aff=`. Leave it out and those visits get no ads.
- A broken or missing config means no ads for that site. There is no fallback.

### 3. The page

```html
<script src="https://ivt.thebesads.com/v1/ivt.js" data-auto-init="true"
        data-endpoint="https://ivt.thebesads.com" data-site-key="gamewhame.com"></script>
<script src="https://<price-optimiser-script>.js" async></script>
```

- Affiliate links carry `?aff=<id>`, e.g. `https://gamewhame.com/word-sprint?aff=42`.
  `ivt.js` remembers the id for the rest of the visit in that tab.
- Keep ad unit IDs out of the page HTML. They come only from the server.

### 4. The ad script (Price Optimiser or any other)

Paste [`ad-gate.js`](ad-gate.js) at the top of the ad script, then:

```js
const config = await thebesAdGate();        // { endpoint, timeoutMs } optional
if (!config) return;                        // stop: no GPT, no bids, nothing
startAds(config);                           // only now load GPT / run the auction
```

`config` looks like this:

```json
{
  "gpt": "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
  "networkCode": "1234567",
  "slots": [{ "div": "top", "path": "/1234567/aff_42/top", "sizes": [[300, 250]] }],
  "targeting": { "camp": "spring", "aff": "42", "ivt_k": "21984a12d2", "ivt_t": "ca859808fdda", "ivt_e": "1" }
}
```

- Set **every** key-value in `targeting` on GPT (and pass it to bidders):
  - `aff`: the affiliate, or `house` for visits without one
  - `ivt_k`: changes daily; used to spot ads loaded without the gate
  - `ivt_t`: identifies this visit's pass
  - `ivt_e`: `1` = clean visit, `0` = would have been blocked (only seen in observe mode)
- **Long visits:** run `thebesAdGate()` again before adding new slots (infinite scroll, page
  changes without a reload), or every few minutes before refreshing. If it returns `null`, stop
  refreshing. This is how a kill switch reaches pages that are already open.
- The gate waits up to 8 s by default (`timeoutMs`). On timeout it returns `null`; never load ads anyway.

`thebesAdGate()` returns `null` when:

| Situation | Calls `/v1/ad-units`? |
|---|---|
| `ivt.js` missing, failed or too slow | no |
| Visit not approved, so no pass | no |
| Server refused (bad, expired or stolen pass, kill switch, config) | yes, got 403 |
| Server unreachable or too slow | yes, failed |

## Running it

**Kill switches** are checked on every call. A missing key or `on` means allowed; anything else means off. They take effect within seconds to a minute.

```bash
npx wrangler kv key put --binding IVT_CONFIG "ads:global" off --remote              # all ads
npx wrangler kv key put --binding IVT_CONFIG "ads:site:gamewhame.com" off --remote  # one site
npx wrangler kv key put --binding IVT_CONFIG "ads:aff:42" off --remote              # one affiliate
npx wrangler kv key delete --binding IVT_CONFIG "ads:aff:42" --remote               # back on
```

**Rollout**

1. Set the secret, keep `AD_PASS_MODE=off`, deploy. Nothing changes.
2. Write the ad config for one site and add `?aff=` to that site's affiliate links.
3. Make the ad script start through `ad-gate.js`. Set `AD_PASS_MODE=observe` and compare GAM
   numbers (`ivt_e`, `ivt_k` coverage) for a few days.
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

## Testing

```bash
npm run check
npm test
npm run build:demo
```

- `npm run check` type-checks the code; `npm test` runs the unit tests (all offline).
- `npm run build:demo` builds the interactive demo at `.wrangler/demo/ad-pass-demo.html`.
- The demo runs the real Worker, `ivt.js` and `ad-gate.js` in your browser.
- Open it over `http://*.localhost` or HTTPS; it doesn't work from a `file://` path.
