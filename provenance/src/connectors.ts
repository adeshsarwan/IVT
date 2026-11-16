// Connectors: many ways in, one shape out.
// Every connector turns its input (CSV export, e-mailed report, Google Ads Script push, API rows)
// into GooglePlatformData / MetaPlatformData. The engine never knows which one was used, except
// through `connector.type`, which sets the trust floor and turns on anti-tamper checks.
// Pure: parsing and verification only; fetching, inboxes and storage live outside.

import type { ConnectorInfo, ConnectorType, GoogleClickRow, GoogleDailyRow, GooglePlatformData, MetaInsightRow, MetaPlatformData } from './types';

// ───────────────────────────── Strength / ranking ─────────────────────────────

export type Strength = 'strong' | 'medium' | 'weak';

/** Ranked easiest → strongest is in README §12; this is the strength of the *data*. */
export const CONNECTOR_STRENGTH: Record<ConnectorType, Strength> = {
  api_mcc: 'strong',
  api_bq_transfer: 'strong',
  api_partner_token: 'strong',
  ads_script_push: 'medium',
  sheet_export: 'weak',
  email_report: 'weak',
  csv_upload: 'weak',
};

/** Does this connector pull on a schedule (we call out) or wait for the partner (push/upload)? */
export const CONNECTOR_MODE: Record<ConnectorType, 'pull' | 'push'> = {
  api_mcc: 'pull', api_bq_transfer: 'pull', api_partner_token: 'pull',
  ads_script_push: 'push', sheet_export: 'pull', email_report: 'push', csv_upload: 'push',
};

export const strengthOf = (c?: ConnectorInfo): Strength => (c ? CONNECTOR_STRENGTH[c.type] : 'strong');

export interface IngestResult<T> {
  data: T;
  /** Human-readable problems (bad rows, unknown columns). Never fatal unless `data.status === 'error'`. */
  issues: string[];
  rowsAccepted: number;
  rowsRejected: number;
}

// ───────────────────────────── CSV ─────────────────────────────

/** RFC 4180-ish CSV/TSV parser: quotes, escaped quotes, CRLF, BOM. Delimiter auto-detected. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const firstLine = t.slice(0, t.indexOf('\n') === -1 ? t.length : t.indexOf('\n'));
  const delim = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Find the header row (exports often start with a title and a date-range line) and map columns. */
function table(rows: string[][], wanted: Record<string, string[]>, required: string[]) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const hdr = rows[i].map(norm);
    const idx: Record<string, number> = {};
    for (const [key, aliases] of Object.entries(wanted)) {
      const j = hdr.findIndex((h) => aliases.includes(h));
      if (j >= 0) idx[key] = j;
    }
    if (required.every((k) => k in idx)) return { idx, body: rows.slice(i + 1) };
  }
  return null;
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** Accepts 2026-11-10, 2026/11/10, 20261110, "Nov 10, 2026", "10 Nov 2026". Rejects ambiguous 11/10/2026. */
export function parseDay(v: string): string | null {
  const s = (v || '').trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.? (\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  return null;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const s = v.replace(/[,\s]/g, '').replace(/^--$/, '0');
  if (s === '') return 0;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};
const isTotal = (r: string[]) => /^total/i.test((r[0] || '').trim()) || r.some((c) => /^total:/i.test(c.trim()));

/** Google UI / API labels → API enum names (UI labels: verify against your export language). */
export const GOOGLE_NETWORK: Record<string, string> = {
  'google search': 'SEARCH', search: 'SEARCH', 'search network': 'SEARCH',
  'search partners': 'SEARCH_PARTNERS', 'search partner': 'SEARCH_PARTNERS', search_partners: 'SEARCH_PARTNERS',
  'display network': 'CONTENT', display: 'CONTENT', content: 'CONTENT', 'google display network': 'CONTENT',
  youtube: 'YOUTUBE_WATCH', 'youtube videos': 'YOUTUBE_WATCH', youtube_watch: 'YOUTUBE_WATCH', youtube_search: 'YOUTUBE_SEARCH', 'youtube search': 'YOUTUBE_SEARCH',
  'cross network': 'MIXED', mixed: 'MIXED',
};
export const GOOGLE_DEVICE: Record<string, string> = {
  'mobile phones': 'MOBILE', mobile: 'MOBILE', computers: 'DESKTOP', desktop: 'DESKTOP', tablets: 'TABLET', tablet: 'TABLET',
  'tv screens': 'CONNECTED_TV', connected_tv: 'CONNECTED_TV', other: 'OTHER',
};
const mapEnum = (m: Record<string, string>, v?: string) => (v ? m[v.trim().toLowerCase()] ?? m[v.trim().toLowerCase().replace(/_/g, ' ')] ?? v.trim().toUpperCase() : undefined);

export interface GoogleBase {
  timeZone: string;
  accounts: GooglePlatformData['accounts'];
  coveredThrough?: string | null;
  importedAt?: string | number | null;
  campaignIds?: string[];
  connector: ConnectorInfo;
}

const lastDay = (days: string[]) => (days.length ? [...days].sort()[days.length - 1] : null);

/** Google click-level CSV (a report with a GCLID column, e.g. from an Ads Script / Sheets export). */
export function googleClicksFromCsv(text: string, base: GoogleBase): IngestResult<GooglePlatformData> {
  const t = table(parseCsv(text), {
    gclid: ['gclid', 'google click id', 'click id', 'click view gclid'],
    date: ['day', 'date', 'segments date'],
    campaign: ['campaign id', 'campaignid', 'campaign id campaign'],
    adgroup: ['ad group id', 'adgroupid'],
    device: ['device', 'segments device'],
    network: ['network', 'network with search partners', 'ad network type', 'segments ad network type'],
    clickType: ['click type', 'segments click type'],
    customer: ['customer id', 'account id'],
  }, ['gclid', 'date', 'campaign']);
  if (!t) return errorResult('no header with GCLID, Day and Campaign ID columns found', base);
  const clicks: GoogleClickRow[] = [];
  const issues: string[] = [];
  let rejected = 0;
  for (const r of t.body) {
    if (isTotal(r)) continue;
    const date = parseDay(r[t.idx.date]);
    const g = (r[t.idx.gclid] || '').trim();
    if (!date || !g) { rejected++; continue; }
    clicks.push({
      GclId: g, Date: date, CampaignId: (r[t.idx.campaign] || '').trim(),
      AdGroupId: t.idx.adgroup !== undefined ? r[t.idx.adgroup]?.trim() : undefined,
      Device: mapEnum(GOOGLE_DEVICE, r[t.idx.device]), AdNetworkType: mapEnum(GOOGLE_NETWORK, r[t.idx.network]),
      ClickType: t.idx.clickType !== undefined ? r[t.idx.clickType]?.trim() : undefined,
      CustomerId: t.idx.customer !== undefined ? r[t.idx.customer]?.replace(/-/g, '').trim() : undefined,
    });
  }
  if (rejected) issues.push(`${rejected} row(s) without a parseable day or gclid were skipped`);
  return {
    data: { status: 'ok', timeZone: base.timeZone, accounts: base.accounts, campaignIds: base.campaignIds, connector: base.connector,
      coveredThrough: base.coveredThrough ?? lastDay(clicks.map((c) => c.Date)), importedAt: base.importedAt ?? null, clicks },
    issues, rowsAccepted: clicks.length, rowsRejected: rejected,
  };
}

/** Google aggregate CSV (standard UI report: Day × Campaign × Network × Device → Clicks). No gclids. */
export function googleDailyFromCsv(text: string, base: GoogleBase): IngestResult<GooglePlatformData> {
  const t = table(parseCsv(text), {
    date: ['day', 'date'],
    campaign: ['campaign id', 'campaignid'],
    clicks: ['clicks'],
    network: ['network', 'network with search partners', 'ad network type'],
    device: ['device'],
  }, ['date', 'clicks']);
  if (!t) return errorResult('no header with Day and Clicks columns found', base);
  const daily: GoogleDailyRow[] = [];
  let rejected = 0;
  for (const r of t.body) {
    if (isTotal(r)) continue;
    const date = parseDay(r[t.idx.date]);
    const clicks = num(r[t.idx.clicks]);
    if (!date || clicks === null || clicks < 0) { rejected++; continue; }
    daily.push({ Date: date, Clicks: clicks, CampaignId: t.idx.campaign !== undefined ? r[t.idx.campaign]?.trim() : undefined,
      AdNetworkType: mapEnum(GOOGLE_NETWORK, r[t.idx.network]), Device: mapEnum(GOOGLE_DEVICE, r[t.idx.device]) });
  }
  return {
    data: { status: 'ok', timeZone: base.timeZone, accounts: base.accounts, campaignIds: base.campaignIds, connector: base.connector,
      coveredThrough: base.coveredThrough ?? lastDay(daily.map((d) => d.Date)), importedAt: base.importedAt ?? null, clicks: [], dailyClicks: daily },
    issues: rejected ? [`${rejected} row(s) skipped (bad day / clicks)`] : [], rowsAccepted: daily.length, rowsRejected: rejected,
  };
}

function errorResult(msg: string, base: GoogleBase): IngestResult<GooglePlatformData> {
  return { data: { status: 'error', timeZone: base.timeZone, accounts: base.accounts, connector: base.connector, clicks: [] }, issues: [msg], rowsAccepted: 0, rowsRejected: 0 };
}

// ───────────────────────────── Google Ads Script push ─────────────────────────────

/** Body the Ads Script (provenance/connectors/google-ads-script.js) POSTs, one per day × batch. */
export interface ScriptPush {
  v: 1;
  kind: 'google_click_view';
  aff: string;
  customerId: string;
  timeZone: string;
  date: string;
  batch: number;
  batches: number;
  autoTaggingEnabled?: boolean;
  generatedAt: string;
  rows: { gclid: string; campaignId: string; adGroupId?: string; device?: string; network?: string; clickType?: string }[];
}

export interface PushKey { secret: string; aff: string; customerIds?: string[]; revoked?: boolean }

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer) => { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); };

export async function hmacB64(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The string both sides sign. Version-prefixed so the format can change safely. */
export const signingString = (keyId: string, ts: string, nonce: string, body: string) => `tps.v1\n${keyId}\n${ts}\n${nonce}\n${body}`;

export type PushVerdict = { ok: true; aff: string; keyId: string; push: ScriptPush } | { ok: false; error: string };

/** Verify a signed push. Headers: x-tps-key, x-tps-ts (unix ms), x-tps-nonce, x-tps-signature (base64).
 *  Binds key → affiliate (and allowed customer ids), rejects skew > 5 min and replays (caller supplies the nonce store). */
export async function verifyScriptPush(
  body: string, headers: Record<string, string | undefined>, keys: Record<string, PushKey>, now: number,
  seenNonce: (keyId: string, nonce: string) => boolean, maxSkewMs = 5 * 60_000,
): Promise<PushVerdict> {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const keyId = h['x-tps-key'], ts = h['x-tps-ts'], nonce = h['x-tps-nonce'], sig = h['x-tps-signature'];
  if (!keyId || !ts || !nonce || !sig) return { ok: false, error: 'missing signature headers' };
  const key = keys[keyId];
  if (!key || key.revoked) return { ok: false, error: 'unknown or revoked key' };
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > maxSkewMs) return { ok: false, error: 'timestamp outside allowed skew' };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return { ok: false, error: 'bad nonce' };
  const expect = await hmacB64(key.secret, signingString(keyId, ts, nonce, body));
  if (!ctEqual(expect, sig)) return { ok: false, error: 'bad signature' };
  if (seenNonce(keyId, nonce)) return { ok: false, error: 'replayed nonce' };
  let push: ScriptPush;
  try { push = JSON.parse(body); } catch { return { ok: false, error: 'body is not JSON' }; }
  if (push?.v !== 1 || push.kind !== 'google_click_view' || !Array.isArray(push.rows) || !parseDay(push.date)) return { ok: false, error: 'unsupported payload' };
  if (String(push.aff) !== key.aff) return { ok: false, error: 'payload affiliate does not match key' };
  const cid = String(push.customerId).replace(/-/g, '');
  if (key.customerIds && !key.customerIds.includes(cid)) return { ok: false, error: 'customer id not registered for this key' };
  return { ok: true, aff: key.aff, keyId, push };
}

/** Combine verified pushes into one GooglePlatformData. A day counts as covered only when all its
 *  batches arrived; coveredThrough stops at the first incomplete day. Later pushes for the same
 *  (customer, day, batch) replace earlier ones (re-runs are idempotent). */
export function googleFromScriptPushes(pushes: ScriptPush[], base: Omit<GoogleBase, 'coveredThrough'>): IngestResult<GooglePlatformData> {
  const latest = new Map<string, ScriptPush>();
  for (const p of [...pushes].sort((a, b) => (a.generatedAt < b.generatedAt ? -1 : 1))) latest.set(`${p.customerId}|${p.date}|${p.batch}`, p);
  const byDay = new Map<string, ScriptPush[]>();
  for (const p of latest.values()) { const k = `${p.customerId}|${p.date}`; (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(p); }
  const issues: string[] = [];
  const completeDays = new Map<string, boolean>(); // date → all customers complete
  const clicks: GoogleClickRow[] = [];
  for (const [k, ps] of [...byDay.entries()].sort()) {
    const [cust, date] = k.split('|');
    const want = ps[0].batches;
    const complete = ps.length === want && ps.every((p) => p.batches === want);
    if (!complete) issues.push(`customer ${cust} ${date}: ${ps.length}/${want} batches`);
    completeDays.set(date, (completeDays.get(date) ?? true) && complete);
    for (const p of ps) for (const r of p.rows) clicks.push({ GclId: r.gclid, CustomerId: cust.replace(/-/g, ''), CampaignId: String(r.campaignId), AdGroupId: r.adGroupId,
      Date: date, Device: r.device, AdNetworkType: r.network, ClickType: r.clickType });
  }
  const days = [...completeDays.keys()].sort();
  let covered: string | null = null;
  for (let i = 0; i < days.length; i++) {
    if (!completeDays.get(days[i])) break;
    if (i > 0 && dayGap(days[i - 1], days[i]) > 1) { issues.push(`no push for days between ${days[i - 1]} and ${days[i]}`); break; }
    covered = days[i];
  }
  const autoTag = pushes.some((p) => p.autoTaggingEnabled === false) ? false : undefined;
  const accounts = autoTag === false ? base.accounts.map((a) => ({ ...a, autoTaggingEnabled: false })) : base.accounts;
  const imported = pushes.length ? pushes.map((p) => p.generatedAt).sort()[pushes.length - 1] : null;
  return { data: { status: 'ok', timeZone: base.timeZone, accounts, campaignIds: base.campaignIds, connector: base.connector, coveredThrough: covered,
    importedAt: base.importedAt ?? imported, clicks }, issues, rowsAccepted: clicks.length, rowsRejected: 0 };
}

const dayGap = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// ───────────────────────────── Meta ─────────────────────────────

export const META_PUBLISHER: Record<string, string> = {
  facebook: 'facebook', instagram: 'instagram', messenger: 'messenger', 'audience network': 'audience_network', audience_network: 'audience_network', threads: 'threads',
};

export interface MetaBase {
  timeZone: string;
  accounts: MetaPlatformData['accounts'];
  coveredThrough?: string | null;
  importedAt?: string | number | null;
  connector: ConnectorInfo;
}

/** Ads Manager export (Reports → Export, or scheduled e-mail report), broken down by Day and Ad,
 *  optionally by Platform / Placement. Column names: verify against the export language. */
export function metaFromCsv(text: string, base: MetaBase): IngestResult<MetaPlatformData> {
  const t = table(parseCsv(text), {
    date: ['day', 'date', 'reporting starts', 'date start'],
    ad: ['ad id', 'ad_id'],
    campaign: ['campaign id', 'campaign_id'],
    adset: ['ad set id', 'adset id', 'adset_id'],
    platform: ['platform', 'publisher platform'],
    position: ['placement', 'platform position'],
    link: ['link clicks', 'inline link clicks', 'inline_link_clicks'],
    clicks: ['clicks all', 'clicks'],
    lpv: ['landing page views', 'website landing page views'],
    account: ['account id'],
  }, ['date', 'ad', 'link']);
  if (!t) return { data: { status: 'error', timeZone: base.timeZone, accounts: base.accounts, connector: base.connector, insights: [] },
    issues: ['no header with Day, Ad ID and Link clicks columns found'], rowsAccepted: 0, rowsRejected: 0 };
  const rows: MetaInsightRow[] = [];
  let rejected = 0;
  for (const r of t.body) {
    if (isTotal(r)) continue;
    const date = parseDay(r[t.idx.date]);
    const link = num(r[t.idx.link]);
    const ad = (r[t.idx.ad] || '').trim();
    if (!date || !ad || link === null) { rejected++; continue; }
    const clicks = t.idx.clicks !== undefined ? num(r[t.idx.clicks]) : null;
    const lpv = t.idx.lpv !== undefined ? num(r[t.idx.lpv]) : null;
    const pub = t.idx.platform !== undefined ? r[t.idx.platform]?.trim() : undefined;
    rows.push({
      account_id: t.idx.account !== undefined ? r[t.idx.account]?.trim() : undefined,
      campaign_id: t.idx.campaign !== undefined ? (r[t.idx.campaign] || '').trim() : '',
      adset_id: t.idx.adset !== undefined ? r[t.idx.adset]?.trim() : undefined,
      ad_id: ad, date_start: date, date_stop: date,
      publisher_platform: pub ? META_PUBLISHER[pub.toLowerCase()] ?? pub.toLowerCase() : undefined,
      platform_position: t.idx.position !== undefined ? r[t.idx.position]?.trim() : undefined,
      clicks: clicks ?? link, inline_link_clicks: link, landing_page_views: lpv ?? undefined,
    });
  }
  return {
    data: { status: 'ok', timeZone: base.timeZone, accounts: base.accounts, connector: base.connector,
      coveredThrough: base.coveredThrough ?? lastDay(rows.map((x) => x.date_start)), importedAt: base.importedAt ?? null, insights: rows },
    issues: rejected ? [`${rejected} row(s) skipped (bad day / ad id / link clicks)`] : [], rowsAccepted: rows.length, rowsRejected: rejected,
  };
}

/** Graph API Insights JSON (`data[]`, as pulled with OUR app token or a PARTNER-made token). */
export function metaFromApi(json: { data?: any[] }, base: MetaBase): IngestResult<MetaPlatformData> {
  const rows: MetaInsightRow[] = [];
  let rejected = 0;
  for (const d of json?.data ?? []) {
    const link = Number(d.inline_link_clicks ?? 0);
    if (!d.ad_id || !parseDay(d.date_start) || !Number.isFinite(link)) { rejected++; continue; }
    const lpv = (d.actions ?? []).find((a: any) => a.action_type === 'landing_page_view');
    rows.push({ account_id: d.account_id, campaign_id: String(d.campaign_id ?? ''), adset_id: d.adset_id, ad_id: String(d.ad_id),
      date_start: d.date_start, date_stop: d.date_stop, publisher_platform: d.publisher_platform, platform_position: d.platform_position,
      clicks: Number(d.clicks ?? link), inline_link_clicks: link, landing_page_views: lpv ? Number(lpv.value) : undefined });
  }
  return { data: { status: 'ok', timeZone: base.timeZone, accounts: base.accounts, connector: base.connector,
    coveredThrough: base.coveredThrough ?? null, importedAt: base.importedAt ?? null, insights: rows },
    issues: rejected ? [`${rejected} row(s) skipped`] : [], rowsAccepted: rows.length, rowsRejected: rejected };
}
