// Circuit breaker with hysteresis, per affiliate × source.
// Fast to go up (WATCH/THROTTLE immediately, BLOCK after confirmation or on a hard reason),
// slow to come down (one tier per `recoverWindows` consecutive better windows; BLOCK manual).

import type { ProvenanceConfig } from './config';
import { TIERS, type BreakerState, type Severity, type Tier, type WindowResult } from './types';

export const initialBreaker = (): BreakerState => ({ tier: 'OK', blockStreak: 0, cleanStreak: 0, unknownSince: null, awaitingManualUnblock: false });

const idx = (t: Tier) => TIERS.indexOf(t) as Severity;

export function applyWindow(prev: BreakerState, w: Pick<WindowResult, 'status' | 'severity' | 'hard' | 'start' | 'end'>, cfg: ProvenanceConfig): { state: BreakerState; note: string } {
  const s: BreakerState = { ...prev };
  const cur = idx(s.tier);

  // Windows that carry no decision: hold.
  if (w.status === 'OPEN' || w.status === 'NO_VERDICT') return { state: s, note: `hold (${w.status})` };

  if (w.status === 'UNKNOWN') {
    if (s.unknownSince === null) s.unknownSince = w.start;
    if (w.end - s.unknownSince >= cfg.breaker.unknownGraceMs && cur < 2) {
      s.tier = 'THROTTLE'; s.cleanStreak = 0;
      return { state: s, note: `platform data unavailable > ${cfg.breaker.unknownGraceMs / 3600_000}h grace → THROTTLE` };
    }
    // Edge-only evidence still escalates even while the platform is down.
    if (w.severity > cur) return escalate(s, w, cfg);
    return { state: s, note: 'hold (UNKNOWN, within grace)' };
  }
  s.unknownSince = null;

  if (w.severity > cur) return escalate(s, w, cfg);
  s.blockStreak = w.severity === 3 ? s.blockStreak + 1 : 0;

  if (w.severity < cur) {
    s.cleanStreak++;
    if (s.cleanStreak >= cfg.breaker.recoverWindows) {
      if (s.tier === 'BLOCK' && cfg.breaker.manualUnblock) {
        s.awaitingManualUnblock = true;
        return { state: s, note: `BLOCK held: ${s.cleanStreak} clean windows, awaiting manual unblock` };
      }
      const from = s.tier;
      s.tier = TIERS[cur - 1];
      s.cleanStreak = 0;
      return { state: s, note: `recovered ${from} → ${s.tier} after ${cfg.breaker.recoverWindows} better windows` };
    }
    return { state: s, note: `hold ${s.tier} (${s.cleanStreak}/${cfg.breaker.recoverWindows} better windows)` };
  }
  s.cleanStreak = 0;
  return { state: s, note: `hold ${s.tier}` };
}

function escalate(s: BreakerState, w: Pick<WindowResult, 'severity' | 'hard'>, cfg: ProvenanceConfig) {
  s.cleanStreak = 0;
  const from = s.tier;
  if (w.severity === 3) {
    s.blockStreak++;
    if (w.hard || s.blockStreak >= cfg.breaker.blockConfirmWindows) {
      s.tier = 'BLOCK';
      return { state: s, note: `${from} → BLOCK (${w.hard ? 'hard reason' : `${s.blockStreak} consecutive BLOCK windows`})` };
    }
    s.tier = 'THROTTLE';
    return { state: s, note: `${from} → THROTTLE (BLOCK pending confirmation ${s.blockStreak}/${cfg.breaker.blockConfirmWindows})` };
  }
  s.blockStreak = 0;
  s.tier = TIERS[w.severity];
  return { state: s, note: `${from} → ${s.tier}` };
}

/** Manual action by a human (audit-logged elsewhere): reset an affiliate × source to a tier. */
export function manualReset(prev: BreakerState, tier: Tier = 'WATCH'): BreakerState {
  return { ...prev, tier, blockStreak: 0, cleanStreak: 0, awaitingManualUnblock: false };
}
