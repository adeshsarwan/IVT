// The whole pipeline: normalize → windows → per-window evaluation → verdict → breaker → KV plan.
// Pure: same input + config ⇒ same report, byte for byte.

import { makeConfig, type ConfigOverrides, type ProvenanceConfig } from './config';
import { applyWindow, initialBreaker } from './breaker';
import { evaluateGoogle, type PlatformEval } from './google';
import { evaluateMeta } from './meta';
import { normalizeAll } from './normalize';
import { buildReuseIndex, highBad, hourCurve, last24h } from './rules';
import { buildWindows } from './windows';
import { TIERS, type AffiliateResult, type BreakerState, type KvAction, type NormalizedRequest, type ProvenanceInput, type ProvenanceReport, type Reason, type Severity, type Source, type Tier, type WindowResult } from './types';
import { rateStat, toMs } from './util';

/** Window severity = worst applicable reason. For UNKNOWN / NO_ACCESS only edge-only reasons apply. */
export function decide(status: WindowResult['status'], reasons: Reason[]): { severity: Severity; hard: boolean } {
  const applicable = status === 'UNKNOWN' || status === 'NO_ACCESS' ? reasons.filter((r) => r.edgeOnly) : reasons;
  let severity: Severity = 0;
  let hard = false;
  for (const r of applicable) {
    if (r.severity > severity) severity = r.severity;
    if (r.severity === 3 && r.hard) hard = true;
  }
  return { severity, hard };
}

function evaluateUnknown(win: NormalizedRequest[], group: NormalizedRequest[], cfg: ProvenanceConfig): PlatformEval {
  const skipped: string[] = [];
  const reasons: Reason[] = [{ code: 'unattributed_traffic', severity: 1, edgeOnly: true, n: win.length,
    message: `${win.length} landings with no platform claim (route/src/utm) and no click id: provenance unverifiable` }];
  const withIds = win.filter((r) => r.unexpandedMacros.length > 0).length;
  const inv = highBad('invalid_click_id', 'unexpanded macros', rateStat(withIds, win.length, cfg.z), cfg.invalidClickId, cfg, skipped, { edgeOnly: true });
  if (inv) reasons.push(inv);
  const hc = hourCurve(last24h(win, group), 'UTC', cfg);
  if (hc.reason) reasons.push(hc.reason);
  return { status: 'VERDICT', reasons, freshness: null, access: 'none',
    stats: { requests: win.length, sampled: win.filter((r) => r.inSample).length, outcomes: {}, hourCurveEntropy: hc.entropy } };
}

export function runProvenance(input: ProvenanceInput, overrides: ConfigOverrides | ProvenanceConfig = {}): ProvenanceReport {
  const cfg = makeConfig(overrides as ConfigOverrides);
  const now = toMs(input.now);
  if (now === null) throw new Error('input.now is required (ISO or ms) so results are deterministic');

  const norm = normalizeAll(input.requests || [], cfg);
  const reuse = buildReuseIndex(norm.requests);
  const groups = new Map<string, NormalizedRequest[]>();
  for (const r of norm.requests) {
    const k = `${r.aff}|${r.claimed}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }

  const windows: WindowResult[] = [];
  const breakers: Record<string, BreakerState> = {};
  const access: Record<string, AffiliateResult['access']> = {};

  for (const w of buildWindows(norm.requests, cfg, now)) {
    const group = groups.get(w.key)!;
    const pd = input.platform?.[w.aff];
    let ev: PlatformEval;
    if (w.source === 'google') ev = evaluateGoogle(w.requests, group, pd?.google, cfg, now, reuse);
    else if (w.source === 'meta') ev = evaluateMeta(w.requests, group, pd?.meta, cfg, now, reuse);
    else ev = evaluateUnknown(w.requests, group, cfg);

    let status = ev.status;
    const reasons = [...ev.reasons];
    if (w.closedBy === 'open') status = 'OPEN';
    else if (w.requests.length < cfg.minWindowRequests) {
      status = 'NO_VERDICT';
      reasons.unshift({ code: 'window_too_small', severity: 0, n: w.requests.length, threshold: cfg.minWindowRequests,
        message: `${w.requests.length} requests < minimum ${cfg.minWindowRequests}: no verdict (breaker holds)` });
    }
    const { severity, hard } = decide(status, reasons);
    if (w.source !== 'unknown') (access[w.aff] ??= {})[w.source] = ev.access;

    const prev = breakers[w.key] ?? input.previous?.[w.key] ?? initialBreaker();
    const { state, note } = applyWindow(prev, { status, severity, hard, start: w.start, end: w.end }, cfg);
    breakers[w.key] = state;

    windows.push({
      key: w.key, aff: w.aff, source: w.source, index: w.index, start: w.start, end: w.end, closedBy: w.closedBy,
      status, severity, tier: TIERS[severity], hard, reasons: sortReasons(reasons), stats: ev.stats, freshness: ev.freshness,
      breakerTier: state.tier, breakerNote: note,
    });
  }

  // Carry forward previous breakers that had no windows this run.
  for (const [k, v] of Object.entries(input.previous ?? {})) if (!breakers[k]) breakers[k] = v;

  return {
    config: cfg,
    totals: { input: (input.requests || []).length, duplicatesDropped: norm.duplicatesDropped, invalidDropped: norm.invalidDropped, normalized: norm.requests.length },
    windows,
    breakers,
    affiliates: affiliateSummary(breakers, access, cfg.enforcement.autoBlock),
  };
}

const sortReasons = (r: Reason[]) => [...r].sort((a, b) => b.severity - a.severity);

export function affiliateSummary(breakers: Record<string, BreakerState>, access: Record<string, AffiliateResult['access']>, autoBlock = false): AffiliateResult[] {
  const byAff = new Map<string, Partial<Record<Source, Tier>>>();
  const manual = new Set<string>();
  for (const [k, st] of Object.entries(breakers)) {
    const [aff, source] = k.split('|') as [string, Source];
    (byAff.get(aff) ?? byAff.set(aff, {}).get(aff)!)[source] = st.tier;
    if (st.awaitingManualUnblock) manual.add(aff);
  }
  return [...byAff.keys()].sort().map((aff) => {
    const bySource = byAff.get(aff)!;
    const tier = TIERS[Math.max(...Object.values(bySource).map((t) => TIERS.indexOf(t!)))];
    const notes: string[] = [];
    if (manual.has(aff)) notes.push('BLOCK held: recent windows are clean, a human may unblock (manualReset)');
    if (tier === 'BLOCK' && !autoBlock) notes.push('BLOCK recommended: review the evidence, then turn the kill switch on by hand');
    return { aff, tier, bySource, access: access[aff] ?? {}, actions: kvPlan(aff, tier, autoBlock), notes };
  });
}

/** What to write to the Ad Pass KV (`IVT_CONFIG`). This module never writes.
 *  autoBlock = false (default): every write is a 'suggest' that a human approves and applies.
 *  autoBlock = true: 'put' actions for an audited job to apply (shadow first). */
export function kvPlan(aff: string, tier: Tier, autoBlock = false): KvAction[] {
  const write = autoBlock ? 'put' : 'suggest';
  if (aff === '(none)') return [{ op: 'none', key: '-', note: 'house traffic (no aff): no per-affiliate switch; use ads:site:<siteKey> if needed' }];
  const key = `ads:aff:${aff}`;
  switch (tier) {
    case 'BLOCK': return [{ op: write, key, value: 'off', note: autoBlock
      ? 'kill switch: no Ad Pass / ad units for this affiliate on any site'
      : 'RECOMMENDED kill switch: a human reviews the evidence and sets this by hand (no automatic block)' }];
    case 'THROTTLE': return [
      { op: 'none', key, note: 'keep ads on (Ad Pass is on/off only today)' },
      { op: write, key: `adcap:aff:${aff}`, value: 'reduced', note: 'PROPOSED key, not read by the Worker yet: reduced ad load (1 slot, no refresh)' },
    ];
    case 'WATCH': return [{ op: 'none', key, note: 'no change; alert + review' }];
    default: return [{ op: 'none', key, note: 'no change (key absent or "on")' }];
  }
}
