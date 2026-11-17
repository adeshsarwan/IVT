// Traffic Provenance — shared types.
// Everything here is plain data: no network, no DB, no clocks. Inputs in, report out.

export type Source = 'google' | 'meta' | 'unknown';

/** Severity / trust tier, ordered. Numeric so "worse" is just "greater". */
export const TIERS = ['OK', 'WATCH', 'THROTTLE', 'BLOCK'] as const;
export type Tier = (typeof TIERS)[number];
export const OK = 0, WATCH = 1, THROTTLE = 2, BLOCK = 3;
export type Severity = 0 | 1 | 2 | 3;

// ───────────────────────────── Our side (logged requests) ─────────────────────────────

/** One logged landing as it comes out of our logs (IVT D1 / Edge Collector). */
export interface RawRequest {
  /** Unique request / session id. Drives deterministic sampling and de-duplication. */
  id: string;
  /** ISO-8601 string or epoch milliseconds (UTC). */
  ts: string | number;
  site: string;
  /** Affiliate id (`?aff=`); null/undefined = house traffic. */
  aff?: string | null;
  /** Route key (affiliate → site → platform). Preferred source of the platform claim. */
  route?: string | null;
  /** Full landing URL. Query params are parsed from it. */
  url?: string;
  /** Alternatively, already-parsed query params (merged over the URL's). */
  params?: Record<string, string>;
  /** Keyed hash of the client IP (prefix). Used only for click-ID reuse. */
  ipHash?: string;
  /** Keyed hash of the User-Agent. */
  uaHash?: string;
  /** Device class we derived from the UA (for device-consistency checks). */
  uaDevice?: 'mobile' | 'desktop' | 'tablet' | null;
}

export interface GoogleParams {
  campaignId: string | null;
  adGroupId: string | null;
  creative: string | null;
  keyword: string | null;
  placement: string | null;
  /** ValueTrack {network}: g, s, d, ytv, vp, x … */
  network: string | null;
  /** ValueTrack {device}: m, t, c */
  device: string | null;
  matchType: string | null;
}

export interface MetaParams {
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  /** {{site_source_name}}: fb, ig, msg, an */
  siteSource: string | null;
  /** {{placement}} e.g. Facebook_Mobile_Feed, Instagram_Stories, an_… */
  placement: string | null;
}

export interface NormalizedRequest {
  id: string;
  ts: number;
  site: string;
  /** '(none)' when no affiliate. */
  aff: string;
  route: string | null;
  /** What the route / URL claims the traffic is. */
  claimed: Source;
  /** Where the claim came from (route config is the only one an attacker can't forge). */
  claimSource: 'route' | 'src' | 'utm' | 'click_id' | 'none';
  /** What the click IDs say. */
  inferred: Source;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  fbclid: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  g: GoogleParams;
  m: MetaParams;
  /** Param names whose values still contain a literal macro like `{campaignid}` or `{{ad.id}}`. */
  unexpandedMacros: string[];
  ipHash: string | null;
  uaHash: string | null;
  uaDevice: 'mobile' | 'desktop' | 'tablet' | null;
  /** Deterministic: hash(salt + id) < sampleRate. */
  inSample: boolean;
}

// ───────────────────────────── Platform side ─────────────────────────────

export type PlatformStatus = 'ok' | 'error' | 'no_access';

/** How the platform data reached us. Strength drives the trust floor and anti-tamper checks.
 *  strong = we pull it from the platform ourselves; medium = code running in the partner's
 *  account pushes it (they could edit it); weak = the partner hands us a file (self-reported). */
export type ConnectorType =
  | 'api_mcc'            // Google Ads API via our MCC + developer token (strong)
  | 'api_bq_transfer'    // BigQuery Data Transfer ClickStats (strong)
  | 'api_partner_token'  // a token the partner created (e.g. Meta system user); WE pull (strong)
  | 'ads_script_push'    // Google Ads Script in the partner's account pushes signed rows (medium)
  | 'sheet_export'       // scheduled Google Sheets / Looker Studio export (weak)
  | 'email_report'       // scheduled report e-mailed to our inbox (weak)
  | 'csv_upload';        // partner uploads a CSV in the partner portal (weak)

export interface ConnectorInfo {
  type: ConnectorType;
  /** Connector instance id (registry key), for status views. */
  id?: string;
}

/** Aggregate Google clicks (UI reports usually have no gclid column): one row per day × campaign (× network × device). */
export interface GoogleDailyRow {
  Date: string;
  CampaignId?: string;
  Clicks: number;
  AdNetworkType?: string;
  Device?: string;
}

/** One row shaped like Google Ads `click_view` / BigQuery DTS `ClickStats_<cid>`. */
export interface GoogleClickRow {
  GclId: string;
  CustomerId?: string;
  CampaignId: string;
  AdGroupId?: string;
  /** Click date in the ad account's time zone, YYYY-MM-DD (segments.date / _DATA_DATE). */
  Date: string;
  /** Exact click time, if a source provides it (e.g. our own /t/g tracking beacon). Optional. */
  ClickTimestamp?: string | number;
  /** MOBILE | DESKTOP | TABLET | CONNECTED_TV | OTHER */
  Device?: string;
  /** e.g. URL_CLICKS, HEADLINE … (segments.click_type) */
  ClickType?: string;
  /** SEARCH | SEARCH_PARTNERS | CONTENT | YOUTUBE_SEARCH | YOUTUBE_WATCH | MIXED … */
  AdNetworkType?: string;
  /** Optional placement (from placement reports joined by ad group, or our beacon). */
  Placement?: string;
}

export interface GoogleAccount {
  customerId: string;
  /** Does our MCC / OAuth grant actually reach this account? */
  linked: boolean;
  /** customer.auto_tagging_enabled, if known. */
  autoTaggingEnabled?: boolean;
}

export interface GooglePlatformData {
  status: PlatformStatus;
  /** Ad-account time zone (IANA). Click `Date`s are in this zone. */
  timeZone: string;
  accounts: GoogleAccount[];
  /** Last account-local date whose click_view import is complete. Later dates = pending. */
  coveredThrough?: string | null;
  /** When the import ran (ISO / ms). Used for freshness reporting. */
  importedAt?: string | number | null;
  clicks: GoogleClickRow[];
  /** All campaign ids in the linked accounts (lets us tell "unlinked account" from "forged"). */
  campaignIds?: string[];
  /** Aggregate-only data (no gclids). Used for the day ratio and network mix when `clicks` is empty. */
  dailyClicks?: GoogleDailyRow[];
  /** Where this data came from. Absent = treated as a strong API pull. */
  connector?: ConnectorInfo;
}

/** One row shaped like a Meta Insights response at level=ad, time_increment=1,
 *  breakdowns=publisher_platform,platform_position. */
export interface MetaInsightRow {
  account_id?: string;
  campaign_id: string;
  adset_id?: string;
  ad_id: string;
  /** Account-local date (Insights `date_start` with time_increment=1). */
  date_start: string;
  date_stop?: string;
  /** facebook | instagram | messenger | audience_network */
  publisher_platform?: string;
  platform_position?: string;
  clicks: number;
  inline_link_clicks: number;
  /** From actions[action_type=landing_page_view]; needs the Meta pixel. Optional. */
  landing_page_views?: number;
}

export interface MetaAccount { id: string; linked: boolean }

export interface MetaPlatformData {
  status: PlatformStatus;
  timeZone: string;
  accounts: MetaAccount[];
  coveredThrough?: string | null;
  importedAt?: string | number | null;
  insights: MetaInsightRow[];
  /** All ad ids in the linked accounts, if pulled (else derived from insights). */
  adIds?: string[];
  connector?: ConnectorInfo;
}

export interface AffiliatePlatformData {
  google?: GooglePlatformData;
  meta?: MetaPlatformData;
}

// ───────────────────────────── Engine I/O ─────────────────────────────

export interface Reason {
  code: string;
  severity: Severity;
  /** Hard reasons may BLOCK on a single window (no confirmation window). */
  hard?: boolean;
  /** Platform-independent evidence still counts when platform data is late/missing. */
  edgeOnly?: boolean;
  message: string;
  value?: number;
  threshold?: number;
  ci?: [number, number];
  n?: number;
}

export interface RateStat {
  k: number;
  n: number;
  rate: number | null;
  ci: [number, number] | null;
}

export type WindowStatus =
  | 'VERDICT'      // evaluated with mature platform data
  | 'PROVISIONAL'  // platform data not mature yet: only edge-only reasons applied
  | 'NO_ACCESS'    // no partner access: edge-only reasons + no_partner_access floor
  | 'UNKNOWN'      // platform pull failed: edge-only reasons, breaker holds (with grace)
  | 'NO_VERDICT'   // too few requests to judge
  | 'OPEN';        // window not closed yet

export interface Freshness {
  coveredThrough: string | null;
  importedAt: number | null;
  ageHours: number | null;
  stale: boolean;
  /** Share of sampled click-level requests whose day is past coveredThrough. */
  pendingShare: number;
}

export interface WindowStats {
  requests: number;
  sampled: number;
  /** Click-level (Google) outcome counts in the sample. */
  outcomes: Record<string, number>;
  matchRate?: RateStat;
  noClickIdRate?: RateStat;
  braidShare?: number;
  invalidClickIdRate?: RateStat;
  reusedClickIdRate?: RateStat;
  timingAnomalyRate?: RateStat;
  deviceMismatchRate?: RateStat;
  riskyNetworkRate?: RateStat;
  blockedPlacementRate?: RateStat;
  unlinkedCampaignRate?: RateStat;
  unknownAdRate?: RateStat;
  fbclidMissingRate?: RateStat;
  audienceNetworkShare?: number | null;
  /** Our landings ÷ platform clicks over complete account-local days touched by the window. */
  ratio?: { ours: number; platform: number; value: number | null; days: string[]; metric: string };
  lpvRatio?: { ours: number; platform: number; value: number | null } | null;
  networkMix?: Record<string, number>;
  placementMix?: Record<string, number>;
  hourCurveEntropy?: number | null;
  /** Meta: ads where our landings exceed the platform's link clicks. */
  inflatedAds?: { adId: string; ours: number; linkClicks: number }[];
  /** Google: matched clicks whose platform network/campaign disagrees with our ValueTrack params. */
  paramMismatchRate?: RateStat;
  /** Google: false when the data is aggregate only (no gclids). */
  clickLevel?: boolean;
  /** Connector type of the platform data ('api' when unspecified). */
  connector?: string | null;
  /** Partner-supplied report: malformed / duplicate gclid share, share of reported clicks that never landed. */
  reportInvalid?: number;
  reportDuplicate?: number;
  platformOnlyShare?: number | null;
}

export interface WindowResult {
  key: string;
  aff: string;
  source: Source;
  index: number;
  start: number;
  end: number;
  closedBy: 'count' | 'time' | 'open';
  status: WindowStatus;
  severity: Severity;
  tier: Tier;            // severity as a tier name
  hard: boolean;
  reasons: Reason[];
  stats: WindowStats;
  freshness: Freshness | null;
  /** Breaker tier after this window was applied. */
  breakerTier?: Tier;
  breakerNote?: string;
}

export interface KvAction {
  /** 'suggest' = recommended write that a human must approve and apply (manual mode). */
  op: 'put' | 'delete' | 'none' | 'suggest';
  key: string;
  value?: string;
  note: string;
}

export interface AffiliateResult {
  aff: string;
  tier: Tier;
  bySource: Partial<Record<Source, Tier>>;
  access: Partial<Record<'google' | 'meta', 'full' | 'partial' | 'none'>>;
  actions: KvAction[];
  notes: string[];
}

export interface ProvenanceInput {
  requests: RawRequest[];
  platform: Record<string, AffiliatePlatformData>;
  /** "Now" for time-closed windows and freshness. Required for determinism. */
  now: string | number;
  /** Previous breaker states (from last run), keyed `${aff}|${source}`. */
  previous?: Record<string, BreakerState>;
}

export interface BreakerState {
  tier: Tier;
  /** Consecutive decided windows at BLOCK severity (non-hard). */
  blockStreak: number;
  /** Consecutive decided windows strictly below the current tier. */
  cleanStreak: number;
  /** Start of the current run of UNKNOWN windows (ms), if any. */
  unknownSince: number | null;
  awaitingManualUnblock: boolean;
}

export interface ProvenanceReport {
  config: import('./config').ProvenanceConfig;
  totals: { input: number; duplicatesDropped: number; invalidDropped: number; normalized: number };
  windows: WindowResult[];
  breakers: Record<string, BreakerState>;
  affiliates: AffiliateResult[];
}
