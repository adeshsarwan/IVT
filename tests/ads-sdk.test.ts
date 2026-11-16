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
  const makeEl = (name: string) => {
    const attrs: Record<string, string> = { 'data-ad-slot': name };
    return { id: '', getAttribute: (a: string) => attrs[a] ?? null, setAttribute: (a: string, v: string) => { attrs[a] = v; } };
  };
  const elements = (opts.placeholders ?? ['top', 'side']).map(makeEl);
  const observers: Array<() => void> = [];
  const context: any = {
    window, setTimeout,
    MutationObserver: class { constructor(private cb: () => void) {} observe() { observers.push(this.cb); } disconnect() { const i = observers.indexOf(this.cb); if (i >= 0) observers.splice(i, 1); } }, clearTimeout, AbortController, URL, URLSearchParams, Intl, performance, crypto, clearInterval: () => {},
    CustomEvent: class { constructor(public type: string) {} },
    navigator: { userAgent: 'Test', language: 'en', languages: ['en'], cookieEnabled: true },
    location: { href: 'https://gamewhame.com/', search: '' },
    screen: { width: 1000, height: 800, colorDepth: 24 },
    document: {
      currentScript: { src: 'https://ivt.thebesads.com/v1/ads.js', dataset: { timeoutMs: opts.timeoutMs ?? '200' } },
      referrer: '', visibilityState: 'visible', hasFocus: () => true, addEventListener: () => {}, removeEventListener: () => {},
      body: {},
      querySelectorAll: () => elements,
      createElement: () => ({}),
      querySelector: (sel: string) => (sel.includes(GPT) && calls.gptScripts > 0 ? {} : null),
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
  return { context, window, calls, elements, makeEl, observers, setReply: (r: AdUnitsReply) => { opts.adUnits = r; } };
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
  const pubads = { setTargeting: (k: string, v: unknown) => { targeting[k] = v; } };
  Object.assign(p.window.googletag, {
    pubads: () => pubads, enableServices: () => {}, display: (id: string) => displayed.push(id),
    defineSlot: (path: string, sizes: unknown, id: string) => { defined.push([path, sizes, id]); return { addService: () => {} }; },
  });
  p.window.googletag.cmd.forEach((f: () => void) => f());
  assert.deepEqual(defined.map(d => d[0]), ['/1234567/aff_42/top', '/1234567/aff_42/side']);
  assert.deepEqual(displayed, ['thebes-ad-top-1', 'thebes-ad-side-2']);
  assert.equal(targeting.ivt_k, 'abcdef0123');
  assert.equal(targeting.aff, '42');
  // Running the loader again on the same page does not redeem again.
  runInNewContext(adsJs, p.context);
  await p.window.__THEBES_ADS_INIT__;
  assert.equal(p.calls.adUnits, 1);
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
function stubGpt(p: ReturnType<typeof page>) {
  const defined: string[] = [];
  Object.assign(p.window.googletag, {
    pubads: () => ({ setTargeting: () => {} }), enableServices: () => {}, display: () => {},
    defineSlot: (path: string, _s: unknown, id: string) => { defined.push(id); return { addService: () => {} }; },
  });
  return defined;
}

it('ads.js: placeholders added later (SPA / infinite scroll) reuse the pass; GPT loaded once', async () => {
  const p = page({ admission: { adPass: 'p' } });
  assert.equal(await run(p), true);
  const defined = stubGpt(p);
  p.elements.push(p.makeEl('top'), p.makeEl('unknown'));
  p.observers.forEach((cb) => cb());
  await tick(400);
  assert.equal(p.calls.adUnits, 2, 'server re-checks the pass for new slots');
  assert.equal(p.calls.adUnitsBody.adPass, 'p');
  assert.equal(p.calls.gptScripts, 1);
  p.window.googletag.cmd.forEach((f: () => void) => f());
  assert.deepEqual(defined, ['thebes-ad-top-1', 'thebes-ad-side-2', 'thebes-ad-top-3']);
  // No pending placeholders -> mutations cause no extra calls.
  p.observers.forEach((cb) => cb());
  await tick(400);
  assert.equal(p.calls.adUnits, 2);
});

it('ads.js: later refusal (expired pass / kill switch) fills nothing and stops watching', async () => {
  const p = page({ admission: { adPass: 'p' } });
  assert.equal(await run(p), true);
  const cmds = p.window.googletag.cmd.length;
  p.setReply('403');
  p.elements.push(p.makeEl('top'));
  p.observers.forEach((cb) => cb());
  await tick(400);
  assert.equal(p.calls.adUnits, 2);
  assert.equal(p.window.googletag.cmd.length, cmds);
  assert.equal(p.observers.length, 0);
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

it('ivt.js sends ?aff= and keeps it for later pages in the same tab', async () => {
  const store = new Map<string, string>();
  const sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  async function pageLoad(search: string) {
    let sent: any;
    const noop = () => {};
    const window: any = { addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, setInterval: () => 1, devicePixelRatio: 1 };
    runInNewContext(ivtJs, {
      window, crypto, URL, URLSearchParams, Intl, performance, sessionStorage, clearInterval: noop,
      CustomEvent: class { constructor(public type: string) {} },
      navigator: { userAgent: 'Test', language: 'en', languages: ['en'], cookieEnabled: true },
      location: { href: 'https://gamewhame.com/x' + search, search },
      screen: { width: 1000, height: 800, colorDepth: 24 },
      document: {
        currentScript: { dataset: { autoInit: 'true', endpoint: 'https://ivt.thebesads.com', siteKey: 'gamewhame.com' } },
        referrer: '', visibilityState: 'visible', hasFocus: () => true, addEventListener: noop, removeEventListener: noop,
        createElement: () => ({}), head: { appendChild: (s: any) => s.onload() },
      },
      fetch: async (_url: string, init: any) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ status: 'NO_RUNTIME' }) }; },
    });
    await window.__THEBES_IVT_INIT__;
    return sent.attribution;
  }
  assert.equal((await pageLoad('?aff=42&utm_source=google')).aff, '42');
  assert.equal((await pageLoad('')).aff, '42', 'second page of the visit keeps the affiliate');
  assert.equal((await pageLoad('?aff=77')).aff, '77', 'a new landing replaces it');
  assert.equal((await pageLoad('?aff=bad%20id')).aff, '77', 'malformed value is ignored');
  store.clear();
  assert.equal((await pageLoad('')).aff, undefined, 'new tab without ?aff= sends none');
});
