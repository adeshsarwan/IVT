// Every number the engine uses lives here. README §5 explains each one.
// Thresholds are starting points to calibrate in shadow mode, not truths.

import type { ConnectorType, Source } from './types';

type TierName = 'OK' | 'WATCH' | 'THROTTLE' | 'BLOCK';

/** Three-step thresholds for a rate where HIGH is bad.
 *  watch: point estimate > watch · throttle/block: Wilson LOWER bound > value (confidently bad). */
export interface HighBad { watch: number; throttle: number; block: number }
/** Thresholds for a rate where LOW is bad (match rate).
 *  watch: point < watch · throttle/block: Wilson UPPER bound < value (confidently bad). */
export interface LowBad { watch: number; throttle: number; block: number }

export interface ProvenanceConfig {
  /** Close a window every N requests per affiliate × source (5,000 default; 10,000 supported). */
  windowSize: number;
  /** …or when this much time has passed since the window's first request. */
  windowMaxMs: number;
  /** Fraction of requests that get per-request checks (deterministic by id hash). 1 = all. */
  sampleRate: number;
  /** Salt for the sampling hash, so affiliates can't predict which requests are checked. */
  sampleSalt: string;
  /** Windows with fewer requests than this get NO_VERDICT. */
  minWindowRequests: number;
  /** A rate metric whose denominator is below this is skipped (no evidence either way). */
  minSample: number;
  /** A ratio needs at least this many platform clicks (or our landings, if platform = 0). */
  minRatioClicks: number;
  /** Wilson z (1.96 = 95%). */
  z: number;

  /** Route key → platform. The only claim an affiliate can't forge by editing the URL. */
  routes: Record<string, Source>;

  google: {
    matchRate: LowBad;
    noClickId: HighBad;
    /** Our landings ÷ Google clicks (per complete account day). HIGH = injected/replayed. */
    ratioHigh: { watch: number; throttle: number; block: number };
    /** LOW ratio = Google billed clicks that never loaded our page. WATCH only. */
    ratioLowWatch: number;
    riskyNetwork: HighBad;
    /** ClickStats AdNetworkType values treated as risky. */
    riskyNetworkTypes: string[];
    /** ValueTrack {network} values treated as risky (s = search partners, d = display …). */
    riskyNetworkParams: string[];
    deviceMismatch: HighBad;
    /** Landing may be this many days after the click date (midnight + tz slack). */
    dateToleranceDays: number;
    /** With exact click timestamps: allowed clock skew before the click, and max delay after. */
    clockSkewMs: number;
    maxClickToLandMs: number;
    unlinkedCampaign: HighBad;
    /** If < this share of Google-claimed requests carry any click id, assume auto-tagging is off. */
    autoTagOffBelow: number;
  };

  meta: {
    ratioHigh: { watch: number; throttle: number; block: number };
    ratioLowWatch: number;
    audienceNetwork: { watch: number; throttle: number; block: number };
    unknownAd: HighBad;
    fbclidMissing: HighBad;
    /** Per-ad inflation: ours > linkClicks × factor + slack. */
    adInflationFactor: number;
    adInflationSlack: number;
  };

  /** Shared per-request checks. */
  invalidClickId: HighBad;
  reusedClickId: HighBad;
  /** A click id seen from more than this many distinct IP hashes = reused. */
  maxIpsPerClickId: number;
  /** …or more than this many hits in total. */
  maxHitsPerClickId: number;
  timingAnomaly: HighBad;
  blockedPlacement: HighBad;
  /** Lower-case substrings; a placement containing one is "blocked" (porn, apps …). */
  placementBlocklist: string[];
  /** Hour-of-day histogram normalized entropy ≥ this (window spanning ≥ 24h) = flat 24/7 curve. */
  flatHourEntropy: number;

  /** Hard (single-window BLOCK) limits. */
  hard: { matchRateUpperBelow: number; ratioAbove: number; invalidClickIdAbove: number; blockedPlacementAbove: number };

  freshness: {
    /** Import older than this = stale (reported, and adds a WATCH-level info reason). */
    maxStaleMs: number;
    /** If more than this share of click-level samples is pending, the window is PROVISIONAL. */
    provisionalAbove: number;
  };

  breaker: {
    /** Non-hard BLOCK needs this many consecutive BLOCK-severity windows (else THROTTLE meanwhile). */
    blockConfirmWindows: number;
    /** Step down ONE tier after this many consecutive windows below the current tier. */
    recoverWindows: number;
    /** BLOCK is only released by a human (recommended). */
    manualUnblock: boolean;
    /** UNKNOWN (platform down) longer than this → at least THROTTLE. */
    unknownGraceMs: number;
  };

  enforcement: {
    /** false (default): BLOCK is only a recommendation; a human turns the kill switch on.
     *  true: the plan carries the KV write for an audited job to apply automatically. */
    autoBlock: boolean;
  };

  connectors: {
    /** Minimum tier by how the platform data reached us (self-reported data can prove bad, not good). */
    floors: Record<ConnectorType, TierName>;
    /** Google data without gclids (UI aggregate report): click-level matching impossible. */
    aggregateOnlyFloor: TierName;
    /** Partner-supplied click list with almost no clicks we didn't see land = likely built from our own landings. */
    mirrorBelow: number;
    mirrorMinClicks: number;
    /** Malformed / duplicate click ids inside a partner-supplied report. */
    reportInvalid: HighBad;
    reportDuplicate: HighBad;
    /** Platform row says network/campaign X, our ValueTrack param on the same click says Y. */
    paramMismatch: HighBad;
    /** Share of affiliates picked for a manual spot audit per audit period, by connector strength. */
    auditRates: { strong: number; medium: number; weak: number; none: number };
  };

  /** Minimum tier when we lack partner access. */
  accessFloor: { none: 'OK' | 'WATCH' | 'THROTTLE' | 'BLOCK'; partial: 'OK' | 'WATCH' | 'THROTTLE' | 'BLOCK' };
}

const H = 3600_000;

export const DEFAULT_CONFIG: ProvenanceConfig = {
  windowSize: 5000,
  windowMaxMs: 24 * H,
  sampleRate: 1,
  sampleSalt: 'tps-v1',
  minWindowRequests: 300,
  minSample: 200,
  minRatioClicks: 100,
  z: 1.96,
  routes: {},

  google: {
    matchRate: { watch: 0.95, throttle: 0.90, block: 0.75 },
    noClickId: { watch: 0.05, throttle: 0.15, block: 0.40 },
    ratioHigh: { watch: 1.05, throttle: 1.20, block: 1.50 },
    ratioLowWatch: 0.50,
    riskyNetwork: { watch: 0.10, throttle: 0.30, block: 0.60 },
    riskyNetworkTypes: ['SEARCH_PARTNERS', 'CONTENT'],
    riskyNetworkParams: ['s', 'd'],
    deviceMismatch: { watch: 0.10, throttle: 0.25, block: 2 /* never blocks alone */ },
    dateToleranceDays: 1,
    clockSkewMs: 120_000,
    maxClickToLandMs: H,
    unlinkedCampaign: { watch: 0.05, throttle: 0.20, block: 2 /* access problem, not fraud proof */ },
    autoTagOffBelow: 0.05,
  },

  meta: {
    ratioHigh: { watch: 1.05, throttle: 1.20, block: 1.50 },
    ratioLowWatch: 0.30,
    audienceNetwork: { watch: 0.05, throttle: 0.20, block: 0.50 },
    unknownAd: { watch: 0.05, throttle: 0.20, block: 2 },
    fbclidMissing: { watch: 0.10, throttle: 0.50, block: 2 },
    adInflationFactor: 1.2,
    adInflationSlack: 5,
  },

  invalidClickId: { watch: 0.005, throttle: 0.02, block: 0.05 },
  reusedClickId: { watch: 0.01, throttle: 0.03, block: 0.10 },
  maxIpsPerClickId: 2,
  maxHitsPerClickId: 5,
  timingAnomaly: { watch: 0.02, throttle: 0.05, block: 0.15 },
  blockedPlacement: { watch: 0.001, throttle: 0.01, block: 0.05 },
  placementBlocklist: ['porn', 'xxx', 'adult', 'sex', 'nsfw', 'escort', 'hentai', 'mobileapp::', 'anonymous.google'],
  flatHourEntropy: 0.985,

  hard: { matchRateUpperBelow: 0.5, ratioAbove: 2.0, invalidClickIdAbove: 0.2, blockedPlacementAbove: 0.2 },

  freshness: { maxStaleMs: 36 * H, provisionalAbove: 0.5 },

  breaker: { blockConfirmWindows: 2, recoverWindows: 3, manualUnblock: true, unknownGraceMs: 48 * H },

  enforcement: { autoBlock: false },

  accessFloor: { none: 'THROTTLE', partial: 'WATCH' },

  connectors: {
    floors: {
      api_mcc: 'OK', api_bq_transfer: 'OK', api_partner_token: 'OK',
      ads_script_push: 'OK',
      sheet_export: 'WATCH', email_report: 'WATCH', csv_upload: 'WATCH',
    },
    aggregateOnlyFloor: 'WATCH',
    mirrorBelow: 0.005,
    mirrorMinClicks: 1000,
    reportInvalid: { watch: 0.001, throttle: 0.01, block: 0.05 },
    reportDuplicate: { watch: 0.001, throttle: 0.01, block: 0.05 },
    paramMismatch: { watch: 0.02, throttle: 0.05, block: 0.15 },
    auditRates: { strong: 0.02, medium: 0.10, weak: 0.25, none: 1 },
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type ConfigOverrides = DeepPartial<ProvenanceConfig>;

/** Deep-merge overrides onto the defaults (arrays and route maps replace). */
export function makeConfig(over: ConfigOverrides = {}): ProvenanceConfig {
  const merge = (base: any, o: any): any => {
    if (o === undefined) return base;
    if (Array.isArray(o) || typeof o !== 'object' || o === null || Array.isArray(base) || typeof base !== 'object') return o;
    const out: any = { ...base };
    for (const k of Object.keys(o)) out[k] = k === 'routes' ? { ...o[k] } : merge(base?.[k], o[k]);
    return out;
  };
  const cfg = merge(DEFAULT_CONFIG, over) as ProvenanceConfig;
  if (!(cfg.windowSize >= 1)) throw new Error('windowSize must be ≥ 1');
  if (!(cfg.sampleRate > 0 && cfg.sampleRate <= 1)) throw new Error('sampleRate must be in (0, 1]');
  return cfg;
}
