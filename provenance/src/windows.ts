// Sampling windows: per affiliate × claimed source, close every N requests or every T time.

import type { ProvenanceConfig } from './config';
import type { NormalizedRequest, Source } from './types';

export interface Window {
  key: string;
  aff: string;
  source: Source;
  index: number;
  start: number;
  end: number;
  closedBy: 'count' | 'time' | 'open';
  requests: NormalizedRequest[];
}

/** Requests must already be sorted by (ts, id) — normalizeAll does that.
 *  A window closes when it reaches `windowSize` requests, or when the next request (or `now`)
 *  is ≥ `windowMaxMs` after the window's first request. The last window stays OPEN otherwise. */
export function buildWindows(reqs: NormalizedRequest[], cfg: ProvenanceConfig, now: number): Window[] {
  const groups = new Map<string, NormalizedRequest[]>();
  for (const r of reqs) {
    const key = `${r.aff}|${r.claimed}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }
  const out: Window[] = [];
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key)!;
    const [aff, source] = key.split('|') as [string, Source];
    let cur: NormalizedRequest[] = [];
    let index = 0;
    const close = (closedBy: Window['closedBy']) => {
      out.push({ key, aff, source, index: index++, start: cur[0].ts, end: cur[cur.length - 1].ts, closedBy, requests: cur });
      cur = [];
    };
    for (const r of list) {
      if (cur.length && r.ts - cur[0].ts >= cfg.windowMaxMs) close('time');
      cur.push(r);
      if (cur.length >= cfg.windowSize) close('count');
    }
    if (cur.length) close(now - cur[0].ts >= cfg.windowMaxMs ? 'time' : 'open');
  }
  return out;
}
