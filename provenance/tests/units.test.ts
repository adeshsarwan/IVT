// Unit tests: helpers, normalization, sampling, windows, rules, breaker, KV plan.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWindow, buildWindows, decide, DEFAULT_CONFIG, fnv1a, initialBreaker, inSample, isPlausibleClickId, kvPlan,
  localDate, makeConfig, manualReset, normalizeAll, normalizeRequest, wilson,
} from '../src/index';
import { highBad, lowBad, ratioRules, buildReuseIndex, isReused, isBlockedPlacement, hourCurve } from '../src/rules';
import { dayDiff, normEntropy, rateStat } from '../src/util';
import type { NormalizedRequest, RawRequest } from '../src/types';

const cfg = makeConfig({ routes: { 'r-g': 'google', 'r-m': 'meta' } });
const GCLID = 'Cj0KCQiA' + 'a'.repeat(84);
const FBCLID = 'IwAR' + 'b'.repeat(56);
const T0 = Date.parse('2026-11-10T12:00:00Z');
const req = (over: Partial<RawRequest> = {}): RawRequest => ({ id: 'x1', ts: T0, site: 's.com', aff: '42', route: 'r-g', url: `https://s.com/?gclid=${GCLID}`, ...over });
const norm = (over: Partial<RawRequest> = {}) => normalizeRequest(req(over), cfg)!;

describe('util', () => {
  it('fnv1a is stable', () => {
    assert.equal(fnv1a(''), 0x811c9dc5);
    assert.equal(fnv1a('abc'), fnv1a('abc'));
    assert.notEqual(fnv1a('abc'), fnv1a('abd'));
  });

  it('Wilson interval matches known values and handles edges', () => {
    const [lo, hi] = wilson(95, 100);
    assert.ok(Math.abs(lo - 0.8882) < 0.001 && Math.abs(hi - 0.9785) < 0.001, `${lo} ${hi}`);
    assert.deepEqual(wilson(0, 0), [0, 1]);
    const [lo0, hi0] = wilson(0, 50);
    assert.equal(lo0, 0); assert.ok(hi0 > 0.05 && hi0 < 0.08);
    const [lo1, hi1] = wilson(50, 50);
    assert.equal(hi1, 1); assert.ok(lo1 > 0.92);
  });

  it('Wilson narrows with n (5k ≈ ±1.4%, 10k ≈ ±1.0% at p=0.5)', () => {
    const w5 = wilson(2500, 5000), w10 = wilson(5000, 10000);
    assert.ok(Math.abs((w5[1] - w5[0]) / 2 - 0.0139) < 0.0005);
    assert.ok(Math.abs((w10[1] - w10[0]) / 2 - 0.0098) < 0.0005);
  });

  it('rateStat with n=0 has no rate', () => {
    assert.deepEqual(rateStat(0, 0), { k: 0, n: 0, rate: null, ci: null });
  });

  it('localDate uses the account time zone (day boundary)', () => {
    const ms = Date.parse('2026-11-10T03:30:00Z');
    assert.equal(localDate(ms, 'UTC'), '2026-11-10');
    assert.equal(localDate(ms, 'America/New_York'), '2026-11-09');
    assert.equal(localDate(ms, 'Asia/Kolkata'), '2026-11-10');
  });

  it('dayDiff and normEntropy', () => {
    assert.equal(dayDiff('2026-11-10', '2026-11-12'), 2);
    assert.equal(dayDiff('2026-11-10', '2026-11-09'), -1);
    assert.equal(normEntropy(new Array(24).fill(5)), 1);
    assert.equal(normEntropy([0, 0]), null);
    assert.ok(normEntropy([10, 0, 0, 0])! < 0.01);
  });
});

describe('deterministic sampling', () => {
  it('same id + salt → same decision; rate ≈ requested', () => {
    let k = 0;
    for (let i = 0; i < 20000; i++) {
      const a = inSample(`id-${i}`, 'salt', 0.1);
      assert.equal(a, inSample(`id-${i}`, 'salt', 0.1));
      if (a) k++;
    }
    assert.ok(k > 1800 && k < 2200, `got ${k}`);
  });

  it('rate 1 samples everything; salt changes the subset', () => {
    assert.ok(inSample('anything', 's', 1));
    const a = Array.from({ length: 200 }, (_, i) => inSample(`i${i}`, 'a', 0.5));
    const b = Array.from({ length: 200 }, (_, i) => inSample(`i${i}`, 'b', 0.5));
    assert.notDeepEqual(a, b);
  });

  it('config validates sampleRate and windowSize', () => {
    assert.throws(() => makeConfig({ sampleRate: 0 }));
    assert.throws(() => makeConfig({ windowSize: 0 }));
    assert.equal(makeConfig({ windowSize: 10000 }).windowSize, 10000);
    assert.equal(makeConfig().google.matchRate.block, DEFAULT_CONFIG.google.matchRate.block);
  });
});

describe('normalize', () => {
  it('parses Google ValueTrack params (short and raw names)', () => {
    const a = norm({ url: `https://s.com/?gclid=${GCLID}&cid=111&ag=222&cr=333&kw=shoes&net=g&dev=m&plc=&mt=e` });
    assert.equal(a.g.campaignId, '111'); assert.equal(a.g.adGroupId, '222'); assert.equal(a.g.creative, '333');
    assert.equal(a.g.keyword, 'shoes'); assert.equal(a.g.network, 'g'); assert.equal(a.g.device, 'm'); assert.equal(a.g.placement, null);
    const b = norm({ url: `https://s.com/?gclid=${GCLID}&campaignid=9&adgroupid=8&network=s&device=c&placement=example.com` });
    assert.equal(b.g.campaignId, '9'); assert.equal(b.g.network, 's'); assert.equal(b.g.placement, 'example.com');
  });

  it('parses Meta params', () => {
    const m = norm({ route: 'r-m', url: `https://s.com/?fbclid=${FBCLID}&campaign_id=5&adset_id=6&ad_id=7&site_source_name=ig&placement=Instagram_Stories` });
    assert.equal(m.claimed, 'meta'); assert.equal(m.inferred, 'meta');
    assert.deepEqual(m.m, { campaignId: '5', adsetId: '6', adId: '7', siteSource: 'ig', placement: 'Instagram_Stories' });
  });

  it('claim precedence: route > src > utm > click id', () => {
    assert.equal(norm({ route: 'r-g', url: `https://s.com/?fbclid=${FBCLID}&utm_source=facebook` }).claimSource, 'route');
    assert.equal(norm({ route: 'r-g', url: `https://s.com/?fbclid=${FBCLID}` }).claimed, 'google');
    assert.equal(norm({ route: null, url: `https://s.com/?src=meta&utm_source=google` }).claimed, 'meta');
    assert.equal(norm({ route: null, url: `https://s.com/?utm_source=Instagram` }).claimed, 'meta');
    const c = norm({ route: 'unmapped', url: `https://s.com/?wbraid=abc` });
    assert.equal(c.claimed, 'google'); assert.equal(c.claimSource, 'click_id');
    const u = norm({ route: null, url: 'https://s.com/' });
    assert.equal(u.claimed, 'unknown'); assert.equal(u.claimSource, 'none');
  });

  it('detects unexpanded macros ({gclid}, {{ad.id}}, %7B)', () => {
    assert.deepEqual(norm({ url: 'https://s.com/?gclid={gclid}&cid={campaignid}' }).unexpandedMacros.sort(), ['cid', 'gclid']);
    assert.deepEqual(norm({ route: 'r-m', url: 'https://s.com/?ad_id={{ad.id}}' }).unexpandedMacros, ['ad_id']);
    assert.deepEqual(norm({ params: { gclid: '%7Bgclid%7D' }, url: undefined }).unexpandedMacros, ['gclid']);
    assert.deepEqual(norm().unexpandedMacros, []);
  });

  it('params object overrides URL; aff null → (none); bad rows are dropped', () => {
    const a = norm({ params: { cid: 'p' }, url: 'https://s.com/?cid=u' });
    assert.equal(a.g.campaignId, 'p');
    assert.equal(norm({ aff: null }).aff, '(none)');
    assert.equal(normalizeRequest(req({ ts: 'not a date' }), cfg), null);
    assert.equal(normalizeRequest(req({ id: '' }), cfg), null);
    assert.equal(norm({ url: 'http://[bad' }).gclid, null);
  });

  it('epoch strings and numbers are accepted', () => {
    assert.equal(norm({ ts: String(T0) }).ts, T0);
    assert.equal(norm({ ts: new Date(T0).toISOString() }).ts, T0);
  });

  it('normalizeAll sorts, drops duplicate ids and invalid rows', () => {
    const r = normalizeAll([req({ id: 'b', ts: T0 + 2 }), req({ id: 'a', ts: T0 + 1 }), req({ id: 'b', ts: T0 + 3 }), req({ id: 'c', ts: 'x' })], cfg);
    assert.deepEqual(r.requests.map((x) => x.id), ['a', 'b']);
    assert.equal(r.duplicatesDropped, 1);
    assert.equal(r.invalidDropped, 1);
  });

  it('click id plausibility rejects junk', () => {
    assert.ok(isPlausibleClickId(GCLID));
    assert.ok(isPlausibleClickId(FBCLID));
    for (const bad of [null, '', 'test', 'null', 'abc123', '{gclid}', 'a'.repeat(600), 'x'.repeat(25) + ' y', 'Cj0K<script>aaaaaaaaaaaaaaaa'])
      assert.equal(isPlausibleClickId(bad as any), false, String(bad));
  });
});

describe('windows', () => {
  const mk = (n: number, stepMs: number, aff = '42', route = 'r-g'): NormalizedRequest[] =>
    normalizeAll(Array.from({ length: n }, (_, i) => req({ id: `${aff}-${route}-${i}`, ts: T0 + i * stepMs, aff, route })), cfg).requests;

  it('closes every N requests (5,000 default; 10,000 supported)', () => {
    const r = mk(12000, 1000);
    const w5 = buildWindows(r, cfg, T0 + 1e9);
    assert.deepEqual(w5.map((w) => [w.requests.length, w.closedBy]), [[5000, 'count'], [5000, 'count'], [2000, 'time']]);
    const w10 = buildWindows(r, makeConfig({ windowSize: 10000 }), T0 + 12000 * 1000 + 1);
    assert.deepEqual(w10.map((w) => [w.requests.length, w.closedBy]), [[10000, 'count'], [2000, 'open']]);
  });

  it('closes on time T even below N', () => {
    const r = mk(100, 3600_000); // one per hour
    const w = buildWindows(r, cfg, T0 + 100 * 3600_000);
    assert.equal(w[0].requests.length, 24);
    assert.equal(w[0].closedBy, 'time');
  });

  it('last window is OPEN until N or T is reached', () => {
    const w = buildWindows(mk(10, 1000), cfg, T0 + 60_000);
    assert.equal(w.length, 1); assert.equal(w[0].closedBy, 'open');
  });

  it('separates affiliate × source and orders keys deterministically', () => {
    const r = normalizeAll([...mk(3, 1, '7', 'r-g'), ...mk(3, 1, '7', 'r-m'), ...mk(3, 1, '1', 'r-g')].map((x) => ({ id: x.id, ts: x.ts, site: 's', aff: x.aff, route: x.route })), cfg).requests;
    assert.deepEqual(buildWindows(r, cfg, T0).map((w) => w.key), ['1|google', '7|google', '7|meta']);
  });
});

describe('rules', () => {
  const skipped: string[] = [];
  it('highBad: watch on point, throttle/block on Wilson lower bound', () => {
    const t = { watch: 0.05, throttle: 0.15, block: 0.4 };
    assert.equal(highBad('x', 'x', rateStat(10, 1000), t, cfg, skipped), null);
    assert.equal(highBad('x', 'x', rateStat(80, 1000), t, cfg, skipped)!.severity, 1);
    assert.equal(highBad('x', 'x', rateStat(200, 1000), t, cfg, skipped)!.severity, 2);
    assert.equal(highBad('x', 'x', rateStat(500, 1000), t, cfg, skipped)!.severity, 3);
    // Point 0.16 but CI low < 0.15 → only WATCH (not confident enough to throttle)
    assert.equal(highBad('x', 'x', rateStat(33, 205), t, cfg, skipped)!.severity, 1);
  });

  it('highBad: below minSample is skipped, cap and hard work', () => {
    const s: string[] = [];
    assert.equal(highBad('tiny', 'x', rateStat(50, 100), { watch: 0, throttle: 0, block: 0 }, cfg, s), null);
    assert.deepEqual(s, ['tiny']);
    assert.equal(highBad('c', 'x', rateStat(900, 1000), { watch: 0.1, throttle: 0.2, block: 0.3 }, cfg, s, { cap: 2 })!.severity, 2);
    assert.equal(highBad('h', 'x', rateStat(900, 1000), { watch: 0.1, throttle: 0.2, block: 0.3 }, cfg, s, { hardAt: 0.5 })!.hard, true);
  });

  it('lowBad: match-rate tiers use the upper bound', () => {
    const t = cfg.google.matchRate;
    assert.equal(lowBad('m', 'm', rateStat(990, 1000), t, cfg, skipped), null);
    assert.equal(lowBad('m', 'm', rateStat(930, 1000), t, cfg, skipped)!.severity, 1);
    assert.equal(lowBad('m', 'm', rateStat(850, 1000), t, cfg, skipped)!.severity, 2);
    const b = lowBad('m', 'm', rateStat(300, 1000), t, cfg, skipped, { hardBelow: 0.5 })!;
    assert.equal(b.severity, 3); assert.equal(b.hard, true);
    assert.equal(lowBad('m', 'm', rateStat(600, 1000), t, cfg, skipped, { hardBelow: 0.5 })!.hard, false);
  });

  it('ratio: high tiers, low watch, zero platform, volume guard', () => {
    const t = cfg.google.ratioHigh;
    const r = (o: number, p: number) => ratioRules('google', o, p, t, 0.5, cfg, [], 'clicks').reasons;
    assert.deepEqual(r(1000, 1000), []);
    assert.equal(r(1100, 1000)[0].severity, 1);
    assert.equal(r(1300, 1000)[0].severity, 2);
    assert.equal(r(1600, 1000)[0].severity, 3); assert.equal(r(1600, 1000)[0].hard, false);
    assert.equal(r(2500, 1000)[0].hard, true);
    assert.equal(r(400, 1000)[0].code, 'clicks_not_landing');
    assert.equal(r(500, 0)[0].code, 'platform_reports_zero_clicks');
    assert.deepEqual(r(50, 0), []);
    assert.deepEqual(r(90, 40), []); // both below minRatioClicks
  });

  it('reuse index: distinct IPs and hits', () => {
    const rs = normalizeAll([
      req({ id: '1', ipHash: 'a' }), req({ id: '2', ipHash: 'a' }), req({ id: '3', ipHash: 'b' }),
      req({ id: '4', ipHash: 'c', url: `https://s.com/?gclid=${GCLID.replace('a', 'z')}` }),
    ], cfg).requests;
    const idx = buildReuseIndex(rs);
    assert.equal(isReused(GCLID, idx, cfg), false); // 2 IPs, 3 hits: allowed
    rs.push({ ...rs[0], id: '5', ipHash: 'd' });
    assert.equal(isReused(GCLID, buildReuseIndex(rs), cfg), true); // 3 IPs
    assert.equal(isReused(null, idx, cfg), false);
  });

  it('placement blocklist is case-insensitive substring', () => {
    assert.ok(isBlockedPlacement('FreePORN-site.example', cfg));
    assert.ok(isBlockedPlacement('mobileapp::2-com.game', cfg));
    assert.ok(!isBlockedPlacement('news.example', cfg));
    assert.ok(!isBlockedPlacement(null, cfg));
  });

  it('hour curve: flat 24/7 flagged, human curve not, short span ignored', () => {
    const flat = normalizeAll(Array.from({ length: 2400 }, (_, i) => req({ id: `f${i}`, ts: T0 + i * 36_000 })), cfg).requests;
    assert.equal(hourCurve(flat, 'UTC', cfg).reason?.code, 'flat_hour_curve');
    const human = normalizeAll(Array.from({ length: 2400 }, (_, i) => req({ id: `h${i}`, ts: T0 + (i % 100 < 80 ? (i % 8) + 12 : i % 24) * 3600_000 + (i % 60) * 1000 })), cfg).requests;
    assert.equal(hourCurve(human, 'UTC', cfg).reason, null);
    assert.equal(hourCurve(flat.slice(0, 500), 'UTC', cfg).entropy, null);
  });

  it('decide: worst severity; UNKNOWN/NO_ACCESS only count edge-only reasons', () => {
    const rs = [{ code: 'a', severity: 3 as const, message: '' }, { code: 'b', severity: 1 as const, edgeOnly: true, message: '' }];
    assert.deepEqual(decide('VERDICT', rs), { severity: 3, hard: false });
    assert.deepEqual(decide('UNKNOWN', rs), { severity: 1, hard: false });
    assert.deepEqual(decide('NO_ACCESS', rs), { severity: 1, hard: false });
    assert.deepEqual(decide('VERDICT', [{ code: 'h', severity: 3, hard: true, message: '' }]), { severity: 3, hard: true });
  });
});

describe('circuit breaker (hysteresis)', () => {
  const W = (severity: 0 | 1 | 2 | 3, status: any = 'VERDICT', hard = false, start = 0, end = 0) => ({ severity, status, hard, start, end });
  const run = (ws: ReturnType<typeof W>[], c = cfg, s = initialBreaker()) => ws.reduce((st, w) => applyWindow(st, w, c).state, s);

  it('escalates WATCH/THROTTLE immediately', () => {
    assert.equal(run([W(1)]).tier, 'WATCH');
    assert.equal(run([W(2)]).tier, 'THROTTLE');
  });

  it('non-hard BLOCK needs confirmation; hard BLOCK is immediate', () => {
    assert.equal(run([W(3)]).tier, 'THROTTLE');
    assert.equal(run([W(3), W(3)]).tier, 'BLOCK');
    assert.equal(run([W(3), W(0), W(3)]).tier, 'THROTTLE'); // streak broken
    assert.equal(run([W(3, 'VERDICT', true)]).tier, 'BLOCK');
  });

  it('recovers one tier per recoverWindows better windows', () => {
    let s = run([W(2)]);
    s = run([W(0), W(0)], cfg, s); assert.equal(s.tier, 'THROTTLE');
    s = run([W(0)], cfg, s); assert.equal(s.tier, 'WATCH');
    s = run([W(0), W(0), W(0)], cfg, s); assert.equal(s.tier, 'OK');
  });

  it('a same-tier window resets the recovery streak', () => {
    const s = run([W(2), W(0), W(0), W(2), W(0), W(0)]);
    assert.equal(s.tier, 'THROTTLE');
  });

  it('BLOCK is held for manual unblock (default) or recovers when allowed', () => {
    const s = run([W(3, 'VERDICT', true), W(0), W(0), W(0), W(0)]);
    assert.equal(s.tier, 'BLOCK'); assert.equal(s.awaitingManualUnblock, true);
    assert.equal(manualReset(s).tier, 'WATCH');
    const auto = makeConfig({ breaker: { manualUnblock: false } });
    assert.equal(run([W(3, 'VERDICT', true), W(0), W(0), W(0)], auto).tier, 'THROTTLE');
  });

  it('NO_VERDICT and OPEN hold; UNKNOWN holds within grace then THROTTLEs', () => {
    assert.equal(run([W(2), W(0, 'NO_VERDICT'), W(0, 'OPEN'), W(0, 'NO_VERDICT')]).tier, 'THROTTLE');
    const H = 3600_000;
    assert.equal(run([W(0, 'UNKNOWN', false, 0, 10 * H)]).tier, 'OK');
    assert.equal(run([W(0, 'UNKNOWN', false, 0, 10 * H), W(0, 'UNKNOWN', false, 10 * H, 49 * H)]).tier, 'THROTTLE');
    // A good decided window clears the UNKNOWN clock
    const s = run([W(0, 'UNKNOWN', false, 0, 10 * H), W(0, 'VERDICT', false, 10 * H, 20 * H)]);
    assert.equal(s.unknownSince, null);
  });

  it('UNKNOWN windows still escalate on edge-only evidence', () => {
    assert.equal(run([W(2, 'UNKNOWN', false, 0, 1)]).tier, 'THROTTLE');
  });
});

describe('KV plan (Ad Pass kill switch)', () => {
  it('maps tiers to ads:aff:<id>', () => {
    assert.deepEqual(kvPlan('42', 'BLOCK')[0], { op: 'put', key: 'ads:aff:42', value: 'off', note: kvPlan('42', 'BLOCK')[0].note });
    assert.equal(kvPlan('42', 'THROTTLE')[1].key, 'adcap:aff:42');
    assert.equal(kvPlan('42', 'WATCH')[0].op, 'none');
    assert.equal(kvPlan('42', 'OK')[0].op, 'none');
    assert.equal(kvPlan('(none)', 'BLOCK')[0].op, 'none');
  });
});
