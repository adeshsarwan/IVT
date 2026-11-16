// Google Ads: click-level GclId matching against click_view / ClickStats rows,
// plus a day-level landings ÷ clicks ratio and network / placement / device / timing checks.

import type { ProvenanceConfig } from './config';
import type { Freshness, GoogleClickRow, GooglePlatformData, NormalizedRequest, Reason, WindowStats, WindowStatus } from './types';
import { buildReuseIndex, highBad, hourCurve, last24h, isBlockedPlacement, isReused, lowBad, ratioRules, type ReuseIndex } from './rules';
import { dayDiff, inc, localDate, rateStat, round, toMs } from './util';
import { isPlausibleClickId } from './normalize';

export type GoogleOutcome =
  | 'matched' | 'unmatched' | 'invalid_click_id' | 'pending'
  | 'unlinked_campaign' | 'braid_only' | 'no_click_id';

export interface PlatformEval {
  status: WindowStatus;
  reasons: Reason[];
  stats: WindowStats;
  freshness: Freshness | null;
  access: 'full' | 'partial' | 'none';
}

const DEVICE: Record<string, 'mobile' | 'desktop' | 'tablet'> = {
  MOBILE: 'mobile', DESKTOP: 'desktop', TABLET: 'tablet', m: 'mobile', c: 'desktop', t: 'tablet',
};

export function freshnessOf(coveredThrough: string | null | undefined, importedAt: string | number | null | undefined, now: number, pendingShare: number, cfg: ProvenanceConfig): Freshness {
  const imp = toMs(importedAt ?? null);
  const age = imp === null ? null : (now - imp) / 3600_000;
  return {
    coveredThrough: coveredThrough ?? null,
    importedAt: imp,
    ageHours: age === null ? null : round(age, 1),
    stale: imp === null || now - imp > cfg.freshness.maxStaleMs,
    pendingShare: round(pendingShare),
  };
}

/** Is an account-local date covered by the import? */
export const isComplete = (date: string, coveredThrough: string | null | undefined) => !!coveredThrough && date <= coveredThrough;

export function evaluateGoogle(
  win: NormalizedRequest[], group: NormalizedRequest[], data: GooglePlatformData | undefined,
  cfg: ProvenanceConfig, now: number, reuse: ReuseIndex = buildReuseIndex(group),
): PlatformEval {
  const reasons: Reason[] = [];
  const skipped: string[] = [];
  const outcomes: Record<string, number> = {};
  const linked = data?.accounts.filter((a) => a.linked) ?? [];
  const usable = !!data && data.status === 'ok' && linked.length > 0;
  const tz = data?.timeZone || 'UTC';

  // Access
  let access: PlatformEval['access'] = !data || data.status === 'no_access' || (data.status === 'ok' && linked.length === 0) ? 'none'
    : data.accounts.some((a) => !a.linked) ? 'partial' : 'full';

  const clicks = new Map<string, GoogleClickRow>();
  if (usable) for (const c of data!.clicks) if (!clicks.has(c.GclId)) clicks.set(c.GclId, c);
  const campaignSet = usable && data!.campaignIds?.length ? new Set(data!.campaignIds) : null;

  const sample = win.filter((r) => r.inSample);
  let anyId = 0, withTemplate = 0, braid = 0, invalid = 0, reused = 0, idsSeen = 0;
  let timingAnom = 0, timingN = 0, devMis = 0, devN = 0, risky = 0, netN = 0, blocked = 0, plcN = 0;
  const networkMix: Record<string, number> = {};
  const placementMix: Record<string, number> = {};

  for (const r of sample) {
    if (r.gclid || r.gbraid || r.wbraid) anyId++;
    if (r.g.campaignId || r.g.network) withTemplate++;
    const macro = r.unexpandedMacros.length > 0;

    let o: GoogleOutcome;
    let row: GoogleClickRow | undefined;
    if (r.gclid) {
      idsSeen++;
      if (isReused(r.gclid, reuse, cfg)) reused++;
      if (!isPlausibleClickId(r.gclid) || macro) { o = 'invalid_click_id'; invalid++; }
      else if (!usable) o = 'pending';
      else if (!isComplete(localDate(r.ts, tz), data!.coveredThrough)) o = 'pending';
      else if ((row = clicks.get(r.gclid))) o = 'matched';
      else if (campaignSet && r.g.campaignId && !campaignSet.has(r.g.campaignId)) o = 'unlinked_campaign';
      else o = 'unmatched';
    } else if (r.gbraid || r.wbraid) {
      o = 'braid_only'; braid++;
      if (isReused(r.gbraid || r.wbraid, reuse, cfg)) reused++;
      idsSeen++;
      if (macro) invalid++;
    } else {
      o = 'no_click_id';
      if (macro) invalid++;
    }
    inc(outcomes, o);

    // Timing (needs a matched platform row)
    if (row) {
      timingN++;
      const clickTs = toMs(row.ClickTimestamp ?? null);
      if (clickTs !== null) {
        const d = r.ts - clickTs;
        if (d < -cfg.google.clockSkewMs || d > cfg.google.maxClickToLandMs) timingAnom++;
      } else {
        const d = dayDiff(row.Date, localDate(r.ts, tz));
        if (d < 0 || d > cfg.google.dateToleranceDays) timingAnom++;
      }
      const pd = row.Device ? DEVICE[row.Device] : undefined;
      if (pd && r.uaDevice) { devN++; if (pd !== r.uaDevice) devMis++; }
    } else {
      const pd = r.g.device ? DEVICE[r.g.device] : undefined;
      if (pd && r.uaDevice) { devN++; if (pd !== r.uaDevice) devMis++; }
    }

    // Network: platform value when matched, else our {network} param.
    const net = row?.AdNetworkType || (r.g.network ? `vt:${r.g.network}` : null);
    if (net) {
      netN++; inc(networkMix, net);
      if ((row?.AdNetworkType && cfg.google.riskyNetworkTypes.includes(row.AdNetworkType)) ||
          (!row?.AdNetworkType && r.g.network && cfg.google.riskyNetworkParams.includes(r.g.network))) risky++;
    }
    const plc = row?.Placement || r.g.placement;
    if (plc) { plcN++; inc(placementMix, plc); if (isBlockedPlacement(plc, cfg)) blocked++; }
  }

  const n = sample.length;
  const o = (k: GoogleOutcome) => outcomes[k] || 0;
  const matchRate = rateStat(o('matched'), o('matched') + o('unmatched') + o('invalid_click_id'), cfg.z);
  const noClickIdRate = rateStat(o('no_click_id'), n, cfg.z);
  const invalidClickIdRate = rateStat(invalid, n, cfg.z);
  const reusedClickIdRate = rateStat(reused, idsSeen, cfg.z);
  const timingAnomalyRate = rateStat(timingAnom, timingN, cfg.z);
  const deviceMismatchRate = rateStat(devMis, devN, cfg.z);
  const riskyNetworkRate = rateStat(risky, netN, cfg.z);
  const blockedPlacementRate = rateStat(blocked, plcN || n, cfg.z);
  const unlinkedDen = o('matched') + o('unmatched') + o('unlinked_campaign');
  const unlinkedCampaignRate = rateStat(o('unlinked_campaign'), unlinkedDen, cfg.z);
  const gclidEvaluable = o('matched') + o('unmatched') + o('pending') + o('unlinked_campaign') + o('invalid_click_id');
  const pendingShare = gclidEvaluable ? o('pending') / gclidEvaluable : 0;

  // ── Edge-only reasons (no platform data needed) ──
  const autoTagKnownOff = !!data?.accounts.some((a) => a.linked && a.autoTaggingEnabled === false);
  const autoTagSuspected = n >= cfg.minSample && anyId / n < cfg.google.autoTagOffBelow && withTemplate / n > 0.5;
  if (autoTagKnownOff || autoTagSuspected) {
    reasons.push({ code: autoTagKnownOff ? 'autotagging_off' : 'autotagging_off_suspected', severity: 2, edgeOnly: true,
      value: round(anyId / Math.max(1, n)), n,
      message: autoTagKnownOff
        ? 'Google account has auto-tagging disabled: no gclid, so clicks cannot be verified one by one (contract breach). Ratio check still applies.'
        : `only ${round((anyId / Math.max(1, n)) * 100, 2)}% of Google-claimed landings carry a click id although the tracking template is present: auto-tagging looks off.` });
  } else {
    push(highBad('no_click_id', 'Google-claimed landings without gclid/gbraid/wbraid', noClickIdRate, cfg.google.noClickId, cfg, skipped, { edgeOnly: true }));
  }
  push(highBad('invalid_click_id', 'malformed click ids / unexpanded macros', invalidClickIdRate, cfg.invalidClickId, cfg, skipped, { edgeOnly: true, hardAt: cfg.hard.invalidClickIdAbove }));
  push(highBad('reused_click_id', `click ids reused (> ${cfg.maxIpsPerClickId} IPs or > ${cfg.maxHitsPerClickId} hits)`, reusedClickIdRate, cfg.reusedClickId, cfg, skipped, { edgeOnly: true }));
  push(highBad('blocked_placement', 'landings from blocklisted placements', blockedPlacementRate, cfg.blockedPlacement, cfg, skipped, { edgeOnly: true, hardAt: cfg.hard.blockedPlacementAbove }));
  push(highBad('risky_network', 'Search Partners / Display share', riskyNetworkRate, cfg.google.riskyNetwork, cfg, skipped, { edgeOnly: true }));
  const hc = hourCurve(last24h(win, group), tz, cfg);
  push(hc.reason);
  if (n > 0 && braid / n > 0.3) reasons.push({ code: 'ios_braid_share', severity: 0, edgeOnly: true, value: round(braid / n),
    message: `${round((braid / n) * 100, 1)}% of landings carry only gbraid/wbraid (iOS): not matchable per click, covered by the day ratio only` });

  // ── Platform reasons ──
  let ratio: WindowStats['ratio'];
  let status: WindowStatus;
  let freshness: Freshness | null = null;
  if (!data || data.status === 'no_access' || access === 'none') {
    status = 'NO_ACCESS';
  } else if (data.status === 'error') {
    status = 'UNKNOWN';
    reasons.push({ code: 'platform_data_unavailable', severity: 0, message: 'Google import failed: verdict UNKNOWN, breaker holds (grace period)' });
  } else {
    freshness = freshnessOf(data.coveredThrough, data.importedAt, now, pendingShare, cfg);
    status = pendingShare > cfg.freshness.provisionalAbove || !data.coveredThrough ? 'PROVISIONAL' : 'VERDICT';
    if (freshness.stale) reasons.push({ code: 'platform_data_stale', severity: 0, value: freshness.ageHours ?? undefined,
      message: `Google import is ${freshness.ageHours ?? '?'}h old (> ${cfg.freshness.maxStaleMs / 3600_000}h): data may be incomplete` });
    if (status === 'PROVISIONAL') reasons.push({ code: 'data_not_mature', severity: 0, value: round(pendingShare),
      message: `${round(pendingShare * 100, 1)}% of click ids fall after ${data.coveredThrough ?? '(nothing imported)'}: verdict may change when data lands` });

    push(lowBad('low_match_rate', 'gclid match rate', matchRate, cfg.google.matchRate, cfg, skipped, { hardBelow: cfg.hard.matchRateUpperBelow }));
    push(highBad('timing_anomaly', 'landings outside the click time tolerance', timingAnomalyRate, cfg.timingAnomaly, cfg, skipped));
    push(highBad('device_mismatch', 'Google device ≠ browser device', deviceMismatchRate, cfg.google.deviceMismatch, cfg, skipped));
    if (campaignSet) push(highBad('partial_account_access', 'gclids from campaigns outside the linked accounts', unlinkedCampaignRate, cfg.google.unlinkedCampaign, cfg, skipped, { cap: 2 }));
    if (unlinkedCampaignRate.rate !== null && unlinkedCampaignRate.rate > cfg.google.unlinkedCampaign.watch) access = 'partial';

    // Day ratio: all Google-claimed landings of this affiliate on complete days the window touched.
    const days = [...new Set(win.map((r) => localDate(r.ts, tz)))].filter((d) => isComplete(d, data.coveredThrough)).sort();
    const daySet = new Set(days);
    const ours = group.filter((r) => daySet.has(localDate(r.ts, tz))).length;
    const platform = data.clicks.filter((c) => daySet.has(c.Date)).length;
    const rr = ratioRules('google', ours, platform, cfg.google.ratioHigh, cfg.google.ratioLowWatch, cfg, skipped, 'clicks');
    ratio = { ours, platform, value: rr.value === null || !Number.isFinite(rr.value) ? rr.value : round(rr.value, 4), days, metric: 'clicks' };
    reasons.push(...rr.reasons);
  }

  if (access === 'none') reasons.push({ code: 'no_partner_access', severity: sevOf(cfg.accessFloor.none), edgeOnly: true,
    message: 'no read access to the affiliate\'s Google Ads account: provenance cannot be verified (trust floor)' });
  else if (data && data.accounts.some((a) => !a.linked)) reasons.push({ code: 'unlinked_accounts', severity: sevOf(cfg.accessFloor.partial), edgeOnly: true,
    message: `${data!.accounts.filter((a) => !a.linked).length} of ${data!.accounts.length} Google accounts not linked` });

  if (skipped.length) reasons.push({ code: 'insufficient_sample', severity: 0, message: `skipped (too few to judge): ${[...new Set(skipped)].join(', ')}` });

  return {
    status, reasons, freshness, access,
    stats: {
      requests: win.length, sampled: n, outcomes,
      matchRate, noClickIdRate, braidShare: n ? round(braid / n) : 0, invalidClickIdRate, reusedClickIdRate,
      timingAnomalyRate, deviceMismatchRate, riskyNetworkRate, blockedPlacementRate, unlinkedCampaignRate,
      ratio, networkMix, placementMix: top(placementMix, 10), hourCurveEntropy: hc.entropy,
    },
  };

  function push(r: Reason | null) { if (r) reasons.push(r); }
}

export const sevOf = (t: 'OK' | 'WATCH' | 'THROTTLE' | 'BLOCK') => (({ OK: 0, WATCH: 1, THROTTLE: 2, BLOCK: 3 } as const)[t]);

export function top(m: Record<string, number>, k: number): Record<string, number> {
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k));
}
