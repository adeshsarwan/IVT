// A fake Google Ads API as a `fetch` function, for tests and the local runner. Answers the three
// queries the pipeline sends (customer, click_view for one day, daily campaign clicks) from
// in-memory GoogleClickRow lists, in the same JSON shape searchStream returns. No network.

import type { GoogleClickRow } from '../src/types';

export interface FakeAccount {
  customerId: string;
  timeZone: string;
  autoTagging?: boolean;
  clicks: GoogleClickRow[];
  /** Simulate a partner who unlinked us / revoked the grant. */
  revoked?: boolean;
  /** Simulate an outage. */
  failing?: boolean;
}

export function fakeGoogleAdsFetch(accounts: FakeAccount[]): typeof fetch & { calls: string[] } {
  const byId = new Map(accounts.map((a) => [a.customerId.replace(/-/g, ''), a]));
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes('oauth2') || url.endsWith('/token')) return json({ access_token: 'fake-access-token', expires_in: 3600, token_type: 'Bearer' });

    const m = url.match(/customers\/(\d+)\/googleAds:searchStream$/);
    if (!m) return json({ error: { message: 'not found' } }, 404);
    const acc = byId.get(m[1]);
    const headers = new Headers(init?.headers);
    if (!headers.get('developer-token')) return json([{ error: { code: 401, message: 'missing developer token', status: 'UNAUTHENTICATED' } }], 401);
    if (!acc || acc.revoked) return json([{ error: { code: 403, message: "The caller does not have permission", status: 'PERMISSION_DENIED',
      details: [{ errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' } }] }] } }], 403);
    if (acc.failing) return json([{ error: { code: 503, message: 'backend unavailable', status: 'UNAVAILABLE' } }], 503);

    const q: string = JSON.parse(String(init?.body ?? '{}')).query ?? '';
    const cid = acc.customerId.replace(/-/g, '');
    if (/FROM customer\b/.test(q)) {
      return json([{ results: [{ customer: { resourceName: `customers/${cid}`, id: cid, timeZone: acc.timeZone, autoTaggingEnabled: acc.autoTagging ?? true, manager: false } }] }]);
    }
    if (/FROM click_view/.test(q)) {
      const date = q.match(/segments\.date = '(\d{4}-\d{2}-\d{2})'/)?.[1];
      if (!date) return json([{ error: { code: 400, message: 'click_view requires a single-day date filter', status: 'INVALID_ARGUMENT' } }], 400);
      const rows = acc.clicks.filter((c) => c.Date === date).map((c) => ({
        customer: { id: cid }, campaign: { id: c.CampaignId }, adGroup: { id: c.AdGroupId ?? '' }, clickView: { gclid: c.GclId },
        segments: { date: c.Date, device: c.Device ?? 'DESKTOP', clickType: c.ClickType ?? 'URL_CLICKS', adNetworkType: c.AdNetworkType ?? 'SEARCH' },
      }));
      // Google streams results in batches (10k rows per batch in the real API).
      const batches = [];
      for (let i = 0; i < rows.length; i += 10_000) batches.push({ results: rows.slice(i, i + 10_000), fieldMask: 'clickView.gclid,…' });
      return json(batches.length ? batches : [{ fieldMask: 'clickView.gclid' }]);
    }
    if (/FROM campaign/.test(q)) {
      const [, from, to] = q.match(/BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/) ?? [];
      const agg = new Map<string, number>();
      for (const c of acc.clicks) if (c.Date >= from && c.Date <= to) {
        const k = `${c.Date}|${c.CampaignId}|${c.AdNetworkType ?? 'SEARCH'}`;
        agg.set(k, (agg.get(k) ?? 0) + 1);
      }
      const results = [...agg].map(([k, n]) => { const [date, camp, net] = k.split('|'); return { customer: { id: cid }, campaign: { id: camp }, segments: { date, adNetworkType: net }, metrics: { clicks: String(n) } }; });
      return json([{ results }]);
    }
    return json([{ error: { code: 400, message: `unsupported query: ${q.slice(0, 80)}`, status: 'INVALID_ARGUMENT' } }], 400);
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}
