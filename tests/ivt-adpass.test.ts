import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const ivtJs = readFileSync('public/v1/ivt.js', 'utf8');
const gateJs = readFileSync('docs/ad-pass/ad-gate.js', 'utf8');
const noop = () => {};

function ivtContext(opts: { search?: string; admission?: object; admitOk?: boolean; sessionStorage?: any; onAdmit?: (body: any) => void }) {
  const window: any = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, setInterval: () => 1, devicePixelRatio: 1 };
  const search = opts.search ?? '';
  return {
    window,
    context: {
      window, crypto, URL, URLSearchParams, Intl, performance, clearInterval: noop, sessionStorage: opts.sessionStorage,
      CustomEvent: class { constructor(public type: string) {} },
      navigator: { userAgent: 'Test', language: 'en', languages: ['en'], cookieEnabled: true },
      location: { href: 'https://gamewhame.com/x' + search, search },
      screen: { width: 1000, height: 800, colorDepth: 24 },
      document: {
        currentScript: { dataset: { autoInit: 'true', endpoint: 'https://ivt.thebesads.com', siteKey: 'gamewhame.com' } },
        referrer: '', visibilityState: 'visible', hasFocus: () => true, addEventListener: noop, removeEventListener: noop,
        createElement: () => ({}), head: { appendChild: (s: any) => s.onload() },
      },
      fetch: async (_url: string, init: any) => {
        opts.onAdmit?.(JSON.parse(init.body));
        return { ok: opts.admitOk ?? true, json: async () => ({ status: 'ADMITTED', runtime: '/v1/runtime/x', telemetryToken: 't', expiresIn: 60, ...(opts.admission || {}) }) };
      },
    },
  };
}

for (const [label, admission, expected] of [
  ['valid pass', { adPass: 'k1.payload.sig' }, 'k1.payload.sig'],
  ['no pass', {}, undefined],
  ['non-string pass', { adPass: { forged: true } }, undefined],
  ['oversized pass', { adPass: 'x'.repeat(5000) }, undefined],
] as const) it(`ivt.js exposes the Ad Pass on its admission result: ${label}`, async () => {
  const p = ivtContext({ admission });
  runInNewContext(ivtJs, p.context);
  const result = await p.window.__THEBES_IVT_INIT__;
  assert.equal(result.adPass, expected);
  result.stopTelemetry?.();
});

it('ivt.js sends ?aff= and keeps it for later pages in the same tab', async () => {
  const store = new Map<string, string>();
  const sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  async function pageLoad(search: string) {
    let sent: any;
    const p = ivtContext({ search, sessionStorage, admission: { status: 'NO_RUNTIME' }, onAdmit: (b) => { sent = b; } });
    runInNewContext(ivtJs, p.context);
    await p.window.__THEBES_IVT_INIT__;
    return sent.attribution;
  }
  assert.equal((await pageLoad('?aff=42&utm_source=google')).aff, '42');
  assert.equal((await pageLoad('')).aff, '42', 'second page of the visit keeps the affiliate');
  assert.equal((await pageLoad('?aff=77')).aff, '77', 'a new landing replaces it');
  assert.equal((await pageLoad('?aff=bad%20id')).aff, '77', 'malformed value is ignored');
  store.clear();
  assert.equal((await pageLoad('')).aff, undefined, 'new tab without ?aff= sends none');
});

it('ivt.js bundle stays free of GAM / ad-unit knowledge', () => {
  for (const needle of ['doubleclick', 'googletag', 'gpt.js', 'ad-units', 'defineSlot', 'data-ad-slot']) {
    assert.ok(!ivtJs.includes(needle), `ivt.js must not contain ${needle}`);
  }
});

// ---------- reference gate (docs/ad-pass/ad-gate.js) ----------

type Reply = 'ok' | '403' | 'throw' | 'hang';
function gate(opts: { admission?: 'none' | 'reject' | 'hang' | 'late' | object; reply?: Reply; timeoutMs?: number }) {
  const listeners: Record<string, Array<() => void>> = {};
  const window: any = {
    addEventListener: (t: string, f: () => void) => { (listeners[t] ||= []).push(f); },
  };
  const a = opts.admission ?? { adPass: 'k1.p.s' };
  if (a === 'reject') window.__THEBES_IVT_INIT__ = Promise.reject(new Error('x'));
  else if (a === 'hang') window.__THEBES_IVT_INIT__ = new Promise(() => {});
  else if (a !== 'none' && a !== 'late') window.__THEBES_IVT_INIT__ = Promise.resolve(a);
  window.__THEBES_IVT_INIT__?.catch(() => {});
  const calls: any[] = [];
  const context: any = {
    window, setTimeout, clearTimeout, AbortController, Promise, JSON, Date, Array,
    fetch: async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), credentials: init.credentials, cache: init.cache });
      const reply = opts.reply ?? 'ok';
      if (reply === 'throw') throw new TypeError('network');
      if (reply === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      if (reply === '403') return { ok: false, status: 403, json: async () => null };
      return { ok: true, json: async () => ({ gpt: 'x', networkCode: '1', slots: [{ div: 'top' }], targeting: { aff: '42' } }) };
    },
  };
  runInNewContext(gateJs, context);
  const run = () => context.thebesAdGate({ timeoutMs: opts.timeoutMs ?? 200 });
  const fireInit = (value: object) => { window.__THEBES_IVT_INIT__ = Promise.resolve(value); (listeners['thebes:ivt-init'] || []).forEach((f) => f()); };
  return { run, calls, fireInit };
}

it('ad-gate.js: valid pass returns the server config', async () => {
  const g = gate({});
  const config = await g.run();
  assert.equal(config.targeting.aff, '42');
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].url, 'https://ivt.thebesads.com/v1/ad-units');
  assert.deepEqual(g.calls[0].body, { adPass: 'k1.p.s' });
  assert.equal(g.calls[0].credentials, 'omit');
  assert.equal(g.calls[0].cache, 'no-store');
});

it('ad-gate.js: ivt.js loading after the ad script still works', async () => {
  const g = gate({ admission: 'late', timeoutMs: 1000 });
  const pending = g.run();
  g.fireInit({ adPass: 'late.p.s' });
  assert.ok(await pending);
  assert.equal(g.calls[0].body.adPass, 'late.p.s');
});

for (const [label, opts, calls] of [
  ['ivt.js missing', { admission: 'none' }, 0],
  ['admission failed', { admission: 'reject' }, 0],
  ['admission too slow', { admission: 'hang' }, 0],
  ['no pass', { admission: { admitted: true } }, 0],
  ['non-string pass', { admission: { adPass: 123 } }, 0],
  ['server refused', { reply: '403' }, 1],
  ['server unreachable', { reply: 'throw' }, 1],
  ['server too slow', { reply: 'hang' }, 1],
] as const) it(`ad-gate.js: ${label} -> null (start no ads)`, async () => {
  const g = gate(opts as any);
  assert.equal(await g.run(), null);
  assert.equal(g.calls.length, calls);
});
