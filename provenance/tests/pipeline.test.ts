// Pipeline: Google Ads client (against the fake API), ClickHouse client encoding, landing rows,
// and — when a local ClickHouse is reachable (CLICKHOUSE_URL) — the full daily job end to end.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { encodeParam, ClickHouse, chTime } from '../pipeline/clickhouse/client';
import { applySchema, dropAll } from '../pipeline/clickhouse/schema';
import { clickViewQuery, dailyClicksQuery, GoogleAdsClient, GoogleAdsError } from '../pipeline/googleAds';
import { fakeGoogleAdsFetch } from '../pipeline/fakeGoogleAds';
import { ingestLandings, landingRow, runDaily, syncAccount } from '../pipeline/job';
import { MemoryStore } from '../pipeline/store';
import { buildLocalFleet, LOCAL_NOW } from '../pipeline/local/fixture';

declare const process: { env: Record<string, string | undefined> };

const clicks = Array.from({ length: 25_000 }, (_, i) => ({ GclId: `Cj0KCQiA${String(i).padStart(30, 'x')}`, CampaignId: i % 2 ? '111' : '112', Date: i < 20_000 ? '2026-11-11' : '2026-11-10', AdNetworkType: i % 10 ? 'SEARCH' : 'CONTENT' }));
const client = (fetch: typeof globalThis.fetch) => new GoogleAdsClient({ developerToken: 'd', clientId: 'c', clientSecret: 's', refreshToken: 'r', loginCustomerId: '999-000-1111' }, { fetch });

describe('Google Ads client (fake API)', () => {
  it('pulls every click of a day across streamed batches, one request', async () => {
    const f = fakeGoogleAdsFetch([{ customerId: '123-456-7890', timeZone: 'America/New_York', clicks }]);
    const g = client(f);
    const rows = await g.clicksForDay('123-456-7890', '2026-11-11');
    assert.equal(rows.length, 20_000);
    assert.equal(g.requests, 1);
    assert.equal(rows[0].customerId, '1234567890');
    assert.ok(f.calls[0].includes('oauth2'));
    assert.ok(f.calls[1].endsWith('/customers/1234567890/googleAds:searchStream'));
  });

  it('daily totals and account info', async () => {
    const g = client(fakeGoogleAdsFetch([{ customerId: '1234567890', timeZone: 'Asia/Kolkata', clicks, autoTagging: false }]));
    const d = await g.dailyClicks('1234567890', '2026-11-10', '2026-11-11');
    assert.equal(d.reduce((a, x) => a + x.clicks, 0), 25_000);
    const info = await g.customer('1234567890');
    assert.deepEqual([info.timeZone, info.autoTaggingEnabled], ['Asia/Kolkata', false]);
  });

  it('revoked access → access error; outage → retryable error', async () => {
    const g = client(fakeGoogleAdsFetch([{ customerId: '1111111111', timeZone: 'UTC', clicks: [], revoked: true }, { customerId: '2222222222', timeZone: 'UTC', clicks: [], failing: true }]));
    await assert.rejects(g.customer('1111111111'), (e: GoogleAdsError) => e.isAccessError && e.status === 403);
    await assert.rejects(g.customer('2222222222'), (e: GoogleAdsError) => !e.isAccessError && e.status === 503);
  });

  it('GAQL builders validate input (no injection through dates / ids)', async () => {
    assert.match(clickViewQuery('2026-11-11'), /FROM click_view WHERE segments\.date = '2026-11-11'$/);
    assert.throws(() => clickViewQuery("2026-11-11' OR '1'='1"));
    assert.throws(() => dailyClicksQuery('2026-11-01', 'x'));
    await assert.rejects(client(fakeGoogleAdsFetch([])).search('12; DROP', 'SELECT 1'));
  });
});

describe('ClickHouse client + landing rows', () => {
  it('encodes params safely', () => {
    assert.equal(encodeParam(["a'b", 'c\\d']), "['a\\'b','c\\\\d']");
    assert.equal(encodeParam(null), '\\N');
    assert.equal(encodeParam(true), '1');
  });
  it('landingRow folds params into the URL and formats ts as UTC', () => {
    const r = landingRow({ id: 'x', ts: Date.parse('2026-11-11T10:00:00.123Z'), site: 's.com', aff: '7', params: { gclid: 'Cj0abc', utm_source: 'google' } });
    assert.equal(r.ts, '2026-11-11 10:00:00.123');
    assert.match(String(r.url), /^https:\/\/s\.com\/\?gclid=Cj0abc&utm_source=google$/);
    assert.equal(chTime(0), '1970-01-01 00:00:00.000');
  });
  it('sends auth headers and server-side params, never values in SQL', async () => {
    let seen: { url: string; headers: Headers; body: string } | null = null;
    const ch = new ClickHouse({ url: 'http://ch.local:8123', database: 'db', user: 'u', password: 'p',
      fetch: (async (u: string, i: RequestInit) => { seen = { url: u, headers: new Headers(i.headers), body: String(i.body) }; return new Response('{"n":1}\n'); }) as any });
    const rows = await ch.query<{ n: number }>('SELECT {x:String} AS n', { x: "evil'); DROP TABLE t; --" });
    assert.deepEqual(rows, [{ n: 1 }]);
    assert.equal(seen!.headers.get('X-ClickHouse-User'), 'u');
    assert.ok(!seen!.body.includes('evil'));
    assert.ok(new URL(seen!.url).searchParams.get('param_x')!.includes('evil'));
  });
});

// ── End to end against a real ClickHouse (skipped unless CLICKHOUSE_URL is set) ──
const CH_URL = process.env.CLICKHOUSE_URL;
describe('daily job on ClickHouse', { skip: !CH_URL && 'set CLICKHOUSE_URL=http://localhost:8123 to run' }, () => {
  const db = process.env.CLICKHOUSE_TEST_DB ?? 'provenance_test';
  const cfg = { url: CH_URL!, user: process.env.CLICKHOUSE_USER ?? 'dev', password: process.env.CLICKHOUSE_PASSWORD ?? 'dev' };
  const ch = new ClickHouse({ ...cfg, database: db });
  const fleet = buildLocalFleet();
  const store = new MemoryStore(fleet.partners);
  let sum: Awaited<ReturnType<typeof runDaily>>;

  before(async () => {
    await new ClickHouse({ ...cfg, database: 'default' }).command(`CREATE DATABASE IF NOT EXISTS ${db}`);
    await dropAll(ch);
    await applySchema(ch);
    await ingestLandings(ch, fleet.landings);
    sum = await runDaily({ ch, store, googleFor: fleet.googleFor, config: fleet.config, now: LOCAL_NOW });
  });

  const run = (aff: string) => sum.runs.find((r) => r.aff === aff)!;
  const rep = (aff: string) => sum.report.find((r) => r.aff === aff)!;

  it('syncs every click; the revoked partner is no_access and isolated', () => {
    assert.equal(sum.accountsSynced, 5);
    assert.equal(run('88').syncs[0].status, 'no_access');
    assert.ok(run('42').syncs[0].clickRows > 9000);
  });

  it('tiers: clean OK, bot farm / placements / forgery / foreign → BLOCK', () => {
    assert.equal(run('42').result!.tier, 'OK');
    for (const a of ['13', '21', '55', '77']) assert.equal(run(a).result!.tier, 'BLOCK', a);
  });

  it('BLOCK is only a review item (manual kill switch)', () => {
    const affs = sum.openReviews.map((r) => r.aff).sort();
    assert.deepEqual(affs, ['13', '21', '55', '77']);
    assert.ok(sum.openReviews.every((r) => r.key === `ads:aff:${r.aff}` && r.value === 'off' && r.status === 'open'));
  });

  it('SQL match report: match rates, foreign gclids, counts, unlanded clicks', () => {
    assert.ok(rep('42').matchRate! > 0.95 && rep('42').unlandedShare! > 0.01);
    assert.ok(rep('13').matchRate! < 0.5 && rep('13').landingsPerClick! > 1.5);
    assert.ok(rep('77').foreign > 900 && rep('77').matched === 0);
    assert.ok(rep('55').malformed > 0);
    assert.equal(rep('88').covered, false);
  });

  it('re-sync is idempotent (no duplicate click rows)', async () => {
    const count = async () => Number((await ch.query<{ n: number }>("SELECT count() AS n FROM google_clicks FINAL WHERE aff = '42'"))[0].n);
    const before = await count();
    await syncAccount({ ch, store, googleFor: fleet.googleFor, now: LOCAL_NOW }, fleet.partners[0], fleet.partners[0].customerIds[0]);
    assert.equal(await count(), before);
  });

  it('next run continues from the cursor (only new landings are read)', async () => {
    const s2 = await runDaily({ ch, store, googleFor: fleet.googleFor, config: fleet.config, now: LOCAL_NOW + 86_400_000 });
    const n42 = s2.runs.find((r) => r.aff === '42')!.result!.landings;
    assert.ok(n42 < 500, `read ${n42}`);
    assert.equal(s2.runs.find((r) => r.aff === '13')!.result!.tier, 'BLOCK');
  });
});
