// Small pure helpers: hashing, Wilson interval, time-zone dates, rate stats.

import type { RateStat } from './types';

/** FNV-1a 32-bit. Not cryptographic: only used to pick a deterministic sample. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** FNV-1a followed by the murmur3 32-bit finalizer, mapped to [0, 1). FNV alone mixes the last
 *  characters poorly, so ids like p001, p002 … would land close together. */
export function hash01(s: string): number {
  let h = fnv1a(s);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

/** Deterministic sampling: the same id + salt is always in or always out. */
export function inSample(id: string, salt: string, rate: number): boolean {
  if (rate >= 1) return true;
  return hash01(`${salt}:${id}`) < rate;
}

/** Wilson score interval for k successes out of n. Returns [lo, hi] in [0, 1]. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function rateStat(k: number, n: number, z = 1.96): RateStat {
  return { k, n, rate: n > 0 ? k / n : null, ci: n > 0 ? wilson(k, n, z) : null };
}

export function toMs(ts: string | number | null | undefined): number | null {
  if (ts === null || ts === undefined || ts === '') return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (/^\d+$/.test(ts)) return Number(ts);
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** YYYY-MM-DD of an instant in an IANA time zone (the ad account's zone). */
export function localDate(ms: number, timeZone: string): string {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtCache.set(timeZone, f);
  }
  return f.format(new Date(ms));
}

/** Hour of day (0–23) of an instant in a time zone. */
export function localHour(ms: number, timeZone: string): number {
  const key = `h:${timeZone}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
    fmtCache.set(key, f);
  }
  return Number(f.format(new Date(ms))) % 24;
}

/** Whole days between two YYYY-MM-DD strings (b − a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Normalized Shannon entropy of a histogram (1 = perfectly flat). */
export function normEntropy(counts: number[]): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0 || counts.length < 2) return null;
  let h = 0;
  for (const c of counts) if (c > 0) { const p = c / total; h -= p * Math.log(p); }
  return Math.min(1, h / Math.log(counts.length));
}

export function inc(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] || 0) + by;
}

export const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
