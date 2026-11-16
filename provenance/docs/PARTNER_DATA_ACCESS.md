# Pulling Google Ads and Meta Ads data with partner access

How we get the platform data that `provenance/` reconciles against, for each affiliate.

- **Nothing here is built yet.** The logic in `provenance/src` takes this data as plain objects.
- **(verify)** marks details we are not sure match current Google/Meta behaviour. Check the official docs before building. Nothing here was tested against a live API.
- **Secrets are never committed.** See §3.

---

## 1. Google Ads

### 1.1 What we need from each affiliate

| Need | Why |
|---|---|
| Read access to every Google Ads account (customer ID) that sends us traffic | Pull `click_view` (gclids) and campaign settings |
| **Auto-tagging ON** | Without it there's no gclid, so we can't match (`autotagging_off` → THROTTLE) |
| Our **tracking template / final URL suffix** at account level, unchanged | ValueTrack params on every landing, plus an independent parallel-tracking hit |
| Allowed networks only: Search; no Search Partners / Display / PMax unless approved | `risky_network` rule |

### 1.2 Access: two options

**Option A: link the account to our manager (MCC) account. Recommended.**

1. We create a Google Ads **manager account** (MCC) for the provenance service, separate from anything else.
2. In the MCC: *Accounts → + → Link existing account* → enter the affiliate's customer ID → send the request. (API alternative: `CustomerClientLinkService` creates a pending link the client accepts; verify.)
3. The affiliate accepts: *Admin → Access and security → Managers* → accept our request.
4. We record the customer ID in `affiliates.google_customer_ids` and set `accounts[].linked = true`.
- A manager link gives broad (admin-like) access. Contractually limit it to read-only use; the code only reads.

**Option B: user access (read-only).**

1. The affiliate invites our service Google account (a dedicated workspace user, not a person) under *Admin → Access and security → Users* with **Read only** access.
2. The API calls use that user's OAuth refresh token, with no `login-customer-id` (or the affiliate's own manager, if any).
- Narrower access, but one invite per account, and the access is tied to that user.

### 1.3 Developer token

1. Sign in to our MCC → *Admin → API Center* (verify the menu path) → accept the terms → a developer token is issued at **Test account access**.
2. Test access only works with **test accounts**, so it's fine for building the connector against a test MCC.
3. Apply for **Basic access** (verify current tiers: there is also an "Explorer" level in newer docs, and Standard access for higher volume). The application asks for a company website, the use case ("read-only reporting / click reconciliation for accounts linked to our MCC") and sometimes a design doc. Review takes days.
4. Basic access has a daily operations quota (historically 15,000 ops/day; verify). One `click_view` query per account per day is far below that.
5. The token belongs to the MCC. Treat it as a secret.

### 1.4 OAuth client and refresh token

1. Google Cloud console → a **separate GCP project** for provenance → *APIs & Services → Library* → enable **Google Ads API**. Enable **BigQuery Data Transfer API** too if using §1.6.
2. *OAuth consent screen*: Internal (if on Workspace) or External in "Production". External in "Testing" status issues refresh tokens that expire in 7 days (verify).
3. *Credentials → Create OAuth client ID*. Type **Desktop app** (simplest for a one-time consent) or **Web application** with a localhost redirect.
4. Scope: `https://www.googleapis.com/auth/adwords`.
5. Get a refresh token once, as the service user that has MCC access. Use the official client library's OAuth helper (e.g. `generate_user_credentials` in `google-ads-python` examples; verify name) or the OAuth Playground with our own client ID. Sign in, consent, copy the **refresh token**.
6. Every API call needs these headers:
   - `developer-token: <token>`
   - `login-customer-id: <our MCC id, no dashes>` (Option A)
   - `Authorization: Bearer <access token>`, minted from the refresh token, valid ~1h.

### 1.5 The `click_view` query (GAQL)

```sql
SELECT
  click_view.gclid,
  customer.id,
  campaign.id,
  ad_group.id,
  segments.date,
  segments.device,
  segments.click_type,
  segments.ad_network_type,
  click_view.keyword,
  click_view.area_of_interest.most_specific,
  click_view.location_of_presence.most_specific
FROM click_view
WHERE segments.date = '2026-11-10'
```

- Endpoint: `POST https://googleads.googleapis.com/vNN/customers/<customer_id>/googleAds:searchStream` with `{"query": "..."}`. Use the current API version (verify NN).
- **One day per query.** `click_view` requires a single-day `segments.date` filter (verify). Loop over days.
- **Lookback: about 90 days** (verify).
- `segments.date` is in the **account time zone**. Store `customer.time_zone` and pass it as `timeZone`.
- There is no exact click timestamp in `click_view` (verify). The logic uses date tolerance. Exact times come from our own parallel-tracking hit (§1.7).
- Some campaign types / networks may not return `click_view` rows (e.g. some PMax / video inventory; verify). If clicks exist in `campaign` metrics but not in `click_view`, report them as aggregate-only.
- Also pull these daily (same auth):
  - `SELECT customer.id, customer.time_zone, customer.auto_tagging_enabled, customer.tracking_url_template, customer.final_url_suffix FROM customer` → `autoTaggingEnabled`, template audit.
  - `SELECT campaign.id, campaign.advertising_channel_type, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.status FROM campaign` → `campaignIds` + network audit.
  - Placement reports for Display/Video (`detail_placement_view` / `group_placement_view`; PMax has its own placement view, verify) → `Placement`.
- **Maturity:** pull D-1 after the account's midnight + a few hours; re-pull D-3 (Google adjusts invalid clicks later). Set `coveredThrough` to the last day that was fully pulled, and `importedAt` to the run time.
- Map to `GoogleClickRow`: `GclId ← click_view.gclid`, `CampaignId ← campaign.id`, `AdGroupId ← ad_group.id`, `Date ← segments.date`, `Device ← segments.device`, `ClickType ← segments.click_type`, `AdNetworkType ← segments.ad_network_type`, `CustomerId ← customer.id`.

### 1.6 Alternative: BigQuery Data Transfer Service (Google Ads connector)

- In our GCP project: *BigQuery → Data transfers → Create → Google Ads*. Give it the **MCC customer ID** to transfer all linked accounts. It authorises with a Google user that has access (OAuth in the UI; no developer token of ours needed, verify).
- Daily tables include `ClickStats_<mcc_id>` with `GclId`, `CampaignId`, `AdGroupId`, `Device`, `ClickType`, `AdNetworkType1`/`AdNetworkType2`, `_DATA_DATE`, `ExternalCustomerId` (verify field names for the current connector version).
- Pros: no quota code, backfill, SQL join with our landings. Cons: BigQuery cost; a daily cadence only (fine: our windows are hours to days).
- `ClickStats` rows map 1:1 to `GoogleClickRow` (`Date ← _DATA_DATE`, `AdNetworkType ← AdNetworkType1`).

### 1.7 Required tracking setup (affiliate side, account level)

**Tracking template** (parallel tracking: Google sends the browser's background hit here while the landing page loads directly):

```
https://t.<ourdomain>/t/g?r=<route_key>&gclid={gclid}&cid={campaignid}&ag={adgroupid}&cr={creative}&kw={keyword}&net={network}&plc={placement}&dev={device}&mt={matchtype}&locp={loc_physical_ms}&lp={lpurl}
```

**Final URL suffix** (appended to the landing URL, so our IVT `ivt.js` sees the values):

```
src=google&aff=<affiliate_id>&cid={campaignid}&ag={adgroupid}&cr={creative}&kw={keyword}&net={network}&plc={placement}&dev={device}&mt={matchtype}
```

- **Parallel tracking** is the default and is mandatory for most campaign types (verify). The tracking URL must respond quickly (2xx or redirect). The user does not go through it.
- `{network}` values: `g` Google search, `s` search partners, `d` Display, `ytv` YouTube, `vp` Google video partners, plus newer values for PMax / Discovery (verify the current list).
- `{device}`: `m`, `t`, `c`. `{placement}`: the site or app for Display clicks.
- `gclid` is added by **auto-tagging**. Never hard-code `gclid={gclid}` in the final URL suffix, or Google adds it twice (verify behaviour).
- iOS clicks may carry `gbraid`/`wbraid` instead of `gclid` (auto-tagging adds them).
- `aff=` must match the Ad Pass config for the site (`docs/AD_PASS.md`).
- Audit daily via `customer.tracking_url_template` / `customer.final_url_suffix`. A changed or removed template becomes a reason (future rule).

---

## 2. Meta (Facebook / Instagram) Ads

### 2.1 What we need from each affiliate

| Need | Why |
|---|---|
| **Partner access** from the affiliate's Business portfolio to our Business, on each ad account, with "view performance" (read) | Insights for their ads |
| Our **URL parameters** on every ad | `{{ad.id}}` etc. on every landing |
| Placements: Facebook + Instagram feeds / stories / reels; **no Audience Network** unless approved | `audience_network_share` rule |
| Optional: the Meta pixel / Conversions API on our pages | `landing_page_views` comparable to our landings |

### 2.2 Partner access to the ad account

1. We have a **Business portfolio** (Business Manager) for provenance. Note its **Business ID** (*Business settings → Business info*).
2. The affiliate, in their Business settings: *Accounts → Ad accounts →* select the account → *Assign partner* (or *Partners → Add → Give a partner access to your assets*; verify the current UI). They enter our Business ID and grant the **lowest read permission**, e.g. "View performance" / "Analyze". Never "Manage campaigns" (verify current permission names).
3. The ad account now appears in our Business under *Accounts → Ad accounts* (shared by partner).
4. Record `act_<id>` in `affiliates.meta_ad_account_ids`, then set `accounts[].linked = true`.

### 2.3 App, system user and long-lived token

1. **App:** at developers.facebook.com, create an app of type **Business**, owned by our Business portfolio. Add the **Marketing API** product.
2. **Access level:** apps start at Standard Access for Marketing API features. Reading ad accounts owned by *other* businesses at volume generally needs **Advanced Access** for `ads_read`. That means **App Review**, and Business Verification of our portfolio (verify current requirements; the "Ads Management Standard Access" feature has its own criteria).
3. **System user:** *Business settings → Users → System users → Add*. Use an *Employee*-role system user (least privilege) named e.g. `provenance-reader`.
4. **Assign assets** to the system user: each partner-shared ad account with read/"view performance" only. Also assign the app.
5. **Generate the token:** on the system user, click *Generate new token* → choose our app → permissions **`ads_read`** (plus `read_insights` if the UI requires it; verify. Don't add `ads_management`) → choose expiry. Options are typically "never" or 60 days (verify). Prefer an expiring token plus rotation (§3).
6. Optionally use **`appsecret_proof`** (HMAC-SHA256 of the token with the app secret) on every call, and enable "Require App Secret" in the app settings.
7. Test with `GET /me?access_token=…` and `GET /act_<id>?fields=name,timezone_name,account_status`. Store `timezone_name` as `timeZone`.

### 2.4 Insights query

```
GET https://graph.facebook.com/vNN.0/act_<AD_ACCOUNT_ID>/insights
  ?level=ad
  &fields=account_id,campaign_id,adset_id,ad_id,clicks,inline_link_clicks,actions,date_start,date_stop
  &breakdowns=publisher_platform,platform_position
  &time_increment=1
  &time_range={"since":"2026-11-08","until":"2026-11-10"}
  &action_breakdowns=action_type
  &limit=500
```

- `landing_page_views` = the `actions[]` entry with `action_type = "landing_page_view"`. Needs the pixel (verify).
- `clicks` = all clicks (likes, expands …). Use **`inline_link_clicks`** for "went to our site".
- Dates are in the **ad account's time zone**. `time_increment=1` gives one row per day.
- `publisher_platform` values: `facebook`, `instagram`, `messenger`, `audience_network` (verify current list). `platform_position` gives feed / story / reels etc.
- Large ranges: use the **async report** (`POST …/insights` → `report_run_id` → poll → fetch). Rate limits are per ad account (Business Use Case limits). Watch the `X-Business-Use-Case-Usage` and `X-FB-Ads-Insights-Throttle` response headers and back off (verify header names).
- **Maturity:** numbers can change for days after delivery (attribution windows, invalid activity removal). Pull D-1, re-pull D-3 (verify how long Meta restates). Set `coveredThrough` and `importedAt`.
- Also pull ad-set targeting daily: `GET /act_<id>/adsets?fields=id,targeting{publisher_platforms,audience_network_positions},status` → audit that Audience Network is excluded.
- Optionally pull `GET /act_<id>/ads?fields=id&limit=…` → `adIds`, so unknown-ad checks don't depend on delivery.
- Map to `MetaInsightRow` 1:1, with `landing_page_views ← actions[landing_page_view]`.

### 2.5 Required URL parameters (affiliate side, every ad)

Ad → *Tracking → URL parameters*:

```
src=meta&aff=<affiliate_id>&utm_source=facebook&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&site_source_name={{site_source_name}}&placement={{placement}}
```

- `{{site_source_name}}`: `fb`, `ig`, `msg`, `an` (verify). `{{placement}}`: e.g. `Facebook_Mobile_Feed`, `Instagram_Stories` (verify list).
- Meta appends `fbclid` on most outbound clicks. Privacy features (e.g. iOS link tracking protection) may strip it (verify), so `fbclid_missing` never BLOCKs alone.
- A literal `{{ad.id}}` reaching us means the URL was not built by Meta → `invalid_click_id`.

---

## 3. Storing and rotating secrets

| Secret | Where it lives | Never |
|---|---|---|
| Google developer token | Secret store of the connector (Cloudflare `wrangler secret put` on the connector Worker, or GCP Secret Manager) | in git, `wrangler.jsonc` `vars`, logs, the demo |
| Google OAuth client ID + secret | same | same |
| Google refresh token | same; one per service user | same |
| Meta app ID + app secret | same | same |
| Meta system-user token | same | same |

- Local development: `.dev.vars` / `.env` files only, listed in `.gitignore`. Use test accounts / sandbox data only.
- Separate secrets per environment (staging vs prod). Read-only scopes only.
- The connector is a **separate Worker / job** from the IVT Worker (doc 03 isolation). The IVT Worker never sees these secrets.
- Log token *fingerprints* (last 4 characters), never values.

**Rotation:**

- **Google refresh token:** re-consent with the service user → new refresh token → `wrangler secret put` → verify a query → revoke the old token at myaccount.google.com/permissions (or the OAuth revoke endpoint). Do it every 90 days, and immediately if leaked. A password change on the service user can revoke tokens (verify).
- **OAuth client secret:** Cloud console → add a new secret → deploy → delete the old one.
- **Developer token:** can be reset in API Center (verify). Do it only if leaked.
- **Meta system-user token:** *System users → Generate new token* → deploy → *Revoke* the old token. Every 60 days if expiring; immediately if leaked. **App secret:** *App settings → Basic → Reset* (this breaks `appsecret_proof` until deployed).
- Alert when a pull fails with an auth error. The logic treats it as `status: 'error'` → UNKNOWN → THROTTLE after 48h grace.

---

## 4. When an affiliate refuses (or partially grants) access

| Situation | Data passed to the logic | Result |
|---|---|---|
| Refuses Google / Meta access entirely | `status: 'no_access'` (or no platform entry) | `no_partner_access` → **THROTTLE floor** (`accessFloor.none`). Edge checks still run and can escalate to BLOCK |
| Shares some accounts only | `accounts[].linked=false` for the rest | `unlinked_accounts` → WATCH floor; traffic from unshared campaigns → `partial_account_access` / `unknown_ad_ids` (cap THROTTLE) |
| Turns auto-tagging off | `autoTaggingEnabled: false` | `autotagging_off` → THROTTLE |
| Revokes access later | pull fails with a permission error → map to `no_access` (not `error`) | floor THROTTLE from the next window |

Commercial levers (doc 03 §6): make access a contract condition; longer payment terms, a rolling reserve, and lower daily ad caps for unverified affiliates; graduation only after N clean verified windows.

## 5. Open questions (verify before building)

- Exact current Google Ads API version, access tiers (Explorer / Basic / Standard) and quotas.
- Whether `click_view` returns rows for PMax / Demand Gen / Video, and whether any exact click time is exposed.
- Current BigQuery DTS `ClickStats` schema (field names, `AdNetworkType1` vs `2`).
- Meta: the current partner-permission names, whether `ads_read` on partner-shared accounts needs Advanced Access + App Review for our case, system-user token expiry options, and Insights rate-limit headers.
- How long Meta restates daily Insights (sets the re-pull window).
- Whether iOS / Safari strips `fbclid` / `gclid` in our traffic mix (calibrates `fbclid_missing` and `no_click_id`).
