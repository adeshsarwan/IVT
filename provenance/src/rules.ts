// Rule helpers that turn a statistic into a Reason, plus checks shared by Google and Meta.

import type { HighBad, LowBad, ProvenanceConfig } from './config';
import type { NormalizedRequest, RateStat, Reason, Severity } from './types';
import { localHour, normEntropy, rateStat, round } from './util';

export interface RuleOpts {
  edgeOnly?: boolean;
  /** Mark hard (single-window BLOCK) when the Wilson bound passes this. */
  hardAt?: number;
  /** Never exceed this severity (e.g. access problems are not proof of fraud). */
  cap?: Severity;
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${round(x * 100, 2)}%`);
const capAt = (s: Severity, cap?: Severity): Severity => (cap !== undefined && s > cap ? cap : s);

/** Rate where HIGH is bad. Watch on the point estimate; throttle/block only when the
 *  Wilson LOWER bound is above the threshold (we are confident it's that bad). */
export function highBad(code: string, label: string, s: RateStat, t: HighBad, cfg: ProvenanceConfig, skipped: string[], o: RuleOpts = {}): Reason | null {
  if (s.n < cfg.minSample || s.rate === null || !s.ci) { if (s.n > 0) skipped.push(code); return null; }
  const lo = s.ci[0];
  let sev: Severity = lo > t.block ? 3 : lo > t.throttle ? 2 : s.rate > t.watch ? 1 : 0;
  sev = capAt(sev, o.cap);
  if (sev === 0) return null;
  const threshold = sev === 3 ? t.block : sev === 2 ? t.throttle : t.watch;
  return {
    code, severity: sev, edgeOnly: o.edgeOnly,
    hard: sev === 3 && o.hardAt !== undefined && lo > o.hardAt,
    message: `${label} ${pct(s.rate)} (95% CI ${pct(s.ci[0])}–${pct(s.ci[1])}, n=${s.n}) ${sev === 1 ? '>' : 'CI low >'} ${pct(threshold)}`,
    value: round(s.rate), threshold, ci: [round(s.ci[0]), round(s.ci[1])], n: s.n,
  };
}

/** Rate where LOW is bad (match rate). Watch on the point; throttle/block when the Wilson
 *  UPPER bound is below the threshold. */
export function lowBad(code: string, label: string, s: RateStat, t: LowBad, cfg: ProvenanceConfig, skipped: string[], o: { hardBelow?: number } = {}): Reason | null {
  if (s.n < cfg.minSample || s.rate === null || !s.ci) { if (s.n > 0 || code === 'low_match_rate') skipped.push(code); return null; }
  const hi = s.ci[1];
  const sev: Severity = hi < t.block ? 3 : hi < t.throttle ? 2 : s.rate < t.watch ? 1 : 0;
  if (sev === 0) return null;
  const threshold = sev === 3 ? t.block : sev === 2 ? t.throttle : t.watch;
  return {
    code, severity: sev,
    hard: sev === 3 && o.hardBelow !== undefined && hi < o.hardBelow,
    message: `${label} ${pct(s.rate)} (95% CI ${pct(s.ci[0])}–${pct(s.ci[1])}, n=${s.n}) ${sev === 1 ? '<' : 'CI high <'} ${pct(threshold)}`,
    value: round(s.rate), threshold, ci: [round(s.ci[0]), round(s.ci[1])], n: s.n,
  };
}

/** Our landings ÷ platform clicks. Not a proportion, so it uses the point value with a volume guard. */
export function ratioRules(
  prefix: 'google' | 'meta', ours: number, platform: number,
  t: { watch: number; throttle: number; block: number }, lowWatch: number,
  cfg: ProvenanceConfig, skipped: string[], metric: string,
): { value: number | null; reasons: Reason[] } {
  const reasons: Reason[] = [];
  if (platform === 0) {
    if (ours >= cfg.minRatioClicks) {
      reasons.push({ code: 'platform_reports_zero_clicks', severity: 3, hard: true, value: Infinity, n: ours,
        message: `${ours} landings on complete days but the ${prefix} account reports 0 ${metric} for them` });
      return { value: Infinity, reasons };
    }
    if (ours > 0) skipped.push(`${prefix}_ratio`);
    return { value: null, reasons };
  }
  const v = ours / platform;
  if (platform < cfg.minRatioClicks && ours < cfg.minRatioClicks) { skipped.push(`${prefix}_ratio`); return { value: v, reasons }; }
  const sev: Severity = v > t.block ? 3 : v > t.throttle ? 2 : v > t.watch ? 1 : 0;
  if (sev > 0) {
    const threshold = sev === 3 ? t.block : sev === 2 ? t.throttle : t.watch;
    reasons.push({ code: 'landings_exceed_clicks', severity: sev, hard: sev === 3 && v > cfg.hard.ratioAbove,
      value: round(v, 3), threshold, n: platform,
      message: `${ours} landings vs ${platform} ${prefix} ${metric} = ${round(v, 3)}× (> ${threshold}×): traffic not bought on ${prefix} is being added` });
  } else if (v < lowWatch) {
    reasons.push({ code: 'clicks_not_landing', severity: 1, value: round(v, 3), threshold: lowWatch, n: platform,
      message: `only ${round(v, 3)}× of ${prefix} ${metric} reached our pages (< ${lowWatch}×): accidental/bot clicks or slow pages` });
  }
  return { value: v, reasons };
}

/** Index of every click id → distinct IP hashes and total hits, over the whole run. */
export type ReuseIndex = Map<string, { ips: Set<string>; hits: number }>;

export function buildReuseIndex(reqs: NormalizedRequest[]): ReuseIndex {
  const idx: ReuseIndex = new Map();
  for (const r of reqs) {
    for (const id of [r.gclid, r.fbclid, r.gbraid, r.wbraid]) {
      if (!id) continue;
      let e = idx.get(id);
      if (!e) idx.set(id, (e = { ips: new Set(), hits: 0 }));
      e.hits++;
      if (r.ipHash) e.ips.add(r.ipHash);
    }
  }
  return idx;
}

export function isReused(id: string | null, idx: ReuseIndex, cfg: ProvenanceConfig): boolean {
  if (!id) return false;
  const e = idx.get(id);
  return !!e && (e.ips.size > cfg.maxIpsPerClickId || e.hits > cfg.maxHitsPerClickId);
}

export function isBlockedPlacement(p: string | null | undefined, cfg: ProvenanceConfig): boolean {
  if (!p) return false;
  const s = p.toLowerCase();
  return cfg.placementBlocklist.some((b) => s.includes(b));
}

/** The 24h of this affiliate × source traffic ending at the window's last request.
 *  Count windows are often shorter than a day, so the hour curve looks back a full day. */
export function last24h(win: NormalizedRequest[], group: NormalizedRequest[]): NormalizedRequest[] {
  if (!win.length) return [];
  const end = win[win.length - 1].ts;
  return group.filter((r) => r.ts > end - 24 * 3600_000 && r.ts <= end);
}

/** Flat 24/7 hour curve. Humans sleep; farms don't. Needs ~a day of data (≥ 23h span) and ≥ 480 requests. */
export function hourCurve(reqs: NormalizedRequest[], tz: string, cfg: ProvenanceConfig): { entropy: number | null; reason: Reason | null } {
  if (reqs.length < 480 || reqs[reqs.length - 1].ts - reqs[0].ts < 23 * 3600_000) return { entropy: null, reason: null };
  const h = new Array(24).fill(0);
  for (const r of reqs) h[localHour(r.ts, tz)]++;
  const e = normEntropy(h);
  if (e === null || e < cfg.flatHourEntropy) return { entropy: e === null ? null : round(e), reason: null };
  return { entropy: round(e), reason: { code: 'flat_hour_curve', severity: 1, edgeOnly: true, value: round(e), threshold: cfg.flatHourEntropy,
    message: `hour-of-day curve over the last 24h is flat (entropy ${round(e, 3)} ≥ ${cfg.flatHourEntropy}): looks like 24/7 automation` } };
}

export { rateStat, pct };
