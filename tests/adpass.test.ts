import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { type Env } from '../src/worker';
import { dailyAuditKey, ipPrefix, maybeIssueAdPass, passAuditTag } from '../src/adpass';

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const SECRET = 's'.repeat(40);
const OLD_SECRET = 'o'.repeat(40);
const UA = 'Mozilla/5.0 Test';
const IP = '203.0.113.7';
const sites = [
  { id: 1, site_key: 'gamewhame.com', hostname: 'gamewhame.com', enabled: 1, mode: 'shadow' },
  { id: 2, site_key: 'jobsqualified.com', hostname: 'jobsqualified.com', enabled: 1, mode: 'shadow' },
];
type Opts = { vars?: Record<string, string | undefined>; kv?: Record<string, string>; kvThrows?: boolean; guardThrows?: boolean };
function harness(opts: Opts = {}) {
  const kv = new Map<string, string>(Object.entries(opts.kv || {}));
  const state = { kvThrows: !!opts.kvThrows, guardThrows: !!opts.guardThrows, claims: new Set<string>() };
  const env = {
    ...config.vars,
    IVT_HASH_SECRET: 'test-secret',
    AD_PASS_MODE: 'enforce',
    AD_PASS_SECRET: SECRET,
    ...(opts.vars || {}),
    DB: { prepare(sql: string) { return {
      values: [] as any[], bind(...values: any[]) { this.values = values; return this; },
      async first() {
        if (sql.startsWith('SELECT id, hostname')) return sites.find(s => s.site_key === this.values[0]) || null;
        if (sql.includes('COUNT(')) return { n: 0 };
        return null;
      },
      async run() { return { success: true }; },
    }; } },
    IVT_CONFIG: {
      get: async (key: string) => {
        if (state.kvThrows) throw new Error('kv down');
        return kv.has(key) ? kv.get(key)! : null;
      },
    },
    REPLAY_GUARD: {
      idFromName: (name: string) => name,
      get: (name: string) => ({ fetch: async (url: string) => {
        if (state.guardThrows) throw new Error('do down');
        if (url.endsWith('/claim')) {
          if (state.claims.has(name)) return new Response('used', { status: 409 });
          state.claims.add(name); return new Response('ok');
        }
        return new Response('ok');
      } }),
    },
  } as unknown as Env;
  return { env, kv, state };
}

type Client = { origin?: string; ip?: string; ua?: string; siteKey?: string; browser?: object; aff?: string | null };
async function admit(h: ReturnType<typeof harness>, c: Client = {}) {
  const origin = c.origin || 'https://gamewhame.com';
  const res = await worker.fetch(new Request('https://ivt.thebesads.com/v1/admit', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'CF-Connecting-IP': c.ip || IP, 'User-Agent': c.ua || UA },
    body: JSON.stringify({ siteKey: c.siteKey || 'gamewhame.com', nonce: 'a'.repeat(32), page: { href: origin + '/x' }, browser: c.browser || { ua: UA },
      attribution: 'aff' in c ? (c.aff === null ? {} : { aff: c.aff }) : { aff: '42' } }),
  }), h.env);
  assert.equal(res.status, 200);
  return res.json() as Promise<any>;
}
async function adCheck(h: ReturnType<typeof harness>, adPass: unknown, c: Client = {}) {
  return worker.fetch(new Request('https://ivt.thebesads.com/v1/ad-check', {
    method: 'POST',
    headers: { origin: c.origin || 'https://gamewhame.com', 'content-type': 'application/json', 'CF-Connecting-IP': c.ip || IP, 'User-Agent': c.ua || UA },
    body: JSON.stringify({ adPass }),
  }), h.env);
}
async function denied(res: Response) {
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), '');
}
const claimsOf = (pass: string) => JSON.parse(Buffer.from(pass.split('.')[1], 'base64url').toString());

describe('ad pass: valid flow', () => {
  it('eligible admission gets a pass; ad-check approves it with audit key-values only', async () => {
    const h = harness();
    const body = await admit(h);
    assert.equal(body.status, 'ADMITTED');
    assert.equal(body.monetization.eligible, true);
    assert.match(body.runtime, /^\/v1\/runtime\//);
    assert.equal(typeof body.adPass, 'string');
    const [kid] = body.adPass.split('.');
    assert.equal(kid, 'k1');
    const claims = claimsOf(body.adPass);
    assert.deepEqual(Object.keys(claims).sort(), ['aff', 'e', 'exp', 'iat', 'ih', 'n', 'o', 'pv', 'sid', 'site', 'sk', 'typ', 'uh', 'v'].sort());
    assert.equal(claims.typ, 'adpass');
    assert.equal(claims.o, 'https://gamewhame.com');
    assert.equal(claims.sk, 'gamewhame.com');
    assert.equal(claims.aff, '42');
    assert.equal(claims.exp - claims.iat, 1800);
    assert.ok(!body.adPass.includes(IP) && !JSON.stringify(claims).includes('203.0.113'));

    const res = await adCheck(h, body.adPass);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store, private');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://gamewhame.com');
    const units: any = await res.json();
    assert.deepEqual(Object.keys(units).sort(), ['expiresAt', 'ok', 'targeting'], 'no ad units, slots or GPT URL');
    assert.equal(units.ok, true);
    assert.equal(units.expiresAt, claims.exp);
    assert.deepEqual(Object.keys(units.targeting).sort(), ['aff', 'ivt_e', 'ivt_k', 'ivt_t']);
    assert.equal(units.targeting.aff, '42');
    assert.equal(units.targeting.ivt_e, '1');
    assert.equal(units.targeting.ivt_k, await dailyAuditKey(SECRET, 'gamewhame.com'));
    assert.match(units.targeting.ivt_k, /^[a-f0-9]{10}$/);
    assert.equal(units.targeting.ivt_t, await passAuditTag(SECRET, claims.n));
    assert.match(units.targeting.ivt_t, /^[a-f0-9]{12}$/);
  });
  it('ivt_k is stable per UTC day and site, and differs across days and sites', async () => {
    const day = Date.UTC(2026, 10, 17, 1);
    assert.equal(await dailyAuditKey(SECRET, 'a.com', day), await dailyAuditKey(SECRET, 'a.com', day + 3600_000 * 20));
    assert.notEqual(await dailyAuditKey(SECRET, 'a.com', day), await dailyAuditKey(SECRET, 'a.com', day + 86400_000));
    assert.notEqual(await dailyAuditKey(SECRET, 'a.com', day), await dailyAuditKey(SECRET, 'b.com', day));
  });
  it('TTL is configurable and clamped', async () => {
    for (const [ttl, expected] of [['120', 120], ['3600', 3600], ['1', 15], ['99999', 3600], ['nope', 1800]] as const) {
      const body = await admit(harness({ vars: { AD_PASS_TTL_SECONDS: ttl } }));
      const c = claimsOf(body.adPass);
      assert.equal(c.exp - c.iat, expected);
    }
  });
});

describe('ad pass: issuance is gated', () => {
  it('AD_PASS_MODE off (release default) issues nothing and ad-check always denies', async () => {
    assert.equal(config.vars.AD_PASS_MODE, 'off');
    const h = harness({ vars: { AD_PASS_MODE: 'off' } });
    const body = await admit(h);
    assert.equal(body.adPass, undefined);
    const live = await admit(harness());
    await denied(await adCheck(h, live.adPass));
  });
  it('unknown mode value behaves as off', async () => {
    assert.equal((await admit(harness({ vars: { AD_PASS_MODE: 'yes' } }))).adPass, undefined);
  });
  for (const [label, browser] of [['suspicious', { ua: UA, webdriver: true }], ['observe', { cookieEnabled: false }], ['high risk', { webdriver: true }]] as const) {
    it(`enforce: ${label} (ineligible) admission gets no pass; runtime/telemetry unchanged`, async () => {
      const body = await admit(harness(), { browser });
      assert.equal(body.monetization.eligible, false);
      assert.equal(body.adPass, undefined);
      assert.equal(typeof body.runtime, 'string');
      assert.equal(typeof body.telemetryToken, 'string');
    });
  }
  it('observe: ineligible admission gets a pass marked e=0 and ivt_e=0', async () => {
    const h = harness({ vars: { AD_PASS_MODE: 'observe' } });
    const body = await admit(h, { browser: { ua: UA, webdriver: true } });
    assert.equal(claimsOf(body.adPass).e, 0);
    const units: any = await (await adCheck(h, body.adPass)).json();
    assert.equal(units.targeting.ivt_e, '0');
  });
  it('missing or short AD_PASS_SECRET issues nothing', async () => {
    assert.equal((await admit(harness({ vars: { AD_PASS_SECRET: undefined } }))).adPass, undefined);
    assert.equal((await admit(harness({ vars: { AD_PASS_SECRET: 'short' } }))).adPass, undefined);
  });
  it('AD_PASS_SECRET is independent of IVT_HASH_SECRET', async () => {
    const h = harness();
    const body = await admit(h);
    (h.env as any).IVT_HASH_SECRET = 'rotated';
    assert.equal((await adCheck(h, body.adPass)).status, 200);
  });
  it('missing client IP or User-Agent issues nothing', async () => {
    const h = harness();
    const res = await worker.fetch(new Request('https://ivt.thebesads.com/v1/admit', {
      method: 'POST', headers: { origin: 'https://gamewhame.com', 'content-type': 'application/json' },
      body: JSON.stringify({ siteKey: 'gamewhame.com', nonce: 'a'.repeat(32), browser: { ua: UA } }),
    }), h.env);
    assert.equal(((await res.json()) as any).adPass, undefined);
  });
});

describe('ad pass: token verification', () => {
  it('tampered payload is rejected', async () => {
    const h = harness();
    const pass: string = (await admit(h)).adPass;
    const [kid, payload, sig] = pass.split('.');
    const claims = claimsOf(pass);
    const forged = Buffer.from(JSON.stringify({ ...claims, sk: 'jobsqualified.com' })).toString('base64url');
    await denied(await adCheck(h, `${kid}.${forged}.${sig}`));
    await denied(await adCheck(h, `${kid}.${payload}.${sig.slice(0, -2)}AA`));
    await denied(await adCheck(h, `${kid}.${payload}`));
    await denied(await adCheck(h, 12345));
    await denied(await adCheck(h, 'x'.repeat(5000)));
  });
  it('wrong or unknown kid is rejected', async () => {
    const h = harness();
    const pass: string = (await admit(h)).adPass;
    await denied(await adCheck(h, 'k9' + pass.slice(2)));
  });
  it('key rotation: previous kid accepted while configured, rejected once removed', async () => {
    const old = harness({ vars: { AD_PASS_KID: 'k1', AD_PASS_SECRET: OLD_SECRET } });
    const pass: string = (await admit(old)).adPass;
    const rotated = harness({ vars: { AD_PASS_KID: 'k2', AD_PASS_SECRET: SECRET, AD_PASS_PREVIOUS_KID: 'k1', AD_PASS_SECRET_PREVIOUS: OLD_SECRET } });
    assert.equal((await adCheck(rotated, pass)).status, 200);
    assert.equal((await admit(rotated)).adPass.split('.')[0], 'k2');
    const retired = harness({ vars: { AD_PASS_KID: 'k2', AD_PASS_SECRET: SECRET } });
    await denied(await adCheck(retired, pass));
  });
  it('expired pass is rejected', async () => {
    const h = harness();
    const pass = await maybeIssueAdPass(h.env, {
      request: new Request('https://x', { headers: { 'CF-Connecting-IP': IP, 'User-Agent': UA } }),
      sessionId: 's1', siteId: 1, siteKey: 'gamewhame.com', origin: 'https://gamewhame.com', eligible: true, affiliate: '42',
      nowMs: Date.now() - 1801_000,
    });
    assert.ok(pass);
    await denied(await adCheck(h, pass));
  });
  it('policy version change invalidates outstanding passes', async () => {
    const h = harness();
    const pass = (await admit(h)).adPass;
    (h.env as any).AD_PASS_POLICY_VERSION = '2';
    await denied(await adCheck(h, pass));
  });
  it('wrong origin (www vs apex) is rejected', async () => {
    const h = harness();
    const pass = (await admit(h)).adPass;
    await denied(await adCheck(h, pass, { origin: 'https://www.gamewhame.com' }));
  });
  it('cross-site: a gamewhame pass cannot be redeemed from jobsqualified', async () => {
    const h = harness();
    const pass = (await admit(h)).adPass;
    await denied(await adCheck(h, pass, { origin: 'https://jobsqualified.com' }));
  });
  it('unlisted origin is rejected without CORS headers', async () => {
    const h = harness();
    const pass = (await admit(h)).adPass;
    const res = await adCheck(h, pass, { origin: 'https://evil.example' });
    await denied(res);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
  it('IP binding: same /24 accepted, different /24 rejected', async () => {
    const h = harness();
    assert.equal((await adCheck(h, (await admit(h)).adPass, { ip: '203.0.113.200' })).status, 200);
    await denied(await adCheck(h, (await admit(h)).adPass, { ip: '203.0.114.7' }));
  });
  it('IPv6 binding: same /64 accepted, different /64 rejected', async () => {
    const h = harness();
    const v6 = '2001:db8:1:2:aaaa::1';
    assert.equal((await adCheck(h, (await admit(h, { ip: v6 })).adPass, { ip: '2001:db8:1:2:ffff:1:2:3' })).status, 200);
    await denied(await adCheck(h, (await admit(h, { ip: v6 })).adPass, { ip: '2001:db8:1:3::1' }));
  });
  it('User-Agent binding: different UA rejected', async () => {
    const h = harness();
    await denied(await adCheck(h, (await admit(h)).adPass, { ua: 'curl/8.0' }));
  });
});

describe('ad pass: single use', () => {
  it('release defaults: 30 minute pass, reusable', () => {
    assert.equal(config.vars.AD_PASS_TTL_SECONDS, '1800');
    assert.equal(config.vars.AD_PASS_SINGLE_USE, 'off');
  });
  it('replay is rejected when AD_PASS_SINGLE_USE=on', async () => {
    const h = harness({ vars: { AD_PASS_SINGLE_USE: 'on' } });
    const pass = (await admit(h)).adPass;
    assert.equal((await adCheck(h, pass)).status, 200);
    await denied(await adCheck(h, pass));
  });
  it('default (stateless) mode accepts reuse within TTL from the same IP+UA only', async () => {
    const h = harness({ vars: { AD_PASS_SINGLE_USE: undefined } });
    const pass = (await admit(h)).adPass;
    assert.equal((await adCheck(h, pass)).status, 200);
    assert.equal((await adCheck(h, pass)).status, 200);
    await denied(await adCheck(h, pass, { ip: '198.51.100.1' }));
  });
  it('stateless mode never calls the Durable Object', async () => {
    const h = harness({ vars: { AD_PASS_SINGLE_USE: 'off' } });
    const pass = (await admit(h)).adPass;
    h.state.guardThrows = true;
    assert.equal((await adCheck(h, pass)).status, 200);
  });
  it('replay guard unreachable denies when single use is on', async () => {
    const h = harness({ vars: { AD_PASS_SINGLE_USE: 'on' } });
    const pass = (await admit(h)).adPass;
    h.state.guardThrows = true;
    await denied(await adCheck(h, pass));
  });
});

describe('ad pass: kill switches', () => {
  for (const key of ['ads:global', 'ads:site:gamewhame.com', 'ads:aff:42']) {
    it(`${key}=off at admission issues no pass`, async () => {
      assert.equal((await admit(harness({ kv: { [key]: 'off' } }))).adPass, undefined);
    });
    it(`${key} flipped off between admit and ad-check denies`, async () => {
      const h = harness();
      const pass = (await admit(h)).adPass;
      h.kv.set(key, 'off');
      await denied(await adCheck(h, pass));
    });
  }
  it('explicit "on" allows; any other value disables', async () => {
    assert.ok((await admit(harness({ kv: { 'ads:global': 'on' } }))).adPass);
    assert.equal((await admit(harness({ kv: { 'ads:global': '0' } }))).adPass, undefined);
  });
  it('other site kill switch does not affect this site', async () => {
    assert.ok((await admit(harness({ kv: { 'ads:site:jobsqualified.com': 'off' } }))).adPass);
  });
  it('no ad-unit config is needed or read', async () => {
    const reads: string[] = [];
    const h = harness();
    const get = (h.env as any).IVT_CONFIG.get;
    (h.env as any).IVT_CONFIG.get = async (k: string) => { reads.push(k); return get(k); };
    const pass = (await admit(h)).adPass;
    assert.equal((await adCheck(h, pass)).status, 200);
    assert.ok(reads.every((k) => k.startsWith('ads:')), reads.join(','));
  });
  it('KV unreachable: admission still succeeds without a pass; ad-check denies', async () => {
    const h = harness({ kvThrows: true });
    const body = await admit(h);
    assert.equal(body.status, 'ADMITTED');
    assert.equal(body.adPass, undefined);
    const live = harness();
    const pass = (await admit(live)).adPass;
    live.state.kvThrows = true;
    await denied(await adCheck(live, pass));
  });
});

describe('ad pass: affiliates (several per site)', () => {
  it('each affiliate is carried into the pass and the aff key-value', async () => {
    const h = harness();
    for (const aff of ['42', '77', '999']) {
      const body = await admit(h, { aff });
      assert.equal(claimsOf(body.adPass).aff, aff);
      const approval: any = await (await adCheck(h, body.adPass)).json();
      assert.equal(approval.targeting.aff, aff);
    }
  });
  it('malformed affiliate gets no pass', async () => {
    assert.equal((await admit(harness(), { aff: 'x y' })).adPass, undefined);
  });
  it('no ?aff=: pass with aff=none (default)', async () => {
    const h = harness();
    const body = await admit(h, { aff: null });
    assert.equal(claimsOf(body.adPass).aff, null);
    const approval: any = await (await adCheck(h, body.adPass)).json();
    assert.equal(approval.targeting.aff, 'none');
  });
  it('AD_PASS_REQUIRE_AFFILIATE=on: no ?aff= means no pass', async () => {
    const h = harness({ vars: { AD_PASS_REQUIRE_AFFILIATE: 'on' } });
    assert.equal((await admit(h, { aff: null })).adPass, undefined);
    assert.ok((await admit(h, { aff: '42' })).adPass);
  });
  it('affiliate kill switch only affects that affiliate', async () => {
    const h = harness({ kv: { 'ads:aff:77': 'off' } });
    assert.equal((await admit(h, { aff: '77' })).adPass, undefined);
    assert.ok((await admit(h, { aff: '42' })).adPass);
  });
  it('affiliate kill switch flipped after admit stops that affiliate only', async () => {
    const h = harness();
    const p42 = (await admit(h, { aff: '42' })).adPass;
    const p77 = (await admit(h, { aff: '77' })).adPass;
    h.kv.set('ads:aff:77', 'off');
    assert.equal((await adCheck(h, p42)).status, 200);
    await denied(await adCheck(h, p77));
  });
  it('affiliate cannot be switched inside a pass', async () => {
    const h = harness();
    const pass: string = (await admit(h, { aff: '42' })).adPass;
    const [kid, , sig] = pass.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claimsOf(pass), aff: '77' })).toString('base64url');
    await denied(await adCheck(h, `${kid}.${forged}.${sig}`));
  });
});

describe('ad pass: helpers', () => {
  for (const [ip, expected] of [
    ['203.0.113.7', '203.0.113.0/24'],
    ['::ffff:203.0.113.7', '203.0.113.0/24'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002::1', '2001:db8:1:2::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['300.1.1.1', null], ['1:2:3', null], ['1::2::3', null], ['', null], ['garbage', null],
  ] as const) it(`ipPrefix(${JSON.stringify(ip)})`, () => assert.equal(ipPrefix(ip), expected));
});
