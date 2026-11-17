// The batch job. Per partner:
//   1. SYNC     pull every click (click_view) for the last N account-local days + Google's daily
//               click totals into ClickHouse. One searchStream request per account-day.
//   2. EVALUATE load this affiliate's new landings, let ClickHouse join them to Google's clicks
//               by gclid, feed the engine, commit only FINAL windows to the breaker.
//   3. REVIEW   a BLOCK becomes a review item (manual kill switch); nothing is written to KV.
// Plus a fleet-wide SQL MATCH REPORT per day (all clicks, all gclids, counts), for dashboards.
//
// Google only for now (Meta later). Runs the same in a Worker (cron + queue) or in Node.

import type { ClickHouse } from './clickhouse/client';
import { chTime } from './clickhouse/client';
import { GoogleAdsError, type GoogleAdsClient } from './googleAds';
import type { BreakerRow, PartnerConfig, ReviewItem, StateStore } from './store';
import { applyWindow, initialBreaker, kvPlan, localDate, makeConfig, runProvenance } from '../src/index';
import type { ConfigOverrides } from '../src/config';
import type { BreakerState, GoogleClickRow, GoogleDailyRow, GooglePlatformData, RawRequest, Tier, WindowResult } from '../src/types';

export interface JobOpts {
  /** Account-local days to (re)sync each run, counting back from yesterday. 2 = yesterday + the day before (late clicks). */
  syncDays: number;
  /** First run for an affiliate: how far back to read landings. */
  initialLookbackMs: number;
  /** Max landings read per affiliate per run; the rest is picked up next run. */
  maxLandings: number;
  /** Partners processed in parallel (Node runner). In Workers each partner is its own queue message. */
  concurrency: number;
}
export const DEFAULT_JOB_OPTS: JobOpts = { syncDays: 2, initialLookbackMs: 3 * 86_400_000, maxLandings: 2_000_000, concurrency: 4 };

export interface JobDeps {
  ch: ClickHouse;
  store: StateStore;
  /** Builds a Google Ads client for a partner (resolves the right refresh token from secrets). */
  googleFor: (p: PartnerConfig) => GoogleAdsClient | Promise<GoogleAdsClient>;
  /** Engine config overrides (routes, thresholds). enforcement.autoBlock stays false. */
  config?: ConfigOverrides;
  now: number;
  log?: (msg: string) => void;
  opts?: Partial<JobOpts>;
}

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const FINAL = new Set(['VERDICT', 'NO_ACCESS', 'UNKNOWN', 'NO_VERDICT']);

// ───────────────────────────── 1. SYNC ─────────────────────────────

export interface AccountSync { aff: string; customerId: string; ok: boolean; status: 'ok' | 'error' | 'no_access'; dates: string[]; clickRows: number; dailyClicks: number; requests: number; error?: string; timeZone?: string }

/** Pull every click for the last `syncDays` complete account-local days, plus daily totals. Idempotent. */
export async function syncAccount(deps: JobDeps, p: PartnerConfig, customerId: string): Promise<AccountSync> {
  const o = { ...DEFAULT_JOB_OPTS, ...deps.opts };
  const g = await deps.googleFor(p);
  const before = g.requests;
  const at = chTime(deps.now);
  let dates: string[] = [];
  try {
    const info = await g.customer(customerId);
    const today = localDate(deps.now, info.timeZone);
    dates = Array.from({ length: o.syncDays }, (_, i) => addDays(today, -(o.syncDays - i)));
    let clickRows = 0;
    for (const date of dates) {
      const rows = await g.clicksForDay(customerId, date);
      // Replace the day: Google can remove clicks later (invalid-click filtering), so stale rows must go.
      await deps.ch.command('DELETE FROM google_clicks WHERE aff = {aff:String} AND customer_id = {cid:String} AND date = {d:Date}', { aff: p.aff, cid: customerId, d: date });
      clickRows += await deps.ch.insert('google_clicks', rows.map((r) => ({
        aff: p.aff, customer_id: customerId, date: r.date || date, gclid: r.gclid, campaign_id: r.campaignId, ad_group_id: r.adGroupId,
        device: r.device, click_type: r.clickType, ad_network_type: r.adNetworkType, imported_at: at,
      })));
    }
    const daily = await g.dailyClicks(customerId, dates[0], dates[dates.length - 1]);
    await deps.ch.command('DELETE FROM google_daily WHERE aff = {aff:String} AND customer_id = {cid:String} AND date >= {a:Date} AND date <= {b:Date}', { aff: p.aff, cid: customerId, a: dates[0], b: dates[dates.length - 1] });
    await deps.ch.insert('google_daily', daily.map((d) => ({ aff: p.aff, customer_id: customerId, date: d.date, campaign_id: d.campaignId, ad_network_type: d.adNetworkType, clicks: d.clicks, imported_at: at })));
    const dailyTotal = daily.reduce((a, d) => a + d.clicks, 0);
    const perDay = (d: string) => daily.filter((x) => x.date === d).reduce((a, x) => a + x.clicks, 0);
    await deps.ch.insert('google_sync', dates.map((d) => ({ aff: p.aff, customer_id: customerId, date: d, status: 'ok', click_rows: 0, daily_clicks: perDay(d), time_zone: info.timeZone, auto_tagging: info.autoTaggingEnabled ? 1 : 0, synced_at: at })));
    return { aff: p.aff, customerId, ok: true, status: 'ok', dates, clickRows, dailyClicks: dailyTotal, requests: g.requests - before, timeZone: info.timeZone };
  } catch (e) {
    const status = e instanceof GoogleAdsError && e.isAccessError ? 'no_access' : 'error';
    const msg = (e as Error).message.slice(0, 500);
    if (!dates.length) dates = [localDate(deps.now - DAY, 'UTC')];
    await deps.ch.insert('google_sync', dates.map((d) => ({ aff: p.aff, customer_id: customerId, date: d, status, click_rows: 0, daily_clicks: 0, time_zone: 'UTC', auto_tagging: 0, error: msg, synced_at: at }))).catch(() => 0);
    deps.log?.(`sync ${p.aff}/${customerId} failed (${status}): ${msg}`);
    return { aff: p.aff, customerId, ok: false, status, dates, clickRows: 0, dailyClicks: 0, requests: g.requests - before, error: msg };
  }
}

// ───────────────────────────── 2. EVALUATE ─────────────────────────────

/** This affiliate's landings after `cursor`, oldest first. */
export async function loadLandings(ch: ClickHouse, aff: string, cursor: number, limit: number): Promise<RawRequest[]> {
  const rows = await ch.query<Record<string, any>>(
    `SELECT id, toUnixTimestamp64Milli(ts) AS ts_ms, site, aff, route, url, ip_hash, ua_hash, ua_device
     FROM landings FINAL
     WHERE aff = {aff:String} AND ts > fromUnixTimestamp64Milli({cursor:Int64})
     ORDER BY ts, id LIMIT {limit:UInt64}`,
    { aff, cursor, limit });
  return rows.map((r) => ({ id: r.id, ts: Number(r.ts_ms), site: r.site, aff: r.aff, route: r.route || null, url: r.url, ipHash: r.ip_hash || undefined, uaHash: r.ua_hash || undefined, uaDevice: (r.ua_device || null) as RawRequest['uaDevice'] }));
}

/** Google data for one affiliate, built by ClickHouse: only the clicks whose gclid we saw (join),
 *  Google's full daily totals (for the count check), and sync coverage. */
export async function loadGoogle(ch: ClickHouse, p: PartnerConfig, cursor: number, maxTs: number, auth: PartnerConfig['auth']): Promise<GooglePlatformData> {
  const sync = await ch.query<Record<string, any>>(
    `SELECT customer_id, toString(date) AS day, status, time_zone, auto_tagging, toUnixTimestamp64Milli(synced_at) AS synced_ms, error
     FROM google_sync FINAL WHERE aff = {aff:String} AND date >= toDate(fromUnixTimestamp64Milli({cursor:Int64})) - 7 ORDER BY customer_id, day`,
    { aff: p.aff, cursor });
  const okRows = sync.filter((r) => r.status === 'ok');
  const tz = okRows[okRows.length - 1]?.time_zone || 'UTC';
  const from = addDays(localDate(cursor, tz), -1);

  const accounts = p.customerIds.map((cid) => {
    const mine = sync.filter((r) => r.customer_id === cid);
    const last = mine[mine.length - 1];
    return { customerId: cid, linked: !!last && last.status === 'ok', autoTaggingEnabled: last?.status === 'ok' ? !!last.auto_tagging : undefined };
  });
  const linked = accounts.filter((a) => a.linked);
  const coveredThrough = linked.length
    ? linked.map((a) => okRows.filter((r) => r.customer_id === a.customerId).map((r) => r.day).sort().pop()!).sort()[0]
    : null;
  const status: GooglePlatformData['status'] = linked.length ? 'ok' : sync.some((r) => r.status === 'error') ? 'error' : 'no_access';

  const joinParams = { aff: p.aff, cursor, maxTs, from };
  const clicks = await ch.query<Record<string, any>>(
    `SELECT gclid, customer_id, campaign_id, ad_group_id, toString(date) AS day, device, click_type, ad_network_type
     FROM google_clicks FINAL
     WHERE aff = {aff:String} AND date >= {from:Date}
       AND gclid IN (SELECT gclid FROM landings WHERE aff = {aff:String} AND gclid != ''
                     AND ts > fromUnixTimestamp64Milli({cursor:Int64}) AND ts <= fromUnixTimestamp64Milli({maxTs:Int64}))`,
    joinParams);
  const daily = await ch.query<Record<string, any>>(
    `SELECT toString(date) AS day, campaign_id, ad_network_type, sum(clicks) AS clicks
     FROM google_daily FINAL WHERE aff = {aff:String} AND date >= {from:Date} GROUP BY day, campaign_id, ad_network_type`,
    joinParams);
  const campaigns = await ch.query<{ campaign_id: string }>(
    `SELECT DISTINCT campaign_id FROM google_daily FINAL WHERE aff = {aff:String} AND date >= today() - 90`, { aff: p.aff });

  return {
    status, timeZone: tz, accounts, coveredThrough,
    importedAt: okRows.length ? Math.max(...okRows.map((r) => Number(r.synced_ms))) : null,
    clicks: clicks.map((c): GoogleClickRow => ({ GclId: c.gclid, CustomerId: c.customer_id, CampaignId: c.campaign_id, AdGroupId: c.ad_group_id || undefined, Date: c.day, Device: c.device || undefined, ClickType: c.click_type || undefined, AdNetworkType: c.ad_network_type || undefined })),
    dailyClicks: daily.map((d): GoogleDailyRow => ({ Date: d.day, CampaignId: d.campaign_id, AdNetworkType: d.ad_network_type || undefined, Clicks: Number(d.clicks) })),
    campaignIds: [...new Set([...campaigns.map((c) => c.campaign_id), ...clicks.map((c) => c.campaign_id)])],
    clickScope: 'joined',
    connector: { type: auth === 'mcc' ? 'api_mcc' : 'api_partner_token', id: `google:${p.aff}` },
  };
}

export interface AffiliateRun {
  aff: string;
  landings: number;
  /** Tier including provisional (not yet final) windows: what we show and review. */
  tier: Tier;
  /** Tier from final windows only: what is stored for the next run. */
  committedTier: Tier;
  committed: BreakerState;
  windows: WindowResult[];
  cursor: number | null;
  review: ReviewItem | null;
  more: boolean;
}

export async function evaluateAffiliate(deps: JobDeps, p: PartnerConfig, prev: BreakerRow | undefined): Promise<AffiliateRun> {
  const o = { ...DEFAULT_JOB_OPTS, ...deps.opts };
  const cfg = makeConfig({ ...deps.config, enforcement: { autoBlock: false } });
  const key = `${p.aff}|google`;
  const cursor = prev?.cursor ?? deps.now - o.initialLookbackMs;
  const requests = await loadLandings(deps.ch, p.aff, cursor, o.maxLandings);
  const more = requests.length >= o.maxLandings;
  const maxTs = requests.length ? (requests[requests.length - 1].ts as number) : deps.now;
  const google = await loadGoogle(deps.ch, p, cursor, maxTs, p.auth);

  const prevState: BreakerState = prev?.state ?? initialBreaker();
  // When the read was capped, pretend "now" is the last row read so the tail window stays open.
  const now = more ? maxTs : deps.now;
  const rep = runProvenance({ requests, platform: { [p.aff]: { google } }, now, previous: { [key]: prevState } }, cfg);
  const windows = rep.windows.filter((w) => w.key === key);

  // Commit only the leading run of FINAL windows; PROVISIONAL / OPEN ones are re-read next run.
  let committed = prevState, newCursor = prev?.cursor ?? null;
  for (const w of windows) {
    if (!FINAL.has(w.status)) break;
    committed = applyWindow(committed, w, cfg).state;
    newCursor = w.end;
  }

  const tier = rep.breakers[key]?.tier ?? prevState.tier;
  let review: ReviewItem | null = null;
  if (tier === 'BLOCK') {
    const suggest = kvPlan(p.aff, 'BLOCK', false)[0];
    const latest = [...windows].reverse().find((w) => w.severity === 3) ?? windows[windows.length - 1];
    review = { aff: p.aff, tier, key: suggest.key, value: suggest.value ?? 'off', createdAt: deps.now, status: 'open',
      reasons: (latest?.reasons ?? []).filter((r) => r.severity > 0).slice(0, 5).map((r) => `${r.code}: ${r.message}`) };
  }
  return { aff: p.aff, landings: requests.length, tier, committedTier: committed.tier, committed, windows, cursor: newCursor, review, more };
}

// ───────────────────────────── 3. MATCH REPORT (SQL only) ─────────────────────────────

export interface MatchRow {
  aff: string; date: string;
  landings: number; withGclid: number; malformed: number; matched: number; foreign: number; notFound: number;
  googleClicks: number; clickRows: number; unlanded: number;
  matchRate: number | null; landingsPerClick: number | null; unlandedShare: number | null; covered: boolean;
}

/** Every gclid of the day vs every Google click of the day, for a set of affiliates in one time zone.
 *  foreign = the gclid is real but belongs to ANOTHER affiliate's account (copied / stolen clicks). */
export async function matchReport(ch: ClickHouse, date: string, tz: string, affs: string[]): Promise<MatchRow[]> {
  if (!affs.length) return [];
  const prm = { d: date, tz, affs };
  const ours = await ch.query<Record<string, any>>(
    `WITH L AS (
       SELECT aff, gclid FROM landings
       WHERE aff IN {affs:Array(String)}
         AND ts >= toDateTime64({d:Date} - 1, 3, 'UTC') AND ts < toDateTime64({d:Date} + 2, 3, 'UTC')
         AND toDate(ts, {tz:String}) = {d:Date}
     ), G AS (
       SELECT gclid, groupUniqArray(aff) AS owners FROM google_clicks FINAL
       WHERE date BETWEEN {d:Date} - 1 AND {d:Date} + 1 AND gclid IN (SELECT gclid FROM L WHERE gclid != '')
       GROUP BY gclid
     )
     SELECT L.aff AS aff, count() AS landings,
       countIf(L.gclid != '') AS with_gclid,
       countIf(L.gclid != '' AND NOT match(L.gclid, '^[A-Za-z0-9_-]{20,512}$')) AS malformed,
       countIf(L.gclid != '' AND has(G.owners, L.aff)) AS matched,
       countIf(L.gclid != '' AND notEmpty(G.owners) AND NOT has(G.owners, L.aff)) AS foreign
     FROM L LEFT JOIN G ON L.gclid = G.gclid
     GROUP BY aff`, prm);
  const theirs = await ch.query<Record<string, any>>(
    `SELECT c.aff AS aff, count() AS click_rows, countIf(l.gclid = '') AS unlanded
     FROM (SELECT aff, gclid FROM google_clicks FINAL WHERE aff IN {affs:Array(String)} AND date = {d:Date}) AS c
     LEFT JOIN (SELECT DISTINCT aff, gclid FROM landings WHERE aff IN {affs:Array(String)} AND gclid != ''
                AND ts >= toDateTime64({d:Date} - 1, 3, 'UTC') AND ts < toDateTime64({d:Date} + 3, 3, 'UTC')) AS l
       ON c.aff = l.aff AND c.gclid = l.gclid
     GROUP BY aff`, prm);
  const totals = await ch.query<Record<string, any>>(
    `SELECT aff, sum(clicks) AS clicks FROM google_daily FINAL WHERE aff IN {affs:Array(String)} AND date = {d:Date} GROUP BY aff`, prm);
  const covered = await ch.query<Record<string, any>>(
    `SELECT aff, min(status = 'ok') AS ok FROM google_sync FINAL WHERE aff IN {affs:Array(String)} AND date = {d:Date} GROUP BY aff`, prm);

  const by = <T extends Record<string, any>>(rows: T[]) => new Map(rows.map((r) => [r.aff as string, r]));
  const O = by(ours), T = by(theirs), S = by(totals), C = by(covered);
  return affs.map((aff) => {
    const o = O.get(aff) ?? {}, t = T.get(aff) ?? {};
    const n = (x: unknown) => Number(x ?? 0);
    const withGclid = n(o.with_gclid), malformed = n(o.malformed), matched = n(o.matched), foreign = n(o.foreign);
    const checkable = withGclid - malformed;
    const googleClicks = n(S.get(aff)?.clicks), clickRows = n(t.click_rows), unlanded = n(t.unlanded);
    return {
      aff, date, landings: n(o.landings), withGclid, malformed, matched, foreign, notFound: Math.max(0, checkable - matched - foreign),
      googleClicks, clickRows, unlanded,
      matchRate: checkable > 0 ? matched / checkable : null,
      landingsPerClick: googleClicks > 0 ? n(o.landings) / googleClicks : null,
      unlandedShare: clickRows > 0 ? unlanded / clickRows : null,
      covered: n(C.get(aff)?.ok) === 1,
    };
  });
}

// ───────────────────────────── ORCHESTRATION ─────────────────────────────

export interface PartnerRun { aff: string; syncs: AccountSync[]; result?: AffiliateRun; error?: string }

/** Sync + evaluate one partner. Never throws: one partner's failure doesn't affect the others.
 *  On evaluation failure the previous breaker state is kept as is. */
export async function runPartner(deps: JobDeps, p: PartnerConfig, prev?: BreakerRow): Promise<PartnerRun> {
  const syncs: AccountSync[] = [];
  for (const cid of p.customerIds) syncs.push(await syncAccount(deps, p, cid));
  try {
    const result = await evaluateAffiliate(deps, p, prev);
    await deps.store.saveWindows(result.windows, deps.now);
    if (result.windows.length) await deps.store.saveBreakers([{ key: `${p.aff}|google`, state: result.committed, cursor: result.cursor }], deps.now);
    if (result.review) await deps.store.upsertReview([result.review]);
    return { aff: p.aff, syncs, result };
  } catch (e) {
    deps.log?.(`evaluate ${p.aff} failed: ${(e as Error).message}`);
    return { aff: p.aff, syncs, error: (e as Error).message };
  }
}

export interface DailySummary {
  at: number;
  partners: number;
  accountsSynced: number;
  accountsFailed: number;
  googleRequests: number;
  runs: PartnerRun[];
  report: MatchRow[];
  openReviews: ReviewItem[];
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/** The whole daily run (Node runner, or a single Worker invocation for small fleets). */
export async function runDaily(deps: JobDeps): Promise<DailySummary> {
  const o = { ...DEFAULT_JOB_OPTS, ...deps.opts };
  const partners = await deps.store.partners();
  const breakers = await deps.store.breakers();
  const runs = await pool(partners, o.concurrency, (p) => runPartner(deps, p, breakers[`${p.aff}|google`]));

  // Fleet match report for "yesterday", grouped by account time zone.
  const byTz = new Map<string, string[]>();
  for (const r of runs) {
    const tz = r.syncs.find((s) => s.timeZone)?.timeZone ?? 'UTC';
    (byTz.get(tz) ?? byTz.set(tz, []).get(tz)!).push(r.aff);
  }
  const report: MatchRow[] = [];
  for (const [tz, affs] of byTz) report.push(...await matchReport(deps.ch, addDays(localDate(deps.now, tz), -1), tz, affs));

  const syncs = runs.flatMap((r) => r.syncs);
  return {
    at: deps.now, partners: partners.length,
    accountsSynced: syncs.filter((s) => s.ok).length, accountsFailed: syncs.filter((s) => !s.ok).length,
    googleRequests: syncs.reduce((a, s) => a + s.requests, 0),
    runs, report: report.sort((a, b) => a.aff.localeCompare(b.aff)), openReviews: await deps.store.openReviews(),
  };
}

// ───────────────────────────── LANDING INGEST ─────────────────────────────

/** Worker side: one landing → one ClickHouse row (gclid is extracted by ClickHouse). */
export function landingRow(r: RawRequest): Record<string, unknown> {
  const ts = typeof r.ts === 'number' ? r.ts : Date.parse(r.ts);
  let url = r.url ?? '';
  if (r.params && Object.keys(r.params).length) {
    const u = new URL(url || `https://${r.site}/`);
    for (const [k, v] of Object.entries(r.params)) u.searchParams.set(k, v);
    url = u.toString();
  }
  return { id: r.id, ts: chTime(ts), site: r.site, aff: r.aff ?? '(none)', route: r.route ?? '', url, ip_hash: r.ipHash ?? '', ua_hash: r.uaHash ?? '', ua_device: r.uaDevice ?? '' };
}

export async function ingestLandings(ch: ClickHouse, rows: RawRequest[]): Promise<number> {
  return ch.insert('landings', rows.map(landingRow), { async: true });
}
