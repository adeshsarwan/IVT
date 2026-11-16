import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const adsJs = readFileSync('public/v1/ads.js', 'utf8');
const ivtJs = readFileSync('public/v1/ivt.js', 'utf8');
const GPT = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';
const units = {
  gpt: GPT, networkCode: '1234567',
  slots: [
    { div: 'top', path: '/1234567/aff_42/top', sizes: [[300, 250]] },
    { div: 'side', path: '/1234567/aff_42/side', sizes: [[160, 600]] },
  ],
  targeting: { aff: '42', ivt_k: 'abcdef0123', ivt_t: '0123456789ab', ivt_e: '1' },
};

type AdUnitsReply = 'ok' | '403' | 'throw' | 'hang' | object;
function page(opts: { admission?: 'none' | 'reject' | 'hang' | object; adUnits?: AdUnitsReply; placeholders?: string[]; timeoutMs?: string }) {
  const listeners = new Map<string, Set<() => void>>();
  const window: any = {
    addEventListener: (t: string, f: () => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f); },
    removeEventListener: (t: string, f: () => void) => listeners.get(t)?.delete(f),
    dispatchEvent: (e: { type: string }) => { for (const f of [...(listeners.get(e.type) || [])]) f(); return true; },
    setInterval: () => 1, devicePixelRatio: 1,
  };
  if (opts.admission && opts.admission !== 'none') {
    window.__THEBES_IVT_INIT__ = opts.admission === 'reject' ? Promise.reject(new Error('blocked'))
      : opts.admission === 'hang' ? new Promise(() => {}) : Promise.resolve(opts.admission);
    window.__THEBES_IVT_INIT__.catch(() => {});
  }
  const calls = { adUnits: 0, adUnitsBody: null as any, gptScripts: 0, other: [] as string[] };
  const elements = (opts.placeholders ?? ['top', 'side']).map((name) => ({ id: '', getAttribute: (a: string) => a === 'data-ad-slot' ? name : null }));
  const context: any = {
    window, setTimeout, clearTimeout, AbortController, URL, URLSearchParams, Intl, performance, crypto, clearInterval: () => {},
    CustomEvent: class { constructor(public type: string) {} },
    navigator: { userAgent: 'Test', language: 'en', languages: ['en'], cookieEnabled: true },
    location: { href: 'https://gamewhame.com/', search: '' },
    screen: { width: 1000, height: 800, colorDepth: 24 },
    document: {
      currentScript: { src: 'https://ivt.thebesads.com/v1/ads.js', dataset: { timeoutMs: opts.timeoutMs ?? '200' } },
      referrer: '', visibilityState: 'visible', hasFocus: () => true, addEventListener: () => {}, removeEventListener: () => {},
      querySelectorAll: () => elements,
      createElement: () => ({}),
      head: { appendChild: (s: any) => { if (s.src === GPT) calls.gptScripts++; else { calls.other.push(s.src); s.onload?.(); } } },
    },
    fetch: async (url: string, init: any) => {
      if (url.endsWith('/v1/admit')) {
        if (opts.admission === 'reject') return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ status: 'ADMITTED', runtime: '/v1/runtime/x', telemetryToken: 't', expiresIn: 60, ...(opts.admission as object) }) };
      }
      assert.equal(url, 'https://ivt.thebesads.com/v1/ad-units');
      calls.adUnits++;
      calls.adUnitsBody = JSON.parse(init.body);
      assert.equal(init.credentials, 'omit');
      assert.equal(init.cache, 'no-store');
      const reply = opts.adUnits ?? 'ok';
      if (reply === 'throw') throw new TypeError('network');
      if (reply === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      if (reply === '403') return { ok: false, status: 403, json: async () => null };
      return { ok: true, json: async () => (reply === 'ok' ? units : reply) };
    },
  };
  return { context, window, calls, elements };
}
const run = async (p: ReturnType<typeof page>) => { runInNewContext(adsJs, p.context); return p.window.__THEBES_ADS_INIT__ as Promise<boolean>; };

it('ads.js: valid pass -> one ad-units call, GPT loaded, slots + targeting defined', async () => {
  const admission = { admitted: true, adPass: 'k1.payload.sig' };
  const p = page({ admission });
  assert.equal(await run(p), true);
  assert.equal(p.calls.adUnits, 1);
  assert.deepEqual(p.calls.adUnitsBody, { adPass: 'k1.payload.sig' });
  assert.equal(p.calls.gptScripts, 1);
  assert.equal((admission as any).adPass, undefined, 'pass is consumed from the shared admission result');
  const defined: any[] = [];
  const targeting: Record<string, unknown> = {};
  const displayed: string[] = [];
  const pubads = { setTargeting: (k: string, v: unknown) => { targeting[k] = v; }, enableSingleRequest: () => {} };
  Object.assign(p.window.googletag, {
    pubads: () => pubads, enableServices: () => {}, display: (id: string) => displayed.push(id),
    defineSlot: (path: string, sizes: unknown, id: string) => { defined.push([path, sizes, id]); return { addService: () => {} }; },
  });
  p.window.googletag.cmd.forEach((f: () => void) => f());
  assert.deepEqual(defined.map(d => d[0]), ['/1234567/aff_42/top', '/1234567/aff_42/side']);
  assert.deepEqual(displayed, ['thebes-ad-top', 'thebes-ad-side']);
  assert.equal(targeting.ivt_k, 'abcdef0123');
  assert.equal(targeting.aff, '42');
  // Running the loader again on the same page does not redeem again.
  runInNewContext(adsJs, p.context);
  await p.window.__THEBES_ADS_INIT__;
  assert.equal(p.calls.adUnits, 1);
});

for (const [label, opts, adUnitsCalls] of [
  ['admission rejected', { admission: 'reject' }, 0],
  ['admission times out', { admission: 'hang' }, 0],
  ['ivt.js never ran', { admission: 'none' }, 0],
  ['admission without a pass', { admission: { admitted: true, monetizationEligible: false } }, 0],
  ['non-string pass', { admission: { adPass: { forged: true } } }, 0],
  ['ad-units 403', { admission: { adPass: 'p' }, adUnits: '403' }, 1],
  ['ad-units network error', { admission: { adPass: 'p' }, adUnits: 'throw' }, 1],
  ['ad-units hangs (aborted at deadline)', { admission: { adPass: 'p' }, adUnits: 'hang' }, 1],
  ['ad-units returns a foreign script URL', { admission: { adPass: 'p' }, adUnits: { ...units, gpt: 'https://evil.example/gpt.js' } }, 1],
  ['ad-units returns malformed slots', { admission: { adPass: 'p' }, adUnits: { ...units, slots: [{ div: 'top' }] } }, 1],
  ['ad-units slot outside network code', { admission: { adPass: 'p' }, adUnits: { ...units, slots: [{ div: 'top', path: '/999/x', sizes: [[1, 1]] }] } }, 1],
  ['no matching placeholders', { admission: { adPass: 'p' }, placeholders: ['other'] }, 1],
] as const) it(`ads.js: ${label} -> no GPT request`, async () => {
  const p = page(opts as any);
  assert.equal(await run(p), false);
  assert.equal(p.calls.adUnits, adUnitsCalls);
  assert.equal(p.calls.gptScripts, 0);
  assert.equal(p.window.googletag, undefined);
});

it('ads.js loaded before ivt.js picks up admission via thebes:ivt-init', async () => {
  const p = page({ admission: 'none', timeoutMs: '2000' });
  const done = run(p);
  p.window.__THEBES_IVT_INIT__ = Promise.resolve({ adPass: 'late' });
  p.window.dispatchEvent({ type: 'thebes:ivt-init' });
  assert.equal(await done, true);
  assert.equal(p.calls.gptScripts, 1);
});

it('end to end with built ivt.js: no adPass in admission -> no GPT; adPass -> GPT', async () => {
  for (const [admission, expected] of [[{ adPass: undefined }, 0], [{ adPass: 'k1.a.b' }, 1]] as const) {
    const p = page({ admission: admission as object, timeoutMs: '2000' });
    p.context.document.currentScript = { dataset: { autoInit: 'true', endpoint: 'https://ivt.thebesads.com', siteKey: 'gamewhame.com' } };
    const done = new Promise<void>((resolve) => p.window.addEventListener('thebes:ivt-init', () => resolve()));
    // ivt.js only creates the promise if absent; start clean.
    delete p.window.__THEBES_IVT_INIT__;
    runInNewContext(ivtJs, p.context);
    await done;
    p.context.document.currentScript = { src: 'https://ivt.thebesads.com/v1/ads.js', dataset: { timeoutMs: '2000' } };
    await run(p);
    assert.equal(p.calls.gptScripts, expected);
    (await p.window.__THEBES_IVT_INIT__).stopTelemetry?.();
  }
});

it('end to end with built ivt.js: admission HTTP failure -> no GPT', async () => {
  const p = page({ admission: 'reject', timeoutMs: '2000' });
  delete p.window.__THEBES_IVT_INIT__;
  p.context.document.currentScript = { dataset: { autoInit: 'true', endpoint: 'https://ivt.thebesads.com', siteKey: 'gamewhame.com' } };
  runInNewContext(ivtJs, p.context);
  p.context.document.currentScript = { src: 'https://ivt.thebesads.com/v1/ads.js', dataset: { timeoutMs: '2000' } };
  assert.equal(await run(p), false);
  assert.equal(p.calls.gptScripts, 0);
  assert.equal(p.calls.adUnits, 0);
});

it('ivt.js bundle stays free of GAM / ad-unit knowledge', () => {
  for (const needle of ['doubleclick', 'googletag', 'gpt.js', 'ad-units', 'defineSlot', 'data-ad-slot']) {
    assert.ok(!ivtJs.includes(needle), `ivt.js must not contain ${needle}`);
  }
});
