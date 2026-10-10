import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const sdk = readFileSync('public/v1/ivt.js', 'utf8');
for (const [label, payload, eligible, admitted] of [
  ['clean', { monetization: { eligible: true } }, true, true],
  ['suspicious', { monetization: { eligible: false } }, false, true],
  ['legacy response', {}, false, true],
  ['malformed eligibility', { monetization: { eligible: 'true' } }, false, true],
  ['missing eligibility', { monetization: {} }, false, true],
  ['null eligibility', { monetization: null }, false, true],
  ['rejected', { status: 'NO_RUNTIME' }, false, false],
] as const) it(`built SDK: ${label}, compatible admission and explicit eligibility`, async () => {
  let admissions = 0;
  let runtimes = 0;
  const noop = () => {};
  const window: any = { addEventListener: noop, removeEventListener: noop, setInterval: () => 123, devicePixelRatio: 1 };
  const context = {
    window, crypto, URL, URLSearchParams, Intl, performance, clearInterval: noop,
    navigator: { userAgent: 'Test', language: 'en', languages: ['en'], cookieEnabled: true },
    location: { href: 'https://gamewhame.com/', search: '' },
    screen: { width: 1000, height: 800, colorDepth: 24 },
    document: {
      currentScript: { dataset: { autoInit: 'true', endpoint: 'https://ivt.thebesads.com', siteKey: 'gamewhame.com' } },
      referrer: '', visibilityState: 'visible', hasFocus: () => true,
      addEventListener: noop, removeEventListener: noop,
      createElement: () => ({}), head: { appendChild: (script: any) => { runtimes++; script.onload(); } },
    },
    fetch: async (url: string) => {
      if (url.endsWith('/v1/admit')) admissions++;
      return { ok: true, json: async () => ({ status: 'ADMITTED', runtime: '/v1/runtime/test', telemetryToken: 'test-token', expiresIn: 60, ...payload }) };
    },
  };
  runInNewContext(sdk, context);
  const firstPromise = window.__THEBES_IVT_INIT__;
  runInNewContext(sdk, context);
  assert.equal(window.__THEBES_IVT_INIT__, firstPromise);
  const result = await firstPromise;
  assert.equal(result.admitted, admitted);
  assert.equal(result.monetizationEligible, eligible);
  assert.equal(admissions, 1);
  assert.equal(runtimes, admitted ? 1 : 0);
  if (admitted) {
    assert.equal(typeof result.stopTelemetry, 'function');
    result.stopTelemetry();
  }
});
