// Meta (Facebook/Instagram) Ads: no click-level export exists, so reconcile in aggregate.
// Our landings per account-local day (and per ad) vs Insights inline_link_clicks /
// landing_page_views, with publisher_platform breakdown for Audience Network share.
// fbclid is presence / format / reuse evidence only — it can't be looked up.

import type { ProvenanceConfig } from './config';
import type { Freshness, MetaPlatformData, NormalizedRequest, Reason, WindowStats, WindowStatus } from './types';
import { buildReuseIndex, highBad, hourCurve, last24h, isBlockedPlacement, isReused, ratioRules, type ReuseIndex } from './rules';
import { freshnessOf, isComplete, sevOf, top, type PlatformEval } from './google';
import { inc, localDate, rateStat, round } from './util';
import { isPlausibleClickId } from './normalize';

const isAN = (r: NormalizedRequest) =>
  (r.m.siteSource || '').toLowerCase() === 'an' || /^an[_\s-]|audience[_ ]?network/i.test(r.m.placement || '');

export function evaluateMeta(
  win: NormalizedRequest[], group: NormalizedRequest[], data: MetaPlatformData | undefined,
  cfg: ProvenanceConfig, now: number, reuse: ReuseIndex = buildReuseIndex(group),
): PlatformEval {
  const reasons: Reason[] = [];
  const skipped: string[] = [];
  const outcomes: Record<string, number> = {};
  const linked = data?.accounts.filter((a) => a.linked) ?? [];
  const usable = !!data && data.status === 'ok' && linked.length > 0;
  const tz = data?.timeZone || 'UTC';
  let access: PlatformEval['access'] = !data || data.status === 'no_access' || (data.status === 'ok' && linked.length === 0) ? 'none'
    : data.accounts.some((a) => !a.linked) ? 'partial' : 'full';

  const knownAds = new Set<string>([...(data?.adIds ?? []), ...(data?.insights ?? []).map((i) => i.ad_id)]);
  const sample = win.filter((r) => r.inSample);
  let missing = 0, invalid = 0, reused = 0, ids = 0, an = 0, ssN = 0, blocked = 0, plcN = 0;
  let adKnown = 0, adUnknown = 0, adMissing = 0, pending = 0;
  const placementMix: Record<string, number> = {};

  for (const r of sample) {
    const macro = r.unexpandedMacros.length > 0;
    if (!r.fbclid) { missing++; inc(outcomes, 'fbclid_missing'); if (macro) invalid++; }
    else {
      ids++;
      if (isReused(r.fbclid, reuse, cfg)) reused++;
      if (!isPlausibleClickId(r.fbclid) || macro) { invalid++; inc(outcomes, 'fbclid_invalid'); }
      else inc(outcomes, 'fbclid_ok');
    }
    if (r.m.siteSource || r.m.placement) { ssN++; if (isAN(r)) an++; }
    const plc = r.m.placement;
    if (plc) { plcN++; inc(placementMix, plc); if (isBlockedPlacement(plc, cfg)) blocked++; }

    if (!r.m.adId) { adMissing++; inc(outcomes, 'ad_param_missing'); }
    else if (!usable || !isComplete(localDate(r.ts, tz), data!.coveredThrough)) { pending++; inc(outcomes, 'pending'); }
    else if (knownAds.has(r.m.adId)) { adKnown++; inc(outcomes, 'ad_known'); }
    else { adUnknown++; inc(outcomes, 'ad_unknown'); }
  }

  const n = sample.length;
  const fbclidMissingRate = rateStat(missing, n, cfg.z);
  const invalidClickIdRate = rateStat(invalid, n, cfg.z);
  const reusedClickIdRate = rateStat(reused, ids, cfg.z);
  const blockedPlacementRate = rateStat(blocked, plcN || n, cfg.z);
  const unknownAdRate = rateStat(adUnknown, adKnown + adUnknown, cfg.z);
  const adParamMissingRate = rateStat(adMissing, n, cfg.z);
  const adEvaluable = adKnown + adUnknown + pending;
  const pendingShare = adEvaluable ? pending / adEvaluable : 0;
  const oursAN = ssN ? an / ssN : null;

  // ── Edge-only ──
  push(highBad('fbclid_missing', 'Meta-claimed landings without fbclid', fbclidMissingRate, cfg.meta.fbclidMissing, cfg, skipped, { edgeOnly: true }));
  push(highBad('invalid_click_id', 'malformed fbclid / unexpanded {{macros}}', invalidClickIdRate, cfg.invalidClickId, cfg, skipped, { edgeOnly: true, hardAt: cfg.hard.invalidClickIdAbove }));
  push(highBad('reused_click_id', `fbclids reused (> ${cfg.maxIpsPerClickId} IPs or > ${cfg.maxHitsPerClickId} hits)`, reusedClickIdRate, cfg.reusedClickId, cfg, skipped, { edgeOnly: true }));
  push(highBad('blocked_placement', 'landings from blocklisted placements', blockedPlacementRate, cfg.blockedPlacement, cfg, skipped, { edgeOnly: true, hardAt: cfg.hard.blockedPlacementAbove }));
  push(highBad('meta_params_missing', 'Meta-claimed landings without {{ad.id}}', adParamMissingRate, cfg.meta.unknownAd, cfg, skipped, { edgeOnly: true, cap: 2 }));
  const hc = hourCurve(last24h(win, group), tz, cfg);
  push(hc.reason);

  let status: WindowStatus;
  let freshness: Freshness | null = null;
  let ratio: WindowStats['ratio'];
  let lpvRatio: WindowStats['lpvRatio'] = null;
  let audienceNetworkShare: number | null = oursAN === null ? null : round(oursAN);
  let inflatedAds: WindowStats['inflatedAds'] = [];

  if (!data || data.status === 'no_access' || access === 'none') {
    status = 'NO_ACCESS';
    if (oursAN !== null && ssN >= cfg.minSample) anRule(oursAN, 'our {{site_source_name}}', true);
  } else if (data.status === 'error') {
    status = 'UNKNOWN';
    reasons.push({ code: 'platform_data_unavailable', severity: 0, message: 'Meta Insights pull failed: verdict UNKNOWN, breaker holds (grace period)' });
    if (oursAN !== null && ssN >= cfg.minSample) anRule(oursAN, 'our {{site_source_name}}', true);
  } else {
    freshness = freshnessOf(data.coveredThrough, data.importedAt, now, pendingShare, cfg);
    const days = [...new Set(win.map((r) => localDate(r.ts, tz)))].filter((d) => isComplete(d, data.coveredThrough)).sort();
    const allDays = new Set(win.map((r) => localDate(r.ts, tz)));
    const dayShare = allDays.size ? days.length / allDays.size : 0;
    status = !data.coveredThrough || (pendingShare > cfg.freshness.provisionalAbove) || (adEvaluable === 0 && dayShare < 0.5) ? 'PROVISIONAL' : 'VERDICT';
    if (freshness.stale) reasons.push({ code: 'platform_data_stale', severity: 0, value: freshness.ageHours ?? undefined,
      message: `Meta Insights pull is ${freshness.ageHours ?? '?'}h old (> ${cfg.freshness.maxStaleMs / 3600_000}h)` });
    if (status === 'PROVISIONAL') reasons.push({ code: 'data_not_mature', severity: 0, value: round(pendingShare),
      message: `window days after ${data.coveredThrough ?? '(nothing imported)'} are not reconciled yet: verdict may change` });

    const daySet = new Set(days);
    const rows = data.insights.filter((i) => daySet.has(i.date_start));
    const ourRows = group.filter((r) => daySet.has(localDate(r.ts, tz)));
    const link = rows.reduce((a, i) => a + (i.inline_link_clicks || 0), 0);
    const lpv = rows.reduce((a, i) => a + (i.landing_page_views || 0), 0);
    const anLink = rows.filter((i) => i.publisher_platform === 'audience_network').reduce((a, i) => a + (i.inline_link_clicks || 0), 0);

    const rr = ratioRules('meta', ourRows.length, link, cfg.meta.ratioHigh, cfg.meta.ratioLowWatch, cfg, skipped, 'inline_link_clicks');
    ratio = { ours: ourRows.length, platform: link, value: rr.value === null || !Number.isFinite(rr.value) ? rr.value : round(rr.value, 4), days, metric: 'inline_link_clicks' };
    reasons.push(...rr.reasons);
    if (lpv > 0) {
      const v = ourRows.length / lpv;
      lpvRatio = { ours: ourRows.length, platform: lpv, value: round(v, 4) };
      if (lpv >= cfg.minRatioClicks && v > cfg.meta.ratioHigh.throttle)
        reasons.push({ code: 'landings_exceed_lpv', severity: 1, value: round(v, 3), threshold: cfg.meta.ratioHigh.throttle,
          message: `landings are ${round(v, 3)}× Meta landing_page_views (pixel): more pages than Meta saw load` });
    }

    // Audience Network: worst of platform share and our param share.
    const platAN = link >= cfg.minRatioClicks ? anLink / link : null;
    const anShare = Math.max(platAN ?? -1, ssN >= cfg.minSample ? (oursAN as number) : -1);
    audienceNetworkShare = anShare < 0 ? null : round(anShare);
    if (anShare >= 0) anRule(anShare, platAN !== null && platAN >= (oursAN ?? 0) ? 'Insights publisher_platform' : 'our {{site_source_name}}', false);

    push(highBad('unknown_ad_ids', '{{ad.id}} values not in the linked accounts', unknownAdRate, cfg.meta.unknownAd, cfg, skipped, { cap: 2 }));
    if (unknownAdRate.rate !== null && unknownAdRate.rate > cfg.meta.unknownAd.watch && access === 'full') access = 'partial';

    // Per-ad inflation
    const oursByAd: Record<string, number> = {};
    for (const r of ourRows) if (r.m.adId) inc(oursByAd, r.m.adId);
    const linkByAd: Record<string, number> = {};
    for (const i of rows) inc(linkByAd, i.ad_id, i.inline_link_clicks || 0);
    inflatedAds = Object.entries(oursByAd)
      .filter(([ad, c]) => linkByAd[ad] !== undefined && c > linkByAd[ad] * cfg.meta.adInflationFactor + cfg.meta.adInflationSlack)
      .map(([adId, c]) => ({ adId, ours: c, linkClicks: linkByAd[adId] }))
      .sort((a, b) => b.ours - b.linkClicks - (a.ours - a.linkClicks) || (a.adId < b.adId ? -1 : 1))
      .slice(0, 10);
    if (inflatedAds.length) reasons.push({ code: 'ad_level_inflation', severity: 1, value: inflatedAds.length,
      message: `${inflatedAds.length} ad(s) have more landings than link clicks × ${cfg.meta.adInflationFactor}: e.g. ad ${inflatedAds[0].adId} ${inflatedAds[0].ours} vs ${inflatedAds[0].linkClicks}` });
  }

  if (access === 'none') reasons.push({ code: 'no_partner_access', severity: sevOf(cfg.accessFloor.none), edgeOnly: true,
    message: 'no partner access to the affiliate\'s Meta ad account: provenance cannot be verified (trust floor)' });
  else if (data && data.accounts.some((a) => !a.linked)) reasons.push({ code: 'unlinked_accounts', severity: sevOf(cfg.accessFloor.partial), edgeOnly: true,
    message: `${data.accounts.filter((a) => !a.linked).length} of ${data.accounts.length} Meta ad accounts not shared` });

  if (skipped.length) reasons.push({ code: 'insufficient_sample', severity: 0, message: `skipped (too few to judge): ${[...new Set(skipped)].join(', ')}` });

  return {
    status, reasons, freshness, access,
    stats: {
      requests: win.length, sampled: n, outcomes,
      fbclidMissingRate, invalidClickIdRate, reusedClickIdRate, blockedPlacementRate, unknownAdRate,
      audienceNetworkShare, ratio, lpvRatio, inflatedAds, placementMix: top(placementMix, 10), hourCurveEntropy: hc.entropy,
    },
  };

  function push(r: Reason | null) { if (r) reasons.push(r); }
  function anRule(share: number, from: string, edgeOnly: boolean) {
    const t = cfg.meta.audienceNetwork;
    const sev = share > t.block ? 3 : share > t.throttle ? 2 : share > t.watch ? 1 : 0;
    if (sev) reasons.push({ code: 'audience_network_share', severity: sev, edgeOnly,
      value: round(share), threshold: sev === 3 ? t.block : sev === 2 ? t.throttle : t.watch,
      message: `Audience Network is ${round(share * 100, 1)}% of Meta clicks (${from}); policy allows FB/IG feeds & stories only` });
  }
}
