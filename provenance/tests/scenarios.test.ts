// The preset scenarios (same ones the demo page uses), end to end with default config.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario, runProvenance, SCENARIOS, type ScenarioId } from '../src/index';

const run = (id: ScenarioId, over = {}) => { const s = buildScenario(id); return runProvenance(s.input, { ...s.config, ...over }); };
const decided = (rep: ReturnType<typeof run>) => rep.windows.filter((w) => w.status !== 'OPEN' && w.status !== 'NO_VERDICT');
const has = (rep: ReturnType<typeof run>, code: string) => decided(rep).some((w) => w.reasons.some((r) => r.code === code && r.severity > 0));

describe('preset scenarios', () => {
  it('clean → OK, no KV change', () => {
    const rep = run('clean');
    assert.ok(decided(rep).length >= 4);
    for (const w of decided(rep)) assert.equal(w.tier, 'OK', `${w.key}#${w.index} ${w.reasons.map((r) => r.code)}`);
    assert.equal(rep.affiliates[0].tier, 'OK');
    assert.equal(rep.affiliates[0].actions[0].op, 'none');
  });

  it('bot farm → hard BLOCK, recommended only (manual by default)', () => {
    const rep = run('bot_farm');
    assert.ok(has(rep, 'low_match_rate') && has(rep, 'landings_exceed_clicks') && has(rep, 'flat_hour_curve'));
    assert.equal(decided(rep)[0].hard, true);
    assert.equal(rep.affiliates[0].tier, 'BLOCK');
    assert.deepEqual(rep.affiliates[0].actions[0], { op: 'suggest', key: 'ads:aff:13', value: 'off', note: rep.affiliates[0].actions[0].note });
    assert.ok(rep.affiliates[0].notes.some((n) => n.includes('by hand')));
  });

  it('bot farm with autoBlock on → kill switch put', () => {
    const rep = run('bot_farm', { enforcement: { autoBlock: true } });
    assert.deepEqual(rep.affiliates[0].actions[0], { op: 'put', key: 'ads:aff:13', value: 'off', note: rep.affiliates[0].actions[0].note });
  });

  it('placement abuse → BLOCK despite real clicks', () => {
    const rep = run('placement_abuse');
    assert.ok(decided(rep)[0].stats.matchRate!.rate! > 0.99);
    assert.ok(has(rep, 'blocked_placement') && has(rep, 'risky_network'));
    assert.equal(rep.affiliates[0].tier, 'BLOCK');
  });

  it('forgery / reuse → THROTTLE after one window, BLOCK after confirmation', () => {
    const rep = run('forgery_reuse');
    const d = decided(rep);
    assert.equal(d[0].breakerTier, 'THROTTLE');
    assert.equal(d[1].breakerTier, 'BLOCK');
    assert.ok(has(rep, 'invalid_click_id') && has(rep, 'reused_click_id'));
  });

  it('Meta Audience Network inflation → BLOCK', () => {
    const rep = run('meta_audience_network');
    assert.ok(has(rep, 'audience_network_share'));
    assert.equal(rep.affiliates[0].bySource.meta, 'BLOCK');
  });

  it('late data → PROVISIONAL windows, no unmatched, OK', () => {
    const rep = run('late_data');
    assert.ok(rep.windows.some((w) => w.status === 'PROVISIONAL'));
    for (const w of rep.windows) assert.equal(w.stats.outcomes.unmatched ?? 0, 0);
    assert.ok(rep.windows.every((w) => w.freshness?.stale));
    assert.equal(rep.affiliates[0].tier, 'OK');
  });

  it('too few samples → NO_VERDICT, holds OK', () => {
    const rep = run('small_sample');
    assert.ok(rep.windows.every((w) => w.status === 'NO_VERDICT'));
    assert.equal(rep.affiliates[0].tier, 'OK');
  });

  it('no access → THROTTLE floor', () => {
    const rep = run('no_access');
    assert.ok(decided(rep).every((w) => w.status === 'NO_ACCESS'));
    assert.equal(rep.affiliates[0].tier, 'THROTTLE');
    assert.equal(rep.affiliates[0].access.google, 'none');
  });

  it('auto-tagging off → THROTTLE, never BLOCK from missing ids alone', () => {
    const rep = run('autotag_off');
    assert.ok(has(rep, 'autotagging_off'));
    assert.ok(!has(rep, 'no_click_id'));
    assert.equal(rep.affiliates[0].tier, 'THROTTLE');
  });

  it('iOS braid-heavy → OK', () => {
    const rep = run('ios_braid');
    assert.equal(rep.affiliates[0].tier, 'OK');
    assert.ok(decided(rep)[0].stats.braidShare! > 0.35);
  });

  it('partial account → THROTTLE, access partial, not BLOCK', () => {
    const rep = run('partial_account');
    assert.ok(has(rep, 'partial_account_access'));
    assert.equal(rep.affiliates[0].tier, 'THROTTLE');
    assert.equal(rep.affiliates[0].access.google, 'partial');
  });

  it('platform down → UNKNOWN, holds within grace; THROTTLE past grace', () => {
    const rep = run('platform_down');
    assert.ok(decided(rep).every((w) => w.status === 'UNKNOWN'));
    assert.equal(rep.affiliates[0].tier, 'OK');
    const short = run('platform_down', { breaker: { unknownGraceMs: 12 * 3600_000, blockConfirmWindows: 2, recoverWindows: 3, manualUnblock: true } });
    assert.equal(short.affiliates[0].tier, 'THROTTLE');
  });

  it('zero platform data → hard BLOCK', () => {
    const rep = run('zero_platform_data');
    assert.ok(has(rep, 'platform_reports_zero_clicks'));
    assert.equal(rep.affiliates[0].tier, 'BLOCK');
  });

  it('window size 10,000 gives one count window per 10k', () => {
    const rep = run('clean', { windowSize: 10000 });
    const g = rep.windows.filter((w) => w.source === 'google');
    assert.ok(g.every((w) => w.stats.requests <= 10000));
    assert.equal(rep.affiliates[0].tier, 'OK');
  });

  it('sampling at 20% gives the same verdicts', () => {
    for (const id of ['clean', 'bot_farm', 'placement_abuse'] as const) {
      const full = run(id).affiliates[0].tier;
      const sampled = run(id, { sampleRate: 0.2 });
      assert.equal(sampled.affiliates[0].tier, full, id);
      assert.ok(decided(sampled)[0].stats.sampled < decided(sampled)[0].stats.requests * 0.3);
    }
  });

  it('every scenario is deterministic (same input → identical report)', () => {
    for (const id of Object.keys(SCENARIOS) as ScenarioId[]) {
      assert.equal(JSON.stringify(run(id)), JSON.stringify(run(id)), id);
    }
  });
});
