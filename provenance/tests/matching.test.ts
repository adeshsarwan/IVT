// Google click-level matching and Meta aggregate reconciliation, on small hand-built fixtures.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGoogle, evaluateMeta, makeConfig, normalizeAll, runProvenance } from '../src/index';
import type { GoogleClickRow, GooglePlatformData, MetaInsightRow, MetaPlatformData, RawRequest } from '../src/types';

// Small thresholds so fixtures stay readable.
const cfg = makeConfig({ minSample: 20, minWindowRequests: 20, minRatioClicks: 10, routes: { 'r-g': 'google', 'r-m': 'meta' } });
const TZ = 'America/New_York';
const D10 = Date.parse('2026-11-10T15:00:00Z'); // 10:00 NY on 2026-11-10
const NOW = Date.parse('2026-11-12T15:00:00Z');
const gid = (i: number) => `Cj0KCQiA${String(i).padStart(6, '0')}${'x'.repeat(70)}`;
const fid = (i: number) => `IwAR${String(i).padStart(6, '0')}${'y'.repeat(50)}`;

function gReq(i: number, p: Record<string, string> = {}, over: Partial<RawRequest> = {}): RawRequest {
  const params: Record<string, string> = { gclid: gid(i), cid: '111', net: 'g', dev: 'm', ...p };
  for (const k of Object.keys(params)) if (params[k] === '') delete params[k];
  return { id: `g${i}`, ts: D10 + i * 60_000, site: 's.com', aff: '42', route: 'r-g', params, ipHash: `ip${i}`, uaDevice: 'mobile', ...over };
}
const click = (i: number, over: Partial<GoogleClickRow> = {}): GoogleClickRow =>
  ({ GclId: gid(i), CampaignId: '111', Date: '2026-11-10', Device: 'MOBILE', AdNetworkType: 'SEARCH', ClickType: 'URL_CLICKS', ...over });
const gData = (clicks: GoogleClickRow[], over: Partial<GooglePlatformData> = {}): GooglePlatformData =>
  ({ status: 'ok', timeZone: TZ, accounts: [{ customerId: '1', linked: true, autoTaggingEnabled: true }], coveredThrough: '2026-11-11', importedAt: NOW - 3600_000, clicks, ...over });
const N = (raws: RawRequest[]) => normalizeAll(raws, cfg).requests;
const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => i + from);
const codes = (rs: { code: string; severity: number }[]) => rs.filter((r) => r.severity > 0).map((r) => r.code).sort();

describe('Google matching', () => {
  it('all gclids found → match 100%, no reasons', () => {
    const reqs = N(range(100).map((i) => gReq(i)));
    const ev = evaluateGoogle(reqs, reqs, gData(range(100).map((i) => click(i))), cfg, NOW);
    assert.equal(ev.status, 'VERDICT');
    assert.equal(ev.stats.matchRate!.rate, 1);
    assert.deepEqual(codes(ev.reasons), []);
  });

  it('unknown gclids lower the match rate', () => {
    const reqs = N(range(100).map((i) => gReq(i)));
    const ev = evaluateGoogle(reqs, reqs, gData(range(60).map((i) => click(i)).concat(range(40, 1000).map((i) => click(i)))), cfg, NOW);
    assert.equal(ev.stats.outcomes.unmatched, 40);
    assert.ok(codes(ev.reasons).includes('low_match_rate'));
  });

  it('time tolerance: date diff 0..1 day OK, earlier or later = timing anomaly', () => {
    const reqs = N(range(100).map((i) => gReq(i)));
    const clicks = range(100).map((i) => click(i, { Date: i < 50 ? '2026-11-10' : i < 70 ? '2026-11-09' : i < 85 ? '2026-11-11' : '2026-11-07' }));
    const ev = evaluateGoogle(reqs, reqs, gData(clicks), cfg, NOW);
    // 2026-11-09 → +1 day OK; 2026-11-11 → landing before click; 2026-11-07 → 3 days late
    assert.equal(ev.stats.timingAnomalyRate!.k, 30);
    assert.ok(codes(ev.reasons).includes('timing_anomaly'));
  });

  it('exact click timestamps: skew and max delay', () => {
    const reqs = N(range(100).map((i) => gReq(i)));
    const clicks = range(100).map((i) => click(i, { ClickTimestamp: D10 + i * 60_000 - (i < 80 ? 5_000 : i < 90 ? -600_000 : 3 * 3600_000) }));
    const ev = evaluateGoogle(reqs, reqs, gData(clicks), cfg, NOW);
    assert.equal(ev.stats.timingAnomalyRate!.k, 20);
  });

  it('pending: requests after coveredThrough are not counted as unmatched', () => {
    const reqs = N(range(100).map((i) => gReq(i, {}, { ts: Date.parse('2026-11-12T14:00:00Z') + i * 1000 })));
    const ev = evaluateGoogle(reqs, reqs, gData([]), cfg, NOW);
    assert.equal(ev.stats.outcomes.pending, 100);
    assert.equal(ev.status, 'PROVISIONAL');
    assert.equal(ev.stats.matchRate!.n, 0);
    assert.ok(!codes(ev.reasons).includes('low_match_rate'));
    assert.ok(ev.reasons.some((r) => r.code === 'data_not_mature'));
  });

  it('timezone boundary: 23:30 NY is still the 10th even though UTC says the 11th', () => {
    const ts = Date.parse('2026-11-11T04:30:00Z'); // 2026-11-10 23:30 NY
    const reqs = N(range(30).map((i) => gReq(i, {}, { ts: ts + i * 1000 })));
    const ev = evaluateGoogle(reqs, reqs, gData(range(30).map((i) => click(i)), { coveredThrough: '2026-11-10' }), cfg, NOW);
    assert.equal(ev.stats.outcomes.matched, 30);
    assert.equal(ev.stats.timingAnomalyRate!.k, 0);
  });

  it('stale import is reported in freshness', () => {
    const reqs = N(range(30).map((i) => gReq(i)));
    const ev = evaluateGoogle(reqs, reqs, gData(range(30).map((i) => click(i)), { importedAt: NOW - 72 * 3600_000 }), cfg, NOW);
    assert.equal(ev.freshness!.stale, true);
    assert.equal(ev.freshness!.ageHours, 72);
    assert.ok(ev.reasons.some((r) => r.code === 'platform_data_stale'));
  });

  it('gbraid/wbraid without gclid are not unmatched and not "no click id"', () => {
    const reqs = N(range(100).map((i) => gReq(i, i < 50 ? { gclid: '', gbraid: `0AAAAA${i}${'q'.repeat(30)}` } : {})));
    const ev = evaluateGoogle(reqs, reqs, gData(range(50, 50).map((i) => click(i)).concat(range(50, 500).map((i) => click(i)))), cfg, NOW);
    assert.equal(ev.stats.outcomes.braid_only, 50);
    assert.equal(ev.stats.matchRate!.rate, 1);
    assert.ok(!codes(ev.reasons).includes('no_click_id'));
    assert.ok(ev.reasons.some((r) => r.code === 'ios_braid_share'));
  });

  it('no click id share (mixed sources) and fbclid on a Google route', () => {
    const reqs = N(range(100).map((i) => gReq(i, i < 50 ? { gclid: '', fbclid: i < 10 ? fid(i) : '' } : {})));
    const ev = evaluateGoogle(reqs, reqs, gData(range(100).map((i) => click(i))), cfg, NOW);
    assert.equal(ev.stats.outcomes.no_click_id, 50);
    assert.ok(codes(ev.reasons).includes('no_click_id'));
  });

  it('auto-tagging off (known) replaces the no-ID reason with THROTTLE', () => {
    const reqs = N(range(100).map((i) => gReq(i, { gclid: '' })));
    const ev = evaluateGoogle(reqs, reqs, gData(range(100).map((i) => click(i)), { accounts: [{ customerId: '1', linked: true, autoTaggingEnabled: false }] }), cfg, NOW);
    const r = ev.reasons.find((x) => x.code === 'autotagging_off')!;
    assert.equal(r.severity, 2);
    assert.ok(!codes(ev.reasons).includes('no_click_id'));
  });

  it('auto-tagging off (suspected): template present, no ids', () => {
    const reqs = N(range(100).map((i) => gReq(i, { gclid: '' })));
    const ev = evaluateGoogle(reqs, reqs, gData(range(100).map((i) => click(i)), { accounts: [{ customerId: '1', linked: true }] }), cfg, NOW);
    assert.ok(codes(ev.reasons).includes('autotagging_off_suspected'));
  });

  it('forged formats and macros count as invalid and unmatched', () => {
    const reqs = N(range(100).map((i) => gReq(i, i < 20 ? { gclid: i % 2 ? '{gclid}' : 'test' } : {})));
    const ev = evaluateGoogle(reqs, reqs, gData(range(100).map((i) => click(i))), cfg, NOW);
    assert.equal(ev.stats.outcomes.invalid_click_id, 20);
    assert.equal(ev.stats.matchRate!.n, 100);
    assert.ok(codes(ev.reasons).includes('invalid_click_id'));
  });

  it('reused gclids across many IPs are flagged', () => {
    const reqs = N(range(100).map((i) => gReq(i, i < 30 ? { gclid: gid(0) } : {})));
    const ev = evaluateGoogle(reqs, reqs, gData(range(100).map((i) => click(i))), cfg, NOW);
    assert.equal(ev.stats.reusedClickIdRate!.k, 30);
    assert.ok(codes(ev.reasons).includes('reused_click_id'));
  });

  it('network mix: Search Partners / Display from platform rows; placement blocklist', () => {
    const reqs = N(range(100).map((i) => gReq(i, i < 40 ? { plc: 'mobileapp::2-com.x' } : {})));
    const ev = evaluateGoogle(reqs, reqs, gData(range(100).map((i) => click(i, { AdNetworkType: i < 40 ? 'CONTENT' : i < 50 ? 'SEARCH_PARTNERS' : 'SEARCH' }))), cfg, NOW);
    assert.equal(ev.stats.riskyNetworkRate!.k, 50);
    assert.equal(ev.stats.networkMix!.CONTENT, 40);
    assert.ok(codes(ev.reasons).includes('risky_network'));
    assert.ok(codes(ev.reasons).includes('blocked_placement'));
  });

  it('device mismatch between Google and the browser', () => {
    const reqs = N(range(100).map((i) => gReq(i, {}, { uaDevice: i < 40 ? 'desktop' : 'mobile' })));
    const ev = evaluateGoogle(reqs, reqs, gData(range(100).map((i) => click(i))), cfg, NOW);
    assert.equal(ev.stats.deviceMismatchRate!.k, 40);
    assert.ok(codes(ev.reasons).includes('device_mismatch'));
  });

  it('day ratio: landings vs clicks on complete days', () => {
    const reqs = N(range(100).map((i) => gReq(i)));
    const ev = evaluateGoogle(reqs, reqs, gData(range(50).map((i) => click(i))), cfg, NOW);
    assert.equal(ev.stats.ratio!.value, 2);
    assert.deepEqual(ev.stats.ratio!.days, ['2026-11-10']);
    assert.ok(ev.reasons.some((r) => r.code === 'landings_exceed_clicks' && r.hard === false && r.severity === 3));
  });

  it('zero platform data (linked, fresh) → hard BLOCK reasons', () => {
    const reqs = N(range(100).map((i) => gReq(i)));
    const ev = evaluateGoogle(reqs, reqs, gData([]), cfg, NOW);
    assert.ok(ev.reasons.some((r) => r.code === 'platform_reports_zero_clicks' && r.hard));
    assert.ok(ev.reasons.some((r) => r.code === 'low_match_rate' && r.hard));
  });

  it('partial accounts: gclids from unlisted campaigns are "unlinked", capped at THROTTLE', () => {
    const reqs = N(range(100).map((i) => gReq(i, i < 40 ? { cid: '999' } : {})));
    const ev = evaluateGoogle(reqs, reqs, gData(range(40, 40).map((i) => click(i)).concat(range(60, 40).map((i) => click(i))), {
      campaignIds: ['111'], accounts: [{ customerId: '1', linked: true }, { customerId: '2', linked: false }] }), cfg, NOW);
    assert.equal(ev.stats.outcomes.unlinked_campaign, 40);
    assert.equal(ev.stats.matchRate!.rate, 1);
    assert.equal(ev.access, 'partial');
    const r = ev.reasons.find((x) => x.code === 'partial_account_access')!;
    assert.equal(r.severity, 2);
    assert.ok(ev.reasons.some((x) => x.code === 'unlinked_accounts'));
  });

  it('no access / missing data / error statuses', () => {
    const reqs = N(range(30).map((i) => gReq(i)));
    assert.equal(evaluateGoogle(reqs, reqs, undefined, cfg, NOW).status, 'NO_ACCESS');
    assert.equal(evaluateGoogle(reqs, reqs, gData([], { status: 'no_access', accounts: [] }), cfg, NOW).status, 'NO_ACCESS');
    assert.equal(evaluateGoogle(reqs, reqs, gData([], { accounts: [{ customerId: '1', linked: false }] }), cfg, NOW).status, 'NO_ACCESS');
    const err = evaluateGoogle(reqs, reqs, gData([], { status: 'error' }), cfg, NOW);
    assert.equal(err.status, 'UNKNOWN');
    assert.equal(err.stats.outcomes.unmatched ?? 0, 0);
  });
});

// ─────────────────────────────── Meta ───────────────────────────────

function mReq(i: number, p: Record<string, string> = {}, over: Partial<RawRequest> = {}): RawRequest {
  const params: Record<string, string> = { fbclid: fid(i), campaign_id: '5', adset_id: '55', ad_id: '600', site_source_name: 'fb', placement: 'Facebook_Mobile_Feed', ...p };
  for (const k of Object.keys(params)) if (params[k] === '') delete params[k];
  return { id: `m${i}`, ts: D10 + i * 60_000, site: 's.com', aff: '77', route: 'r-m', params, ipHash: `ip${i}`, uaDevice: 'mobile', ...over };
}
const ins = (link: number, over: Partial<MetaInsightRow> = {}): MetaInsightRow =>
  ({ campaign_id: '5', adset_id: '55', ad_id: '600', date_start: '2026-11-10', publisher_platform: 'facebook', clicks: Math.round(link * 1.3), inline_link_clicks: link, ...over });
const mData = (rows: MetaInsightRow[], over: Partial<MetaPlatformData> = {}): MetaPlatformData =>
  ({ status: 'ok', timeZone: TZ, accounts: [{ id: 'act_1', linked: true }], coveredThrough: '2026-11-11', importedAt: NOW - 3600_000, insights: rows, ...over });

describe('Meta aggregate reconciliation', () => {
  it('clean: landings slightly below link clicks', () => {
    const reqs = N(range(100).map((i) => mReq(i)));
    const ev = evaluateMeta(reqs, reqs, mData([ins(115)]), cfg, NOW);
    assert.equal(ev.status, 'VERDICT');
    assert.equal(ev.stats.ratio!.platform, 115);
    assert.deepEqual(codes(ev.reasons), []);
  });

  it('landings exceed inline_link_clicks → injection', () => {
    const reqs = N(range(100).map((i) => mReq(i)));
    const ev = evaluateMeta(reqs, reqs, mData([ins(40)]), cfg, NOW);
    assert.ok(ev.reasons.some((r) => r.code === 'landings_exceed_clicks' && r.hard));
    assert.ok(ev.reasons.some((r) => r.code === 'ad_level_inflation'));
    assert.equal(ev.stats.inflatedAds![0].adId, '600');
  });

  it('landing_page_views ratio (pixel) is reported and flagged when exceeded', () => {
    const reqs = N(range(100).map((i) => mReq(i)));
    const ev = evaluateMeta(reqs, reqs, mData([ins(115, { landing_page_views: 50 })]), cfg, NOW);
    assert.equal(ev.stats.lpvRatio!.value, 2);
    assert.ok(codes(ev.reasons).includes('landings_exceed_lpv'));
  });

  it('platform clicks that never land → WATCH', () => {
    const reqs = N(range(100).map((i) => mReq(i)));
    const ev = evaluateMeta(reqs, reqs, mData([ins(1000)]), cfg, NOW);
    assert.ok(ev.reasons.some((r) => r.code === 'clicks_not_landing' && r.severity === 1));
  });

  it('Audience Network share from Insights publisher_platform', () => {
    const reqs = N(range(100).map((i) => mReq(i)));
    const ev = evaluateMeta(reqs, reqs, mData([ins(60), ins(55, { publisher_platform: 'audience_network' })]), cfg, NOW);
    const r = ev.reasons.find((x) => x.code === 'audience_network_share')!;
    assert.equal(r.severity, 2); // 55/115 ≈ 0.48
  });

  it('Audience Network share from our {{site_source_name}} even without platform data', () => {
    const reqs = N(range(100).map((i) => mReq(i, i < 70 ? { site_source_name: 'an', placement: 'an_classic' } : {})));
    const ev = evaluateMeta(reqs, reqs, undefined, cfg, NOW);
    assert.equal(ev.status, 'NO_ACCESS');
    const r = ev.reasons.find((x) => x.code === 'audience_network_share')!;
    assert.equal(r.severity, 3); assert.equal(r.edgeOnly, true);
  });

  it('fbclid: missing, malformed/macro, and reuse', () => {
    const reqs = N(range(100).map((i) => mReq(i, i < 60 ? { fbclid: '' } : i < 70 ? { fbclid: 'abc' } : i < 80 ? { fbclid: fid(999) } : {})));
    const ev = evaluateMeta(reqs, reqs, mData([ins(115)]), cfg, NOW);
    assert.equal(ev.stats.fbclidMissingRate!.k, 60);
    assert.equal(ev.stats.invalidClickIdRate!.k, 10);
    assert.equal(ev.stats.reusedClickIdRate!.k, 20); // fid(999) from 10 IPs + 'abc' from 10 IPs
    assert.ok(codes(ev.reasons).includes('fbclid_missing'));
    const macro = N(range(100).map((i) => mReq(i, i < 30 ? { ad_id: '{{ad.id}}' } : {})));
    assert.ok(codes(evaluateMeta(macro, macro, mData([ins(115)]), cfg, NOW).reasons).includes('invalid_click_id'));
  });

  it('unknown ad ids (partial account or forged params) capped at THROTTLE', () => {
    const reqs = N(range(100).map((i) => mReq(i, i < 50 ? { ad_id: '777' } : {})));
    const ev = evaluateMeta(reqs, reqs, mData([ins(115)]), cfg, NOW);
    const r = ev.reasons.find((x) => x.code === 'unknown_ad_ids')!;
    assert.equal(r.severity, 2);
    assert.equal(ev.access, 'partial');
  });

  it('missing {{ad.id}} params', () => {
    const reqs = N(range(100).map((i) => mReq(i, { ad_id: '' })));
    assert.ok(codes(evaluateMeta(reqs, reqs, mData([ins(115)]), cfg, NOW).reasons).includes('meta_params_missing'));
  });

  it('late data: days after coveredThrough are pending → PROVISIONAL, no ratio', () => {
    const reqs = N(range(100).map((i) => mReq(i, {}, { ts: Date.parse('2026-11-12T14:00:00Z') + i * 1000 })));
    const ev = evaluateMeta(reqs, reqs, mData([ins(10)]), cfg, NOW);
    assert.equal(ev.status, 'PROVISIONAL');
    assert.deepEqual(ev.stats.ratio!.days, []);
    assert.ok(!codes(ev.reasons).includes('landings_exceed_clicks'));
  });

  it('zero Insights rows for a linked account → hard reason', () => {
    const reqs = N(range(100).map((i) => mReq(i)));
    const ev = evaluateMeta(reqs, reqs, mData([]), cfg, NOW);
    assert.ok(ev.reasons.some((r) => r.code === 'platform_reports_zero_clicks' && r.hard));
  });

  it('error status → UNKNOWN; unshared accounts → unlinked_accounts', () => {
    const reqs = N(range(30).map((i) => mReq(i)));
    assert.equal(evaluateMeta(reqs, reqs, mData([], { status: 'error' }), cfg, NOW).status, 'UNKNOWN');
    const p = evaluateMeta(reqs, reqs, mData([ins(35)], { accounts: [{ id: 'a', linked: true }, { id: 'b', linked: false }] }), cfg, NOW);
    assert.equal(p.access, 'partial');
    assert.ok(p.reasons.some((r) => r.code === 'unlinked_accounts'));
  });
});

describe('engine end-to-end on hand fixtures', () => {
  it('duplicates are dropped before windows; small windows get NO_VERDICT', () => {
    const raws = range(10).map((i) => gReq(i));
    const rep = runProvenance({ requests: [...raws, ...raws], now: NOW, platform: { '42': { google: gData(range(10).map((i) => click(i))) } } }, cfg);
    assert.equal(rep.totals.duplicatesDropped, 10);
    assert.equal(rep.windows[0].status, 'NO_VERDICT');
    assert.equal(rep.affiliates[0].tier, 'OK');
  });

  it('unattributed traffic forms its own window with WATCH', () => {
    const raws = range(30).map((i) => ({ id: `u${i}`, ts: D10 + i, site: 's.com', aff: '9', url: 'https://s.com/' }));
    const rep = runProvenance({ requests: raws, now: NOW + 86_400_000 * 3, platform: {} }, cfg);
    assert.equal(rep.windows[0].source, 'unknown');
    assert.equal(rep.windows[0].reasons[0].code, 'unattributed_traffic');
    assert.equal(rep.affiliates[0].tier, 'WATCH');
  });

  it('previous breaker state carries over between runs', () => {
    const prev = { '42|google': { tier: 'BLOCK' as const, blockStreak: 0, cleanStreak: 0, unknownSince: null, awaitingManualUnblock: false } };
    const rep = runProvenance({ requests: [], now: NOW, platform: {}, previous: prev }, cfg);
    assert.equal(rep.affiliates[0].tier, 'BLOCK');
    assert.equal(rep.affiliates[0].actions[0].key, 'ads:aff:42');
  });

  it('requires now', () => {
    assert.throws(() => runProvenance({ requests: [], platform: {}, now: 'nope' }, cfg));
  });
});
