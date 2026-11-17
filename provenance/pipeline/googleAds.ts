// Google Ads API client (REST, fetch only). Reads click_view (every click, one day per query),
// daily campaign click totals, and account settings. `fetch` is injected so tests and the local
// runner never call Google.
//
// verify: API version, endpoint shape, header names and the click_view single-day / 90-day limits
// against the current Google Ads API docs before going live.

export interface GoogleAdsAuth {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Manager account the request goes through (our MCC, or the partner's for partner-owned OAuth). Digits only. */
  loginCustomerId?: string;
}

export interface GoogleAdsOpts {
  apiVersion?: string;
  fetch?: typeof fetch;
  /** Base URLs (overridden by the local fake server). */
  adsBase?: string;
  tokenUrl?: string;
}

export interface ClickViewRow {
  gclid: string;
  customerId: string;
  date: string;
  campaignId: string;
  adGroupId: string;
  device: string;
  clickType: string;
  adNetworkType: string;
}
export interface DailyClicksRow { customerId: string; date: string; campaignId: string; adNetworkType: string; clicks: number }
export interface CustomerInfo { customerId: string; timeZone: string; autoTaggingEnabled: boolean; manager: boolean }

export class GoogleAdsError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) { super(message); }
  /** Auth / permission problems mean the partner unlinked us or revoked the grant: not worth retrying. */
  get isAccessError() { return this.status === 401 || this.status === 403 || /PERMISSION|AUTHENTICATION|AUTHORIZATION|CUSTOMER_NOT_ENABLED/.test(this.code ?? ''); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^\d{6,12}$/;
export const cleanId = (id: string) => id.replace(/-/g, '');

/** GAQL for every click of one account-local day. click_view only allows a single-day filter. */
export function clickViewQuery(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`bad date ${date}`);
  return `SELECT click_view.gclid, customer.id, segments.date, campaign.id, ad_group.id, segments.device, segments.click_type, segments.ad_network_type FROM click_view WHERE segments.date = '${date}'`;
}

/** GAQL for Google's own click totals per day × campaign × network. */
export function dailyClicksQuery(from: string, to: string): string {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('bad date range');
  return `SELECT customer.id, campaign.id, segments.date, segments.ad_network_type, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.clicks > 0`;
}

export const CUSTOMER_QUERY = 'SELECT customer.id, customer.time_zone, customer.auto_tagging_enabled, customer.manager FROM customer LIMIT 1';

type Row = Record<string, any>;

export function mapClickView(r: Row): ClickViewRow {
  return {
    gclid: String(r.clickView?.gclid ?? ''),
    customerId: String(r.customer?.id ?? ''),
    date: String(r.segments?.date ?? ''),
    campaignId: String(r.campaign?.id ?? ''),
    adGroupId: String(r.adGroup?.id ?? ''),
    device: String(r.segments?.device ?? ''),
    clickType: String(r.segments?.clickType ?? ''),
    adNetworkType: String(r.segments?.adNetworkType ?? ''),
  };
}
export function mapDaily(r: Row): DailyClicksRow {
  return {
    customerId: String(r.customer?.id ?? ''), date: String(r.segments?.date ?? ''), campaignId: String(r.campaign?.id ?? ''),
    adNetworkType: String(r.segments?.adNetworkType ?? ''), clicks: Number(r.metrics?.clicks ?? 0),
  };
}
export function mapCustomer(r: Row): CustomerInfo {
  return { customerId: String(r.customer?.id ?? ''), timeZone: String(r.customer?.timeZone ?? 'UTC'), autoTaggingEnabled: !!r.customer?.autoTaggingEnabled, manager: !!r.customer?.manager };
}

export class GoogleAdsClient {
  private token: { value: string; exp: number } | null = null;
  private readonly f: typeof fetch;
  private readonly v: string;
  private readonly adsBase: string;
  private readonly tokenUrl: string;
  /** Requests made (each searchStream call is one request, however many rows it streams). */
  requests = 0;

  constructor(readonly auth: GoogleAdsAuth, o: GoogleAdsOpts = {}) {
    this.f = o.fetch ?? fetch;
    this.v = o.apiVersion ?? 'v22'; // verify: current version
    this.adsBase = o.adsBase ?? 'https://googleads.googleapis.com';
    this.tokenUrl = o.tokenUrl ?? 'https://oauth2.googleapis.com/token';
  }

  private async accessToken(now = Date.now()): Promise<string> {
    if (this.token && this.token.exp - 60_000 > now) return this.token.value;
    const res = await this.f(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.auth.clientId, client_secret: this.auth.clientSecret, refresh_token: this.auth.refreshToken }).toString(),
    });
    const j = (await res.json().catch(() => ({}))) as Row;
    if (!res.ok || !j.access_token) throw new GoogleAdsError(`OAuth refresh failed: ${j.error ?? res.status}`, res.status === 400 ? 401 : res.status, String(j.error ?? 'AUTHENTICATION_ERROR'));
    this.token = { value: j.access_token, exp: now + Number(j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** searchStream: one request, all rows (Google streams them as an array of batches). */
  async search(customerId: string, query: string): Promise<Row[]> {
    const cid = cleanId(customerId);
    if (!ID_RE.test(cid)) throw new Error(`bad customer id ${customerId}`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      'developer-token': this.auth.developerToken,
      'Content-Type': 'application/json',
    };
    if (this.auth.loginCustomerId) headers['login-customer-id'] = cleanId(this.auth.loginCustomerId);
    this.requests++;
    const res = await this.f(`${this.adsBase}/${this.v}/customers/${cid}/googleAds:searchStream`, { method: 'POST', headers, body: JSON.stringify({ query }) });
    const body = (await res.json().catch(() => null)) as Row | Row[] | null;
    if (!res.ok) {
      const err = Array.isArray(body) ? body[0]?.error : body?.error;
      const code = err?.details?.[0]?.errors?.[0]?.errorCode ? Object.values(err.details[0].errors[0].errorCode).join(',') : err?.status ?? null;
      throw new GoogleAdsError(`Google Ads ${res.status}: ${err?.message ?? 'request failed'}`, res.status, code ? String(code) : null);
    }
    const batches = Array.isArray(body) ? body : body ? [body] : [];
    return batches.flatMap((b) => (b.results ?? []) as Row[]);
  }

  async clicksForDay(customerId: string, date: string): Promise<ClickViewRow[]> {
    return (await this.search(customerId, clickViewQuery(date))).map(mapClickView).filter((r) => r.gclid);
  }
  async dailyClicks(customerId: string, from: string, to: string): Promise<DailyClicksRow[]> {
    return (await this.search(customerId, dailyClicksQuery(from, to))).map(mapDaily);
  }
  async customer(customerId: string): Promise<CustomerInfo> {
    const rows = await this.search(customerId, CUSTOMER_QUERY);
    if (!rows.length) throw new GoogleAdsError('customer not found', 404, 'NOT_FOUND');
    return mapCustomer(rows[0]);
  }
}
