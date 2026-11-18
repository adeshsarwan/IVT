// Traffic Provenance Hook A: SDK forwards the tracking-template keys (A1) and /v1/admit queues the
// landing for the separate provenance pipeline (A2) — off by default, fire-and-forget, never breaks admit.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import worker, { type Env } from '../src/worker';
import { buildLanding, uaDevice } from '../src/provenance-hook';

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const ivtJs = readFileSync('public/v1/ivt.js', 'utf8');
const noop = () => {};

function harness(vars: Record<string, string> = {}, queue?: { send(b: unknown): Promise<void> }) {
  const sent: any[] = [];
  const waited: Promise<unknown>[] = [];
  const env = {
    ...config.vars, IVT_HASH_SECRET: 'test-secret', ...vars,
    ...(queue !== undefined ? { PROVENANCE_Q: queue } : { PROVENANCE_Q: { send: async (b: unknown) => { sent.push(b); } } }),
    DB: { prepare(sql: string) { return {
      values: [] as any[], bind(...v: any[]) { this.values = v; return this; },
      async first() {
        if (sql.startsWith('SELECT id, hostname')) return this.values[0] === 'gamewhame.com' ? { id: 1, hostname: 'gamewhame.com', enabled: 1, mode: 'shadow' } : null;
        if (sql.includes('COUNT(')) return { n: 0 };
        return null;
      },
      async run() { return { success: true }; },
    }; } },
    IVT_CONFIG: { get: async () => null },
    REPLAY_GUARD: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response('ok') }) },
  } as unknown as Env;
  const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException: noop } as unknown as ExecutionContext;
  return { env, ctx, sent, waited };
}

const href = 'https://gamewhame.com/games/x?aff=42&gclid=Cj0KCQiAabc&cid=111&ag=222&net=g&dev=m&plc=&route=g42';
async function admit(h: ReturnType<typeof harness>, attribution: object = { aff: '42', gclid: 'Cj0KCQiAabc' }) {
  const res = await worker.fetch(new Request('https://ivt.thebesads.com/v1/admit', {
    method: 'POST',
    headers: { origin: 'https://gamewhame.com', 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'x' },
    body: JSON.stringify({ siteKey: 'gamewhame.com', nonce: 'a'.repeat(32), page: { href }, browser: { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile' }, attribution }),
  }), h.env, h.ctx);
  assert.equal(res.status, 200);
  return res.json() as Promise<any>;
}

it('A2 is off by default: nothing is queued', async () => {
  const h = harness();
  assert.equal((await admit(h)).status, 'ADMITTED');
  assert.equal(h.sent.length, 0);
});

it('A2 on: one landing message per admit, via waitUntil, in the pipeline message shape', async () => {
  const h = harness({ PROVENANCE_MODE: 'on' });
  assert.equal((await admit(h)).status, 'ADMITTED');
  assert.equal(h.waited.length, 1);
  await Promise.all(h.waited);
  assert.equal(h.sent.length, 1);
  const msg = h.sent[0];
  assert.equal(msg.type, 'landings');
  const r = msg.rows[0];
  assert.equal(r.site, 'gamewhame.com');
  assert.equal(r.aff, '42');
  assert.equal(r.route, 'g42');
  assert.equal(r.uaDevice, 'mobile');
  assert.match(r.url, /gclid=Cj0KCQiAabc/);
  assert.match(r.url, /cid=111&ag=222/);
  assert.match(r.ipHash, /^[0-9a-f]{64}$/, 'only the keyed hash of the IP leaves the Worker');
  assert.ok(!JSON.stringify(msg).includes('203.0.113.7'));
});

it('A2 never breaks admit: queue rejects, queue throws, or binding missing', async () => {
  for (const q of [{ send: async () => { throw new Error('down'); } }, { send: () => { throw new Error('sync'); } }, undefined as any]) {
    const h = harness({ PROVENANCE_MODE: 'on' }, q ?? (null as any));
    assert.equal((await admit(h)).status, 'ADMITTED');
    await Promise.allSettled(h.waited);
  }
});

it('buildLanding: fills params the SDK sent when the page URL was cut short; rejects odd routes', () => {
  const l = buildLanding({ sessionId: 's', now: 1, siteHost: 'gamewhame.com', href: 'https://gamewhame.com/p', aff: '7',
    attribution: { gclid: 'Cj0x', cid: '9', route: 'bad route!' }, ipHash: null, uaHash: null, ua: '' });
  assert.equal(l.url, 'https://gamewhame.com/p?gclid=Cj0x&cid=9&route=bad+route%21');
  assert.equal(l.route, null);
  assert.equal(l.uaDevice, null);
  assert.equal(buildLanding({ sessionId: 's', now: 1, siteHost: 'a.com', href: 'not a url', aff: undefined, ipHash: null, uaHash: null, ua: 'x' }).url, 'https://a.com/');
  assert.deepEqual([uaDevice('Mozilla/5.0 (iPad; CPU OS 17_0)'), uaDevice('Mozilla/5.0 (Windows NT 10.0)'), uaDevice('Android 14; Mobile')], ['tablet', 'desktop', 'mobile']);
});

it('A1: the SDK forwards cid / ag / net / dev / plc / route alongside gclid', async () => {
  let sent: any;
  const search = '?aff=42&gclid=Cj0abc&cid=111&ag=222&net=d&dev=c&plc=example.com&route=g42&other=x';
  const window: any = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, setInterval: () => 1, devicePixelRatio: 1 };
  runInNewContext(ivtJs, {
    window, crypto, URL, URLSearchParams, Intl, performance, clearInterval: noop, sessionStorage: undefined,
    CustomEvent: class { constructor(public type: string) {} },
    navigator: { userAgent: 'Test', language: 'en', languages: ['en'], cookieEnabled: true },
    location: { href: 'https://gamewhame.com/x' + search, search },
    screen: { width: 1000, height: 800, colorDepth: 24 },
    document: {
      currentScript: { dataset: { autoInit: 'true', endpoint: 'https://ivt.thebesads.com', siteKey: 'gamewhame.com' } },
      referrer: '', visibilityState: 'visible', hasFocus: () => true, addEventListener: noop, removeEventListener: noop,
      createElement: () => ({}), head: { appendChild: (s: any) => s.onload() },
    },
    fetch: async (_u: string, init: any) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ status: 'NO_RUNTIME' }) }; },
  });
  await window.__THEBES_IVT_INIT__;
  assert.deepEqual(sent.attribution, { gclid: 'Cj0abc', cid: '111', ag: '222', net: 'd', dev: 'c', plc: 'example.com', route: 'g42', aff: '42' });
});
