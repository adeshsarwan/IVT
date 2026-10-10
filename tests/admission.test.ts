import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { type Env } from '../src/worker';
import { monetizationEligibility } from '../src/eligibility';

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const sites = [
  { id: 1, site_key: 'gamewhame.com', hostname: 'gamewhame.com', enabled: 1, mode: 'shadow' },
  { id: 2, site_key: 'jobsqualified.com', hostname: 'jobsqualified.com', enabled: 1, mode: 'shadow' },
];
function harness(browser: object = { ua: 'Browser' }, origin = 'https://gamewhame.com', siteKey = 'gamewhame.com', count = 0) {
  const writes: Array<{ sql: string; values: any[] }> = [];
  const guards = new Map<string, any>();
  const env = {
    ...config.vars, IVT_HASH_SECRET: 'test-secret',
    DB: { prepare(sql: string) { return {
      values: [] as any[], bind(...values: any[]) { this.values = values; return this; },
      async first() {
        if (sql.startsWith('SELECT id, hostname')) return sites.find(s => s.site_key === this.values[0]) || null;
        if (sql.includes('COUNT(')) return { n: count };
        return null;
      },
      async run() {
        assert.equal((sql.match(/\?/g) || []).length, this.values.length);
        writes.push({ sql, values: this.values }); return { success: true };
      },
    }; } },
    IVT_CONFIG: { get: async () => null },
    REPLAY_GUARD: {
      idFromName: (name: string) => name,
      get: (name: string) => ({ fetch: async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        if (url.endsWith('/register')) { guards.set(name, body); return new Response('ok'); }
        const stored = guards.get(name);
        if (!stored || stored.origin !== body.origin || body.now > stored.expiresAt) return new Response('', { status: 404 });
        guards.delete(name); return new Response('ok');
      } }),
    },
  } as unknown as Env;
  const request = new Request('https://ivt.thebesads.com/v1/admit', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ siteKey, nonce: 'a'.repeat(32), page: { href: origin + '/test' }, browser }),
  });
  return { request, env, writes };
}

for (const [classification, decision, expected] of [
  ['CLEAN', 'WOULD_PASS', true], ['OBSERVE', 'WOULD_OBSERVE', false],
  ['SUSPICIOUS', 'WOULD_CHALLENGE', false], ['HIGH_RISK', 'WOULD_BLOCK', false],
  ['PROBABLE_IVT', 'WOULD_BLOCK', false], ['CLEAN', 'PASS', false],
  ['CLEAN', 'WOULD_BLOCK', false], ['SUSPICIOUS', 'WOULD_PASS', false], ['unknown', 'unknown', false],
] as const) it(`policy ${classification}/${decision}`, () => {
  assert.equal(monetizationEligibility(classification, decision), expected);
});

for (const [browser, count, score, classification, decision, eligible] of [
  [{ ua: 'Browser' }, 0, 0, 'CLEAN', 'WOULD_PASS', true],
  [{ cookieEnabled: false }, 0, 20, 'OBSERVE', 'WOULD_OBSERVE', false],
  [{ ua: 'Browser', webdriver: true }, 0, 45, 'SUSPICIOUS', 'WOULD_CHALLENGE', false],
  [{ webdriver: true }, 0, 60, 'HIGH_RISK', 'WOULD_BLOCK', false],
  [{ webdriver: true }, 30, 100, 'PROBABLE_IVT', 'WOULD_BLOCK', false],
] as const) it(`shadow admission preserves persisted ${classification}, score ${score}, runtime and token`, async () => {
  const h = harness(browser, undefined, undefined, count);
  const response = await worker.fetch(h.request, h.env);
  const body: any = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(body).sort(), ['status', 'monetization', 'runtime', 'telemetryToken', 'expiresIn'].sort());
  assert.equal(body.status, 'ADMITTED');
  assert.deepEqual(body.monetization, { eligible });
  assert.equal(body.expiresIn, 60);
  assert.match(body.runtime, /^\/v1\/runtime\/[a-f0-9]{64}$/);
  const claims = JSON.parse(Buffer.from(body.telemetryToken.split('.')[0], 'base64url').toString());
  assert.deepEqual(Object.keys(claims).sort(), ['sid', 'origin', 'exp', 'v'].sort());
  assert.equal(claims.origin, 'https://gamewhame.com');
  assert.equal(claims.v, 1);
  assert.ok(Math.abs(claims.exp - Date.now() - 7200000) < 2000);
  const stored = h.writes.find(w => w.sql.includes('INSERT INTO traffic_sessions'))!.values;
  assert.deepEqual(stored.slice(28, 32), [score, classification, decision, 'shadow']);
  assert.equal(stored[23], 0);
  const runtime = await worker.fetch(new Request('https://ivt.thebesads.com' + body.runtime, { headers: { Referer: 'https://gamewhame.com/test' } }), h.env);
  assert.equal(runtime.status, 200);
  assert.match(await runtime.text(), /thebes:ivt-admitted/);
  const replay = await worker.fetch(new Request('https://ivt.thebesads.com' + body.runtime, { headers: { Origin: claims.origin } }), h.env);
  assert.equal(replay.status, 404);
});

for (const site of sites) for (const prefix of ['', 'www.']) it(`${prefix}${site.hostname} admission and preflight succeed`, async () => {
  const origin = 'https://' + prefix + site.hostname;
  const h = harness(undefined, origin, site.site_key);
  const response = await worker.fetch(h.request, h.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal((await response.json() as any).monetization.eligible, true);
  assert.equal((await worker.fetch(new Request(h.request.url, { method: 'OPTIONS', headers: { origin } }), h.env)).status, 204);
});
for (const [origin, key] of [['https://unregistered.example', 'gamewhame.com'], ['https://jobsqualified.com', 'gamewhame.com'], ['https://gamewhame.com', 'unknown']]) {
  it(`rejects ${origin} / ${key}`, async () => {
    const h = harness(undefined, origin, key);
    assert.equal((await worker.fetch(h.request, h.env)).status, 403);
    assert.equal(h.writes.length, 0);
  });
}
it('release configuration preserves shadow, observe, existing origins and data-only registration', () => {
  assert.equal(config.vars.IVT_MODE, 'shadow');
  assert.equal(config.vars.IPINFO_MODE, 'observe');
  assert.deepEqual(config.vars.ALLOWED_ORIGINS.split(','), ['https://gamewhame.com', 'https://www.gamewhame.com', 'https://jobsqualified.com', 'https://www.jobsqualified.com']);
  assert.match(readFileSync('config/sites/jobsqualified.sql', 'utf8'), /VALUES \('jobsqualified.com', 'jobsqualified.com', 1, 'shadow'\)/);
});
