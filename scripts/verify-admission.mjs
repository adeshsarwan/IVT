// Controlled production smoke test: creates real test sessions, never prints tokens/IPs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const baseline = process.argv.includes('--baseline');
const endpoint = 'https://ivt.thebesads.com';
const cases = baseline
  ? [['gamewhame.com', '', false], ['gamewhame.com', 'www.', false], ['gamewhame.com', '', true]]
  : ['gamewhame.com', 'jobsqualified.com'].flatMap(site => [[site, '', false], [site, 'www.', false], [site, '', true]]);
const results = [];
for (const [site, prefix, webdriver] of cases) {
  const origin = `https://${prefix}${site}`;
  const preflight = await fetch(`${endpoint}/v1/admit`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.ok([origin, '*'].includes(preflight.headers.get('access-control-allow-origin')));
  const response = await fetch(`${endpoint}/v1/admit`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ siteKey: site, nonce: randomUUID(), page: { href: `${origin}/` }, browser: { ua: `IVT controlled eligibility verification ${randomUUID()}`, webdriver, cookieEnabled: true } }),
  });
  assert.equal(response.status, 200);
  assert.ok([origin, '*'].includes(response.headers.get('access-control-allow-origin')));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.status, 'ADMITTED');
  assert.equal(body.expiresIn, 60);
  assert.match(body.runtime, /^\/v1\/runtime\/[a-f0-9]{64}$/);
  assert.equal(typeof body.telemetryToken, 'string');
  if (!baseline) {
    assert.equal(typeof body.monetization?.eligible, 'boolean');
    if (webdriver) assert.equal(body.monetization.eligible, false);
  }
  const { sid } = JSON.parse(Buffer.from(body.telemetryToken.split('.')[0], 'base64url').toString());
  const runtime = await fetch(endpoint + body.runtime, { headers: { referer: `${origin}/` } });
  assert.equal(runtime.status, 200);
  assert.match(await runtime.text(), /thebes:ivt-admitted/);
  const replay = await fetch(endpoint + body.runtime, { headers: { referer: `${origin}/` } });
  assert.equal(replay.status, 404);
  const telemetry = await fetch(`${endpoint}/v2/telemetry`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: body.telemetryToken, sequence: 0, eventType: 'final', elapsedMs: 0, visibleMs: 0, focusedMs: 0, activeMs: 0, maxScrollPct: 0, pointerEvents: 0, touchEvents: 0, keyEvents: 0, visibilityChanges: 0, focusChanges: 0 }),
  });
  assert.equal(telemetry.status, 200);
  results.push({ origin, webdriver, sid, cors: response.headers.get('access-control-allow-origin'), http: response.status, status: body.status, eligible: body.monetization?.eligible, fields: Object.keys(body), runtime: runtime.status, replay: replay.status, telemetry: telemetry.status });
}
const rejected = await fetch(`${endpoint}/v1/admit`, { method: 'POST', headers: { origin: 'https://unregistered.example', 'content-type': 'application/json' }, body: '{}' });
assert.equal(rejected.status, 403);
const health = await (await fetch(`${endpoint}/health`)).json();
assert.equal(health.mode, 'shadow');
const evidence = { baseline, health, unregisteredOrigin: rejected.status, results };
await writeFile(`.wrangler/eligibility-${baseline ? 'before' : 'after'}.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
