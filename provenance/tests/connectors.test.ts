// Connectors (CSV, e-mail/sheet exports, signed Ads Script pushes, API JSON), anti-tamper checks,
// connector trust floors and the fleet helpers (scheduler, isolation, status, spot audits).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScenario, googleClicksFromCsv, googleDailyFromCsv, googleFromScriptPushes, hmacB64, ingestFleet, makeConfig, metaFromApi, metaFromCsv,
  parseCsv, parseDay, partnerStatus, planSyncJobs, recordSync, runFleet, runProvenance, signingString, spotAuditPlan, strengthByAffiliate,
  verifyScriptPush, type ConnectorConfig, type PushKey, type ScriptPush, evaluateGoogle, evaluateMeta, normalizeAll,
} from '../src/index';
import { toGoogleClickCsv, toScriptPushes } from '../src/scenarios';
import type { GoogleClickRow, MetaInsightRow, RawRequest } from '../src/types';

const TZ = 'America/New_York';
const gbase = (type: any = 'csv_upload') => ({ timeZone: TZ, accounts: [{ customerId: '111', linked: true }], connector: { type, id: 'c1' } });
const mbase = (type: any = 'csv_upload') => ({ timeZone: TZ, accounts: [{ id: 'act_1', linked: true }], connector: { type, id: 'm1' } });
const gid = (i: number) => `Cj0KCQiA${String(i).padStart(6, '0')}${'x'.repeat(70)}`;

describe('CSV parsing', () => {
  it('handles quotes, escaped quotes, CRLF, BOM and tabs', () => {
    assert.deepEqual(parseCsv('﻿a,"b,c","d ""q"""\r\n1,2,3\r\n'), [['a', 'b,c', 'd "q"'], ['1', '2', '3']]);
    assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('a,b\n\n1,2\n'), [['a', 'b'], ['1', '2']]);
  });

  it('parses unambiguous day formats only', () => {
    assert.equal(parseDay('2026-11-10'), '2026-11-10');
    assert.equal(parseDay('2026/1/5'), '2026-01-05');
    assert.equal(parseDay('20261110'), '2026-11-10');
    assert.equal(parseDay('Nov 10, 2026'), '2026-11-10');
    assert.equal(parseDay('10 November 2026'), '2026-11-10');
    assert.equal(parseDay('11/10/2026'), null); // ambiguous M/D vs D/M
    assert.equal(parseDay('yesterday'), null);
  });
});

describe('Google connectors', () => {
  it('click CSV: skips title rows and totals, maps UI labels to API enums', () => {
    const csv = ['Click report', '"Nov 1, 2026 - Nov 2, 2026"', 'GCLID,Day,Campaign ID,Ad group ID,Device,Network',
      `${gid(1)},2026-11-10,111,2,Mobile phones,Google search`, `${gid(2)},"Nov 10, 2026",111,2,Computers,Search partners`,
      ',2026-11-10,111,2,Computers,Display Network', 'Total: account,,,,,'].join('\n');
    const r = googleClicksFromCsv(csv, gbase());
    assert.equal(r.data.status, 'ok');
    assert.equal(r.rowsAccepted, 2); assert.equal(r.rowsRejected, 1);
    assert.deepEqual(r.data.clicks.map((c) => [c.Device, c.AdNetworkType]), [['MOBILE', 'SEARCH'], ['DESKTOP', 'SEARCH_PARTNERS']]);
    assert.equal(r.data.coveredThrough, '2026-11-10');
    assert.equal(r.data.connector!.type, 'csv_upload');
  });

  it('click CSV without required columns → status error', () => {
    const r = googleClicksFromCsv('Day,Clicks\n2026-11-10,5', gbase());
    assert.equal(r.data.status, 'error');
    assert.match(r.issues[0], /GCLID/);
  });

  it('daily (aggregate) CSV: thousands separators, "--", totals', () => {
    const r = googleDailyFromCsv('Day,Campaign ID,Network (with search partners),Clicks\n2026-11-10,111,Google search,"1,204"\n2026-11-10,111,Display Network,--\nTotal: account,,,1204', gbase('email_report'));
    assert.deepEqual(r.data.dailyClicks!.map((d) => [d.Clicks, d.AdNetworkType]), [[1204, 'SEARCH'], [0, 'CONTENT']]);
    assert.equal(r.data.clicks.length, 0);
  });

  it('round-trips the scenario CSV writer', () => {
    const rows: GoogleClickRow[] = [{ GclId: gid(7), Date: '2026-11-10', CampaignId: '111', AdGroupId: '9', Device: 'TABLET', AdNetworkType: 'CONTENT' }];
    const back = googleClicksFromCsv(toGoogleClickCsv(rows), gbase()).data.clicks[0];
    assert.deepEqual([back.GclId, back.Device, back.AdNetworkType, back.CampaignId], [gid(7), 'TABLET', 'CONTENT', '111']);
  });
});

describe('Signed Google Ads Script push', () => {
  const keys: Record<string, PushKey> = { k1: { secret: 's3cret-key-for-42-xxxxxxxxxxxxxxxx', aff: '42', customerIds: ['1234567890'] }, k2: { secret: 'old', aff: '42', revoked: true } };
  const now = Date.parse('2026-11-12T12:00:00Z');
  const body = JSON.stringify({ v: 1, kind: 'google_click_view', aff: '42', customerId: '123-456-7890', timeZone: TZ, date: '2026-11-10', batch: 1, batches: 1, generatedAt: '2026-11-12T11:00:00Z', rows: [{ gclid: gid(1), campaignId: '111' }] });
  const sign = async (b: string, ts = String(now), nonce = 'nonce-abcdefghijklmnop', kid = 'k1', secret = keys.k1.secret) =>
    ({ 'X-TPS-Key': kid, 'X-TPS-Ts': ts, 'X-TPS-Nonce': nonce, 'X-TPS-Signature': await hmacB64(secret, signingString(kid, ts, nonce, b)) });
  const fresh = () => { const s = new Set<string>(); return (k: string, n: string) => { const key = `${k}|${n}`; if (s.has(key)) return true; s.add(key); return false; }; };

  it('accepts a correctly signed push and binds it to the key\'s affiliate', async () => {
    const v = await verifyScriptPush(body, await sign(body), keys, now, fresh());
    assert.equal(v.ok, true);
    if (v.ok) { assert.equal(v.aff, '42'); assert.equal(v.push.rows.length, 1); }
  });

  it('rejects tampering, skew, replay, revoked/unknown keys, wrong affiliate/customer', async () => {
    const seen = fresh();
    const h = await sign(body);
    assert.equal((await verifyScriptPush(body, h, keys, now, seen)).ok, true);
    assert.deepEqual(await verifyScriptPush(body, h, keys, now, seen), { ok: false, error: 'replayed nonce' });
    assert.deepEqual(await verifyScriptPush(body.replace('111', '112'), await sign(body), keys, now, fresh()), { ok: false, error: 'bad signature' });
    assert.deepEqual(await verifyScriptPush(body, await sign(body, String(now - 10 * 60_000)), keys, now, fresh()), { ok: false, error: 'timestamp outside allowed skew' });
    assert.deepEqual(await verifyScriptPush(body, await sign(body, String(now), 'nonce-abcdefghijklmnop', 'k2', 'old'), keys, now, fresh()), { ok: false, error: 'unknown or revoked key' });
    assert.deepEqual(await verifyScriptPush(body, {}, keys, now, fresh()), { ok: false, error: 'missing signature headers' });
    const other = body.replace('"aff":"42"', '"aff":"43"');
    assert.deepEqual(await verifyScriptPush(other, await sign(other), keys, now, fresh()), { ok: false, error: 'payload affiliate does not match key' });
    const cust = body.replace('123-456-7890', '999');
    assert.deepEqual(await verifyScriptPush(cust, await sign(cust), keys, now, fresh()), { ok: false, error: 'customer id not registered for this key' });
  });

  it('assembles batches; coveredThrough stops at an incomplete or missing day; re-runs replace', () => {
    const clicks = (date: string, n: number, from = 0): GoogleClickRow[] => Array.from({ length: n }, (_, i) => ({ GclId: gid(from + i), Date: date, CampaignId: '111' }));
    const p = [...toScriptPushes(clicks('2026-11-09', 5), '42', '1', 2), ...toScriptPushes(clicks('2026-11-10', 5, 100), '42', '1', 2)];
    const full = googleFromScriptPushes(p, { timeZone: TZ, accounts: [], connector: { type: 'ads_script_push' } });
    assert.equal(full.data.coveredThrough, '2026-11-10');
    assert.equal(full.data.clicks.length, 10);
    const missing = googleFromScriptPushes(p.filter((x) => !(x.date === '2026-11-10' && x.batch === 2)), { timeZone: TZ, accounts: [], connector: { type: 'ads_script_push' } });
    assert.equal(missing.data.coveredThrough, '2026-11-09');
    assert.match(missing.issues.join(), /2\/3 batches/);
    const gap = googleFromScriptPushes([...toScriptPushes(clicks('2026-11-07', 1), '42', '1'), ...toScriptPushes(clicks('2026-11-09', 1, 50), '42', '1')], { timeZone: TZ, accounts: [], connector: { type: 'ads_script_push' } });
    assert.equal(gap.data.coveredThrough, '2026-11-07');
    const rerun: ScriptPush[] = [...p, { ...p[0], generatedAt: '2099-01-01T00:00:00Z', rows: [] }];
    assert.equal(googleFromScriptPushes(rerun, { timeZone: TZ, accounts: [], connector: { type: 'ads_script_push' } }).data.clicks.length, 8);
  });

  it('auto-tagging reported off by the script is carried into accounts', () => {
    const p = toScriptPushes([{ GclId: gid(1), Date: '2026-11-10', CampaignId: '1' }], '42', '1').map((x) => ({ ...x, autoTaggingEnabled: false }));
    const d = googleFromScriptPushes(p, { timeZone: TZ, accounts: [{ customerId: '1', linked: true }], connector: { type: 'ads_script_push' } }).data;
    assert.equal(d.accounts[0].autoTaggingEnabled, false);
  });
});

describe('Meta connectors', () => {
  it('Ads Manager CSV export', () => {
    const csv = 'Day,Campaign ID,Ad set ID,Ad ID,Platform,Placement,Clicks (all),Link clicks,Landing page views\n2026-11-10,5,55,600,Audience Network,classic,40,30,10\n2026-11-10,5,55,601,Instagram,stories,"1,200",900,850\nbad,,,,,,,,';
    const r = metaFromCsv(csv, mbase());
    assert.equal(r.rowsAccepted, 2); assert.equal(r.rowsRejected, 1);
    assert.deepEqual(r.data.insights.map((x) => [x.publisher_platform, x.clicks, x.inline_link_clicks]), [['audience_network', 40, 30], ['instagram', 1200, 900]]);
  });

  it('Graph API JSON (our token or a partner-made token)', () => {
    const r = metaFromApi({ data: [{ ad_id: '600', campaign_id: '5', date_start: '2026-11-10', clicks: '50', inline_link_clicks: '40', publisher_platform: 'facebook', actions: [{ action_type: 'landing_page_view', value: '35' }] }, { date_start: 'x' }] },
      { ...mbase('api_partner_token'), coveredThrough: '2026-11-10' });
    assert.equal(r.data.insights[0].landing_page_views, 35);
    assert.equal(r.rowsRejected, 1);
    assert.equal(r.data.coveredThrough, '2026-11-10');
  });

  it('CSV without required columns → error', () => {
    assert.equal(metaFromCsv('Day,Reach\n2026-11-10,5', mbase()).data.status, 'error');
  });
});

describe('anti-tamper and connector trust', () => {
  const cfg = makeConfig({ minSample: 20, minWindowRequests: 20, minRatioClicks: 10, routes: { 'r-g': 'google', 'r-m': 'meta' }, connectors: { mirrorMinClicks: 50 } });
  const NOW = Date.parse('2026-11-12T15:00:00Z');
  const req = (i: number, p: Record<string, string> = {}): RawRequest => ({ id: `g${i}`, ts: Date.parse('2026-11-10T15:00:00Z') + i * 60_000, site: 's', aff: '42', route: 'r-g',
    params: { gclid: gid(i), cid: '111', net: 'g', ...p }, ipHash: `ip${i}`, uaDevice: 'mobile' });
  const rows = (n: number, over: (i: number) => Partial<GoogleClickRow> = () => ({})): GoogleClickRow[] =>
    Array.from({ length: n }, (_, i) => ({ GclId: gid(i), Date: '2026-11-10', CampaignId: '111', AdNetworkType: 'SEARCH', Device: 'MOBILE', ...over(i) }));
  const g = (clicks: GoogleClickRow[], type?: any) => ({ status: 'ok' as const, timeZone: TZ, accounts: [{ customerId: '1', linked: true }], coveredThrough: '2026-11-11', importedAt: NOW - 3600_000, clicks, ...(type ? { connector: { type } } : {}) });
  const N = (r: RawRequest[]) => normalizeAll(r, cfg).requests;
  const codes = (rs: { code: string; severity: number }[]) => rs.filter((r) => r.severity > 0).map((r) => r.code);

  it('connector floors: API/script OK, CSV/e-mail/sheet WATCH', () => {
    const reqs = N(Array.from({ length: 100 }, (_, i) => req(i)));
    const all = [...rows(100), ...rows(5).map((r, i) => ({ ...r, GclId: gid(900 + i) }))];
    assert.deepEqual(codes(evaluateGoogle(reqs, reqs, g(all), cfg, NOW).reasons), []);
    assert.deepEqual(codes(evaluateGoogle(reqs, reqs, g(all, 'ads_script_push'), cfg, NOW).reasons), []);
    for (const t of ['csv_upload', 'email_report', 'sheet_export']) {
      const r = evaluateGoogle(reqs, reqs, g(all, t), cfg, NOW).reasons.find((x) => x.code === 'connector_trust_floor')!;
      assert.equal(r.severity, 1, t);
    }
  });

  it('mirror check: a partner list with no clicks that never landed is suspicious (partner sources only)', () => {
    const reqs = N(Array.from({ length: 100 }, (_, i) => req(i)));
    assert.ok(codes(evaluateGoogle(reqs, reqs, g(rows(100), 'csv_upload'), cfg, NOW).reasons).includes('report_mirrors_landings'));
    assert.ok(!codes(evaluateGoogle(reqs, reqs, g(rows(100)), cfg, NOW).reasons).includes('report_mirrors_landings')); // API: impossible to fake
  });

  it('malformed, duplicate and future-dated rows in a partner report', () => {
    const reqs = N(Array.from({ length: 100 }, (_, i) => req(i)));
    const bad = [...rows(100), ...rows(10).map((r) => ({ ...r })), ...rows(10).map((r, i) => ({ ...r, GclId: `test${i}` })), ...rows(3).map((r, i) => ({ ...r, GclId: gid(500 + i), Date: '2026-12-01' }))];
    const c = codes(evaluateGoogle(reqs, reqs, g(bad, 'csv_upload'), cfg, NOW).reasons);
    assert.ok(c.includes('report_invalid_click_ids') && c.includes('report_duplicate_click_ids') && c.includes('report_future_dates'), c.join());
  });

  it('platform row vs our ValueTrack params: network / campaign mismatch', () => {
    const reqs = N(Array.from({ length: 100 }, (_, i) => req(i, i < 30 ? { net: 'd' } : i < 40 ? { cid: '222' } : {})));
    const ev = evaluateGoogle(reqs, reqs, g(rows(100)), cfg, NOW);
    assert.equal(ev.stats.paramMismatchRate!.k, 40);
    assert.ok(codes(ev.reasons).includes('platform_param_mismatch'));
  });

  it('aggregate-only Google data: no click matching, ratio + reported network mix still work', () => {
    const reqs = N(Array.from({ length: 100 }, (_, i) => req(i)));
    const data = { ...g([], 'email_report'), dailyClicks: [{ Date: '2026-11-10', Clicks: 40, AdNetworkType: 'SEARCH' }, { Date: '2026-11-10', Clicks: 20, AdNetworkType: 'CONTENT' }] };
    const ev = evaluateGoogle(reqs, reqs, data, cfg, NOW);
    assert.equal(ev.stats.clickLevel, false);
    assert.equal(ev.stats.outcomes.aggregate_only, 100);
    assert.equal(ev.stats.matchRate!.n, 0);
    assert.equal(ev.stats.ratio!.platform, 60);
    const c = codes(ev.reasons);
    assert.ok(c.includes('click_level_unavailable') && c.includes('landings_exceed_clicks') && c.includes('risky_network_reported'), c.join());
  });

  it('Meta report invariants and mirror', () => {
    const mreq = (i: number, ad: string): RawRequest => ({ id: `m${i}`, ts: Date.parse('2026-11-10T15:00:00Z') + i * 1000, site: 's', aff: '7', route: 'r-m', params: { fbclid: `IwAR${String(i).padStart(6, '0')}${'y'.repeat(50)}`, ad_id: ad } });
    const reqs = N(Array.from({ length: 150 }, (_, i) => mreq(i, `60${i % 6}`)));
    const mirror: MetaInsightRow[] = Array.from({ length: 6 }, (_, a) => ({ campaign_id: '5', ad_id: `60${a}`, date_start: '2026-11-10', clicks: 10, inline_link_clicks: 25 }));
    const data = { status: 'ok' as const, timeZone: TZ, accounts: [{ id: 'a', linked: true }], coveredThrough: '2026-11-11', importedAt: NOW, insights: mirror, connector: { type: 'csv_upload' as const } };
    const c = codes(evaluateMeta(reqs, reqs, data, cfg, NOW).reasons);
    assert.ok(c.includes('report_inconsistent') && c.includes('report_mirrors_landings'), c.join());
    // Same rows from our own API pull: no tamper reasons (can't be edited)
    assert.ok(!codes(evaluateMeta(reqs, reqs, { ...data, connector: { type: 'api_partner_token' as const } }, cfg, NOW).reasons).includes('report_inconsistent'));
  });
});

describe('connector scenarios end to end', () => {
  const run = (id: any) => { const s = buildScenario(id); return runProvenance(s.input, s.config); };
  it('script push clean → OK', () => assert.equal(run('script_push_clean').affiliates[0].tier, 'OK'));
  it('fabricated CSV → THROTTLE via mirror', () => {
    const r = run('csv_fabricated');
    assert.equal(r.affiliates[0].tier, 'THROTTLE');
    assert.ok(r.windows[0].reasons.some((x) => x.code === 'report_mirrors_landings'));
  });
  it('aggregate e-mailed report with injection → BLOCK', () => assert.equal(run('google_aggregate_csv').affiliates[0].tier, 'BLOCK'));
  it('edited Meta export → THROTTLE', () => assert.equal(run('meta_csv_edited').affiliates[0].tier, 'THROTTLE'));
});

describe('fleet (100+ partners)', () => {
  const H = 3600_000;
  const now = Date.parse('2026-11-12T12:00:00Z');
  const conn = (id: string, type: any, platform: 'google' | 'meta' = 'google', aff = id): ConnectorConfig => ({ id, aff, platform, type, accountIds: ['1'], timeZone: TZ });

  it('scheduler: pull connectors only, first runs, intervals, backoff, parking, per-platform limits', () => {
    const cs = [conn('a', 'api_mcc'), conn('b', 'api_mcc'), conn('c', 'csv_upload'), conn('d', 'api_partner_token', 'meta'), conn('e', 'api_mcc'), conn('f', 'api_mcc')];
    const st = {
      b: { lastAttemptAt: now - H, lastSuccessAt: now - H, consecutiveFailures: 0 },            // not due (6h)
      e: { lastAttemptAt: now - 20 * 60_000, consecutiveFailures: 2 },                          // retry after 10 min backoff
      f: { lastAttemptAt: now - H, consecutiveFailures: 9 },                                    // parked
    };
    const p = planSyncJobs(cs, st, now);
    assert.deepEqual(p.jobs.map((j) => j.connectorId).sort(), ['a', 'd', 'e']);
    assert.deepEqual(p.parked, ['f']);
    assert.equal(p.jobs.find((j) => j.connectorId === 'e')!.kind, 'retry');
    const limited = planSyncJobs(cs, st, now, { perPlatform: { google: 1, meta: 5 } });
    assert.equal(limited.jobs.filter((j) => j.platform === 'google').length, 1);
    assert.equal(limited.deferred.length, 1);
    assert.deepEqual(planSyncJobs(cs, st, now), p); // deterministic
  });

  it('jitter spreads 100 partners over the window', () => {
    const cs = Array.from({ length: 100 }, (_, i) => conn(`p${i}`, 'api_mcc'));
    const st = Object.fromEntries(cs.map((c) => [c.id, { lastAttemptAt: now - 6 * H, consecutiveFailures: 0 }]));
    const due = planSyncJobs(cs, st, now + 15 * 60_000, { maxJobs: 1000, perPlatform: { google: 1000, meta: 0 } }).jobs.map((j) => j.dueAt);
    assert.equal(due.length, 100);
    assert.ok(new Set(due.map((d) => Math.floor(d / 60_000))).size >= 12); // spread across the 15-min jitter window
  });

  it('recordSync: success resets failures, failure increments', () => {
    let s = recordSync(undefined, now, { ok: false, error: 'x' });
    s = recordSync(s, now + 1, { ok: false, error: 'y' });
    assert.equal(s.consecutiveFailures, 2);
    s = recordSync(s, now + 2, { ok: true, coveredThrough: '2026-11-11' });
    assert.deepEqual([s.consecutiveFailures, s.lastSuccessAt, s.coveredThrough, s.lastError], [0, now + 2, '2026-11-11', null]);
  });

  it('ingest isolates a broken partner file and prefers the strongest connector', () => {
    const cs = [conn('g-a-csv', 'csv_upload', 'google', 'a'), conn('g-a-api', 'api_mcc', 'google', 'a'), conn('g-b', 'csv_upload', 'google', 'b'), conn('m-c', 'csv_upload', 'meta', 'c')];
    const out = ingestFleet(cs, [
      { connectorId: 'g-a-csv', kind: 'google_click_csv', text: `GCLID,Day,Campaign ID\n${gid(1)},2026-11-10,1` },
      { connectorId: 'g-a-api', kind: 'google_api', data: { status: 'ok', timeZone: TZ, accounts: [], clicks: [], coveredThrough: '2026-11-09' } },
      { connectorId: 'g-b', kind: 'google_click_csv', text: 'garbage' },
      { connectorId: 'm-c', kind: 'meta_csv', text: 'Day,Ad ID,Link clicks\n2026-11-10,600,5' },
      { connectorId: 'nope', kind: 'meta_csv', text: '' },
    ]);
    assert.equal(out.chosen['a|google'], 'g-a-api');
    assert.equal(out.platform.b.google!.status, 'error');
    assert.equal(out.platform.c.meta!.insights.length, 1);
    assert.ok(out.issues.nope && out.issues['g-b']);
  });

  it('runFleet: one affiliate job failing does not affect others and keeps its last breaker', () => {
    const s = buildScenario('clean');
    const prev = { '13|google': { tier: 'BLOCK' as const, blockStreak: 0, cleanStreak: 0, unknownSince: null, awaitingManualUnblock: false } };
    const f = runFleet({ ...s.input, requests: [...s.input.requests, { id: 'x', ts: s.input.now, site: 's', aff: '13' }], previous: prev }, s.config, (aff) => { if (aff === '13') throw new Error('boom'); });
    assert.deepEqual(f.failed, { '13': 'boom' });
    assert.equal(f.breakers['13|google'].tier, 'BLOCK');
    assert.equal(f.affiliates.find((a) => a.aff === '42')!.tier, 'OK');
    // Per-affiliate jobs give the same verdicts as one big run.
    const single = runProvenance(s.input, s.config);
    assert.deepEqual(runFleet(s.input, s.config).affiliates, single.affiliates);
  });

  it('partner status: health states and tiers', () => {
    const cs = [conn('ok', 'api_mcc'), conn('late', 'api_mcc'), conn('fail', 'api_mcc'), conn('park', 'csv_upload'), conn('new', 'ads_script_push'), { ...conn('off', 'api_mcc'), enabled: false }];
    const st = { ok: { lastSuccessAt: now - H, consecutiveFailures: 0 }, late: { lastSuccessAt: now - 20 * H, consecutiveFailures: 0 },
      fail: { lastSuccessAt: now - 30 * H, consecutiveFailures: 1, lastError: '401' }, park: { consecutiveFailures: 6 } };
    const rows = partnerStatus(cs, st, [{ aff: 'ok', tier: 'OK', bySource: {}, access: {}, actions: [], notes: [] }], now);
    const h = Object.fromEntries(rows.map((r) => [r.connectorId, r.health]));
    assert.deepEqual(h, { fail: 'failing', late: 'late', new: 'never_synced', off: 'disabled', ok: 'healthy', park: 'parked' });
    assert.equal(rows.find((r) => r.connectorId === 'ok')!.tier, 'OK');
    assert.equal(rows.find((r) => r.connectorId === 'park')!.auditRate, 0.25);
  });

  it('spot audits: deterministic, weaker sources audited more, unconnected always', () => {
    const affs = Array.from({ length: 1000 }, (_, i) => ({ aff: `a${i}`, strength: (['strong', 'medium', 'weak'] as const)[i % 3] }));
    const pick = spotAuditPlan(affs, '2026-W47', 'salt');
    assert.deepEqual(pick, spotAuditPlan(affs, '2026-W47', 'salt'));
    assert.notDeepEqual(pick, spotAuditPlan(affs, '2026-W48', 'salt'));
    const share = (s: string) => pick.filter((a) => affs[Number(a.slice(1))].strength === s).length / 333;
    assert.ok(share('strong') < 0.06 && share('weak') > 0.15 && share('medium') > share('strong'));
    assert.deepEqual(spotAuditPlan([{ aff: 'x', strength: 'none' }], 'w', 's'), ['x']);
    assert.deepEqual(strengthByAffiliate([conn('g', 'api_mcc', 'google', 'z'), conn('m', 'csv_upload', 'meta', 'z')], ['z', 'y']), [{ aff: 'z', strength: 'weak' }, { aff: 'y', strength: 'none' }]);
  });

  it('fleet_100 scenario: bad partners caught, no-access throttled, failing connectors hold', () => {
    const s = buildScenario('fleet_100');
    const f = runFleet(s.input, s.config);
    const t = Object.fromEntries(f.affiliates.map((a) => [a.aff, a.tier]));
    for (const bad of ['p023', 'p046', 'p069', 'p031', 'p062']) assert.equal(t[bad], 'BLOCK', bad);
    for (const na of ['p037', 'p074']) assert.equal(t[na], 'THROTTLE', na);
    assert.equal(t.p001, 'OK');
    assert.equal(f.affiliates.length, 100);
    assert.deepEqual(f.failed, {});
  });
});
