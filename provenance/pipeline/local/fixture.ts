// A small local fleet built from the engine's preset scenarios, for the local runner and the
// ClickHouse integration test. Each affiliate gets its own fake Google Ads account.

import { buildScenario, type ScenarioId } from '../../src/index';
import type { ConfigOverrides } from '../../src/config';
import type { GoogleClickRow, RawRequest } from '../../src/types';
import { fakeGoogleAdsFetch, type FakeAccount } from '../fakeGoogleAds';
import { GoogleAdsClient } from '../googleAds';
import type { PartnerConfig } from '../store';

export const LOCAL_NOW = Date.parse('2026-11-12T15:00:00Z'); // 10:00 New York, the scenarios' "now"

export interface LocalFleet {
  partners: PartnerConfig[];
  landings: RawRequest[];
  accounts: FakeAccount[];
  config: ConfigOverrides;
  fetch: ReturnType<typeof fakeGoogleAdsFetch>;
  googleFor: (p: PartnerConfig) => GoogleAdsClient;
  expect: Record<string, string>;
}

export function buildLocalFleet(): LocalFleet {
  const picks: [ScenarioId, string, string][] = [
    ['clean', '42', 'OK: real clicks, match ≈ 97%'],
    ['bot_farm', '13', 'BLOCK (review): 60% fake gclids, landings ≫ clicks'],
    ['placement_abuse', '21', 'BLOCK (review): real clicks on porn / junk placements'],
    ['forgery_reuse', '55', 'BLOCK (review): forged and replayed gclids'],
  ];
  const partners: PartnerConfig[] = [];
  const landings: RawRequest[] = [];
  const accounts: FakeAccount[] = [];
  const routes: Record<string, any> = {};
  const expect: Record<string, string> = {};
  let n = 0;

  for (const [id, aff, why] of picks) {
    const s = buildScenario(id);
    Object.assign(routes, s.config.routes ?? {});
    const cid = `10000000${String(++n).padStart(2, '0')}`;
    const google = s.input.platform[aff]?.google;
    const clicks: GoogleClickRow[] = (google?.clicks ?? []).map((c) => ({ ...c, CustomerId: cid }));
    landings.push(...s.input.requests.filter((r) => r.aff === aff && /-g$/.test(r.route ?? '') ));
    accounts.push({ customerId: cid, timeZone: google?.timeZone ?? 'America/New_York', clicks });
    partners.push({ aff, auth: 'mcc', customerIds: [cid], loginCustomerId: '9990001111', enabled: true });
    expect[aff] = why;
  }

  // 77: copies 2,000 real gclids that belong to affiliate 42's account ("foreign" clicks).
  const real42 = accounts[0].clicks.slice(0, 2000);
  real42.forEach((c, i) => landings.push({
    id: `copy77-${i}`, ts: Date.parse(`${c.Date}T16:00:00Z`) + i * 1000, site: 'gamewhame.com', aff: '77', route: 'r-77-g',
    url: `https://gamewhame.com/?utm_source=google&utm_medium=cpc&gclid=${c.GclId}&cid=${c.CampaignId}`,
    ipHash: `ip77-${i % 400}`,
  }));
  routes['r-77-g'] = 'google';
  accounts.push({ customerId: '1000000077', timeZone: 'America/New_York', clicks: [] });
  partners.push({ aff: '77', auth: 'mcc', customerIds: ['1000000077'], loginCustomerId: '9990001111', enabled: true });
  expect['77'] = 'BLOCK (review): gclids are real but belong to another affiliate (foreign)';

  // 88: unlinked us (403 from Google) → no access → THROTTLE floor after the grace period; sync status shows it.
  accounts.push({ customerId: '1000000088', timeZone: 'America/New_York', clicks: [], revoked: true });
  partners.push({ aff: '88', auth: 'oauth', customerIds: ['1000000088'], tokenRef: 'GADS_RT_88', enabled: true });
  expect['88'] = 'no access: sync fails with 403, no landings → nothing to evaluate';

  const fetch = fakeGoogleAdsFetch(accounts);
  const clients = new Map<string, GoogleAdsClient>();
  const googleFor = (p: PartnerConfig) => {
    let c = clients.get(p.aff);
    if (!c) {
      c = new GoogleAdsClient({ developerToken: 'dev-token-local', clientId: 'local', clientSecret: 'local', refreshToken: p.tokenRef ?? 'mcc-refresh', loginCustomerId: p.loginCustomerId }, { fetch });
      clients.set(p.aff, c);
    }
    return c;
  };
  return { partners, landings, accounts, config: { routes }, fetch, googleFor, expect };
}
