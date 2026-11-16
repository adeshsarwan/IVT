// Deterministic synthetic fixtures (seeded PRNG) used by the tests and the demo page.
// Shapes mirror real exports: Google click_view / ClickStats rows and Meta Insights rows.

import type { ConfigOverrides } from './config';
import type { GoogleClickRow, MetaInsightRow, ProvenanceInput, RawRequest, Source } from './types';
import { localDate } from './util';

export type ScenarioId =
  | 'clean' | 'bot_farm' | 'placement_abuse' | 'forgery_reuse' | 'meta_audience_network'
  | 'late_data' | 'small_sample' | 'no_access' | 'autotag_off' | 'ios_braid' | 'partial_account'
  | 'platform_down' | 'zero_platform_data';

export interface Scenario { id: ScenarioId; title: string; expect: string; input: ProvenanceInput; config: ConfigOverrides }

const TZ = 'America/New_York';
const DAY0 = Date.parse('2026-11-10T05:00:00Z'); // 2026-11-10 00:00 New York
const H = 3600_000;
const NOW = DAY0 + 2 * 24 * H + 10 * H; // 2026-11-12 10:00 NY
// Human hour-of-day curve (NY local): low at night, peaks evening.
const HUMAN = [2, 1, 1, 1, 1, 2, 3, 5, 6, 6, 6, 6, 7, 7, 6, 6, 7, 8, 9, 10, 10, 8, 5, 3];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
  const weighted = (w: readonly number[]) => { const s = w.reduce((x, y) => x + y, 0); let r = next() * s; for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; } return w.length - 1; };
  const str = (n: number) => { let s = ''; for (let i = 0; i < n; i++) s += B64[Math.floor(next() * 64)]; return s; };
  return { next, pick, weighted, str };
}
type R = ReturnType<typeof rng>;

function tsFor(r: R, days: number, flat: boolean): number {
  const day = Math.floor(r.next() * days);
  const hour = flat ? Math.floor(r.next() * 24) : r.weighted(HUMAN);
  return DAY0 + day * 24 * H + hour * H + Math.floor(r.next() * H);
}

interface GoogleMix {
  real: number; fake?: number; braid?: number; none?: number; reused?: number; malformed?: number;
  /** Fraction of real Google clicks that never landed (adds platform-only click rows). */
  unlanded?: number;
  network?: (r: R) => { type: string; vt: string; placement?: string };
  flat?: boolean;
  campaigns?: string[];
  /** Campaign ids used by traffic from an unlinked account (gclids not in our import). */
  unlinkedCampaigns?: { share: number; ids: string[] };
}

function genGoogle(seed: number, aff: string, n: number, days: number, mix: GoogleMix) {
  const r = rng(seed);
  const requests: RawRequest[] = [];
  const clicks: GoogleClickRow[] = [];
  const campaigns = mix.campaigns ?? ['111', '112', '113'];
  const reusePool: string[] = [];
  const kinds = ['real', 'fake', 'braid', 'none', 'reused', 'malformed', 'unlinked'] as const;
  const w = [mix.real, mix.fake ?? 0, mix.braid ?? 0, mix.none ?? 0, mix.reused ?? 0, mix.malformed ?? 0, mix.unlinkedCampaigns?.share ?? 0];
  for (let i = 0; i < n; i++) {
    const kind = kinds[r.weighted(w)];
    const ts = tsFor(r, days, !!mix.flat);
    const net = mix.network ? mix.network(r) : { type: 'SEARCH', vt: 'g' };
    const mobile = r.next() < 0.7;
    const cid = kind === 'unlinked' ? r.pick(mix.unlinkedCampaigns!.ids) : r.pick(campaigns);
    const p: Record<string, string> = { utm_source: 'google', utm_medium: 'cpc', cid, ag: `${cid}0${1 + Math.floor(r.next() * 3)}`, net: net.vt, dev: mobile ? 'm' : 'c' };
    if (net.placement) p.plc = net.placement;
    let ip = `ip-${r.str(8)}`;
    if (kind === 'real' || kind === 'unlinked') {
      const g = `Cj0KCQiA${r.str(84)}`;
      p.gclid = g;
      if (kind === 'real') {
        clicks.push({ GclId: g, CustomerId: '1234567890', CampaignId: cid, AdGroupId: p.ag, Date: localDate(ts - Math.floor(r.next() * 20_000), TZ),
          Device: mobile ? 'MOBILE' : 'DESKTOP', ClickType: 'URL_CLICKS', AdNetworkType: net.type, Placement: net.placement });
        if (reusePool.length < 25) reusePool.push(g);
      }
    } else if (kind === 'fake') p.gclid = `Cj0KCQiA${r.str(84)}`;
    else if (kind === 'braid') { p[r.next() < 0.5 ? 'gbraid' : 'wbraid'] = `0AAAAA${r.str(40)}`; }
    else if (kind === 'reused') { p.gclid = reusePool.length ? r.pick(reusePool) : `Cj0KCQiA${r.str(84)}`; ip = `ip-${r.str(8)}`; }
    else if (kind === 'malformed') p.gclid = r.pick(['{gclid}', 'test', 'abc123', '{gclid}', 'null']);
    const qs = new URLSearchParams(p).toString();
    requests.push({ id: `g${aff}-${String(i).padStart(6, '0')}`, ts, site: 'gamewhame.com', aff, route: `r-${aff}-g`,
      url: `https://gamewhame.com/lp?${qs}`, ipHash: ip, uaDevice: mobile ? 'mobile' : 'desktop' });
  }
  // Platform clicks that never landed (normal: bounces before load). Also count braid clicks: Google
  // reports them as clicks but click_view has no gclid for them — modelled as rows with synthetic ids.
  const braidCount = requests.filter((q) => /[gw]braid=/.test(q.url!)).length;
  const extra = Math.round(clicks.length * (mix.unlanded ?? 0.05)) + braidCount;
  for (let i = 0; i < extra; i++) {
    const ts = tsFor(r, days, false);
    clicks.push({ GclId: `Cj0KCQiA${r.str(84)}`, CustomerId: '1234567890', CampaignId: r.pick(campaigns), Date: localDate(ts, TZ), Device: 'MOBILE', ClickType: 'URL_CLICKS', AdNetworkType: 'SEARCH' });
  }
  return { requests, clicks };
}

interface MetaMix {
  ss: [number, number, number, number]; // fb, ig, msg, an
  fbclidMissing?: number;
  /** Platform-reported link clicks per landing, per publisher (fb, ig, msg, an). >1 = clicks that never landed. */
  clicksPerLanding?: [number, number, number, number];
  /** Extra landings with no matching platform clicks (injected), as a share of n. */
  injected?: number;
}

function genMeta(seed: number, aff: string, n: number, days: number, mix: MetaMix) {
  const r = rng(seed);
  const requests: RawRequest[] = [];
  const pubs = ['facebook', 'instagram', 'messenger', 'audience_network'] as const;
  const ssCode = ['fb', 'ig', 'msg', 'an'];
  const plc = ['Facebook_Mobile_Feed', 'Instagram_Stories', 'Messenger_Inbox', 'an_classic'];
  const ads = ['6001', '6002', '6003', '6004', '6005'];
  const counts = new Map<string, number>(); // ad|date|pub → landings
  for (let i = 0; i < n; i++) {
    const s = r.weighted(mix.ss);
    const ts = tsFor(r, days, false);
    const ad = r.pick(ads);
    const injected = r.next() < (mix.injected ?? 0);
    const p: Record<string, string> = { utm_source: 'facebook', utm_medium: 'paid', campaign_id: '5001', adset_id: `550${ads.indexOf(ad) % 2}`, ad_id: ad, site_source_name: ssCode[s], placement: plc[s] };
    if (r.next() >= (mix.fbclidMissing ?? 0.03)) p.fbclid = `IwAR${r.str(56)}`;
    if (!injected) { const k = `${ad}|${localDate(ts, TZ)}|${pubs[s]}`; counts.set(k, (counts.get(k) || 0) + 1); }
    requests.push({ id: `m${aff}-${String(i).padStart(6, '0')}`, ts, site: 'jobsqualified.com', aff, route: `r-${aff}-m`,
      url: `https://jobsqualified.com/lp?${new URLSearchParams(p)}`, ipHash: `ip-${r.str(8)}`, uaDevice: 'mobile' });
  }
  const cpl = mix.clicksPerLanding ?? [1.15, 1.15, 1.15, 1.15];
  const insights: MetaInsightRow[] = [...counts.entries()].sort().map(([k, c]) => {
    const [ad, date, pub] = k.split('|');
    const link = Math.round(c * cpl[pubs.indexOf(pub as any)]);
    return { account_id: 'act_99', campaign_id: '5001', adset_id: `550${ads.indexOf(ad) % 2}`, ad_id: ad, date_start: date, date_stop: date,
      publisher_platform: pub, platform_position: pub === 'audience_network' ? 'classic' : 'feed', clicks: Math.round(link * 1.4), inline_link_clicks: link, landing_page_views: Math.round(c * 0.95) };
  });
  return { requests, insights };
}

const googleData = (clicks: GoogleClickRow[], over: Partial<import('./types').GooglePlatformData> = {}) => ({
  status: 'ok' as const, timeZone: TZ, accounts: [{ customerId: '1234567890', linked: true, autoTaggingEnabled: true }],
  coveredThrough: '2026-11-11', importedAt: NOW - 4 * H, clicks, ...over,
});
const metaData = (insights: MetaInsightRow[], over: Partial<import('./types').MetaPlatformData> = {}) => ({
  status: 'ok' as const, timeZone: TZ, accounts: [{ id: 'act_99', linked: true }], coveredThrough: '2026-11-11', importedAt: NOW - 4 * H, insights, ...over,
});
const routes = (...affs: string[]): Record<string, Source> => Object.fromEntries(affs.flatMap((a) => [[`r-${a}-g`, 'google'], [`r-${a}-m`, 'meta']]));

export const SCENARIOS: Record<ScenarioId, { title: string; expect: string; build: () => Omit<Scenario, 'id' | 'title' | 'expect'> }> = {
  clean: {
    title: 'Clean Google + Meta affiliate',
    expect: 'All windows OK; affiliate OK; no KV change.',
    build: () => {
      const g = genGoogle(1, '42', 10_000, 2, { real: 0.97, braid: 0.02, none: 0.01 });
      const m = genMeta(2, '42', 10_000, 2, { ss: [60, 38, 2, 0] });
      return { input: { requests: [...g.requests, ...m.requests], now: NOW, platform: { '42': { google: googleData(g.clicks), meta: metaData(m.insights) } } }, config: { routes: routes('42') } };
    },
  },
  bot_farm: {
    title: 'Bot farm with fake gclids',
    expect: 'Low match rate (hard), landings ≫ clicks, flat hour curve → BLOCK; ads:aff:13 = off.',
    build: () => {
      const g = genGoogle(3, '13', 10_000, 2, { real: 0.3, fake: 0.6, none: 0.1, flat: true });
      return { input: { requests: g.requests, now: NOW, platform: { '13': { google: googleData(g.clicks) } } }, config: { routes: routes('13') } };
    },
  },
  placement_abuse: {
    title: 'Porn / junk-app placements on Google Display',
    expect: 'Clicks are real (high match), but Display share and blocklisted placements → BLOCK.',
    build: () => {
      const g = genGoogle(4, '21', 10_000, 2, { real: 0.98, none: 0.02, network: (r) => r.next() < 0.7
        ? { type: 'CONTENT', vt: 'd', placement: r.pick(['freeporn-xxx.example', 'mobileapp::2-com.flashlight.free', 'adult-tube.example', 'mobileapp::1-12345']) }
        : { type: 'SEARCH', vt: 'g' } });
      return { input: { requests: g.requests, now: NOW, platform: { '21': { google: googleData(g.clicks) } } }, config: { routes: routes('21') } };
    },
  },
  forgery_reuse: {
    title: 'Click-ID forgery and replay',
    expect: 'Malformed / {gclid} macros and the same real gclids replayed from many IPs → BLOCK.',
    build: () => {
      const g = genGoogle(5, '55', 10_000, 2, { real: 0.6, reused: 0.3, malformed: 0.1 });
      return { input: { requests: g.requests, now: NOW, platform: { '55': { google: googleData(g.clicks) } } }, config: { routes: routes('55') } };
    },
  },
  meta_audience_network: {
    title: 'Meta Audience Network inflation',
    expect: 'AN share far above policy and AN clicks that never land → BLOCK on Meta.',
    build: () => {
      const m = genMeta(6, '77', 10_000, 2, { ss: [25, 15, 0, 60], clicksPerLanding: [1.15, 1.15, 1.15, 4], injected: 0.1 });
      return { input: { requests: m.requests, now: NOW, platform: { '77': { meta: metaData(m.insights) } } }, config: { routes: routes('77') } };
    },
  },
  late_data: {
    title: 'Late / stale platform data',
    expect: 'Day 2 not imported yet and import 50h old: day-2 windows PROVISIONAL, nothing counted as unmatched; tier OK.',
    build: () => {
      const g = genGoogle(7, '42', 10_000, 2, { real: 0.97, braid: 0.02, none: 0.01 });
      const g1 = g.clicks.filter((c) => c.Date <= '2026-11-10');
      return { input: { requests: g.requests, now: NOW, platform: { '42': { google: googleData(g1, { coveredThrough: '2026-11-10', importedAt: NOW - 50 * H }) } } }, config: { routes: routes('42') } };
    },
  },
  small_sample: {
    title: 'Too few samples',
    expect: '150 requests: NO_VERDICT, breaker holds at OK even though half the gclids are fake.',
    build: () => {
      const g = genGoogle(8, '88', 150, 2, { real: 0.5, fake: 0.5 });
      return { input: { requests: g.requests, now: NOW, platform: { '88': { google: googleData(g.clicks) } } }, config: { routes: routes('88') } };
    },
  },
  no_access: {
    title: 'Affiliate refuses account access',
    expect: 'NO_ACCESS: only edge checks run; trust floor THROTTLE.',
    build: () => {
      const g = genGoogle(9, '31', 10_000, 2, { real: 0.97, none: 0.03 });
      return { input: { requests: g.requests, now: NOW, platform: { '31': { google: { status: 'no_access', timeZone: TZ, accounts: [], clicks: [] } } } }, config: { routes: routes('31') } };
    },
  },
  autotag_off: {
    title: 'Auto-tagging off',
    expect: 'Template present but no gclid: autotagging_off → THROTTLE (no BLOCK from no-ID share alone).',
    build: () => {
      const g = genGoogle(10, '64', 10_000, 2, { real: 0, none: 1 });
      const fakeClicks = genGoogle(11, '64', 10_300, 2, { real: 1 }).clicks;
      return { input: { requests: g.requests, now: NOW, platform: { '64': { google: googleData(fakeClicks, { accounts: [{ customerId: '1234567890', linked: true, autoTaggingEnabled: false }] }) } } }, config: { routes: routes('64') } };
    },
  },
  ios_braid: {
    title: 'iOS-heavy traffic (gbraid/wbraid)',
    expect: '40% braid-only: not penalised, covered by the day ratio; OK.',
    build: () => {
      const g = genGoogle(12, '46', 10_000, 2, { real: 0.59, braid: 0.4, none: 0.01 });
      return { input: { requests: g.requests, now: NOW, platform: { '46': { google: googleData(g.clicks) } } }, config: { routes: routes('46') } };
    },
  },
  partial_account: {
    title: 'Partial account access',
    expect: '25% of gclids come from campaigns in an unlinked account: partial_account_access (THROTTLE cap), not forgery.',
    build: () => {
      const g = genGoogle(13, '52', 10_000, 2, { real: 0.75, unlinkedCampaigns: { share: 0.25, ids: ['999', '998'] } });
      return { input: { requests: g.requests, now: NOW, platform: { '52': { google: googleData(g.clicks, { campaignIds: ['111', '112', '113'],
        accounts: [{ customerId: '1234567890', linked: true, autoTaggingEnabled: true }, { customerId: '5550001111', linked: false }] }) } } }, config: { routes: routes('52') } };
    },
  },
  platform_down: {
    title: 'Google import failing',
    expect: 'UNKNOWN: breaker holds within 48h grace; edge-only reasons still apply.',
    build: () => {
      const g = genGoogle(14, '42', 10_000, 2, { real: 0.97, none: 0.03 });
      return { input: { requests: g.requests, now: NOW, platform: { '42': { google: googleData([], { status: 'error' }) } } }, config: { routes: routes('42') } };
    },
  },
  zero_platform_data: {
    title: 'Linked account reports zero clicks',
    expect: 'Fresh import, linked account, 0 clicks: match rate 0 and platform_reports_zero_clicks → hard BLOCK.',
    build: () => {
      const g = genGoogle(15, '99', 10_000, 2, { real: 0.97, none: 0.03 });
      return { input: { requests: g.requests, now: NOW, platform: { '99': { google: googleData([]) } } }, config: { routes: routes('99') } };
    },
  },
};

export function buildScenario(id: ScenarioId): Scenario {
  const s = SCENARIOS[id];
  return { id, title: s.title, expect: s.expect, ...s.build() };
}
