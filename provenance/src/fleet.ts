// Running provenance for 100+ affiliates: connector registry, sync scheduling with backoff and
// per-platform rate limits, ingestion with per-partner isolation, per-affiliate reconciliation jobs,
// a status view, and deterministic spot audits. Still pure: the caller owns clocks, queues and I/O.

import type { ConfigOverrides, ProvenanceConfig } from './config';
import { makeConfig } from './config';
import {
  CONNECTOR_MODE, CONNECTOR_STRENGTH, googleClicksFromCsv, googleDailyFromCsv, googleFromScriptPushes, metaFromApi, metaFromCsv,
  type IngestResult, type ScriptPush, type Strength,
} from './connectors';
import { runProvenance } from './engine';
import {
  type AffiliatePlatformData, type AffiliateResult, type BreakerState, type ConnectorType, type GooglePlatformData,
  type MetaPlatformData, type ProvenanceReport, type RawRequest, type Tier, type WindowResult,
} from './types';
import { fnv1a, round } from './util';

export interface ConnectorConfig {
  id: string;
  aff: string;
  platform: 'google' | 'meta';
  type: ConnectorType;
  /** Accounts this connector actually delivers (customer ids / act_ ids). */
  accountIds: string[];
  /** Accounts the affiliate told us they run but that aren't connected (→ partial access). */
  unconnectedAccountIds?: string[];
  timeZone: string;
  /** Pull interval (pull connectors) or expected delivery interval (push connectors). */
  everyMinutes?: number;
  enabled?: boolean;
}

export interface ConnectorState {
  lastAttemptAt?: number | null;
  lastSuccessAt?: number | null;
  consecutiveFailures: number;
  coveredThrough?: string | null;
  lastError?: string | null;
}

export const DEFAULT_EVERY_MIN: Record<ConnectorType, number> = {
  api_mcc: 360, api_bq_transfer: 1440, api_partner_token: 360, ads_script_push: 1440,
  sheet_export: 1440, email_report: 1440, csv_upload: 1440,
};
const every = (c: ConnectorConfig) => (c.everyMinutes ?? DEFAULT_EVERY_MIN[c.type]) * 60_000;

// ───────────────────────────── Scheduling ─────────────────────────────

export interface SchedulerOpts {
  /** Max jobs handed out per tick across all partners. */
  maxJobs: number;
  /** Concurrent pulls per platform (API rate limits are per app / developer token). */
  perPlatform: { google: number; meta: number };
  /** Spread partners so 100 pulls don't fire at the same minute. */
  jitterMs: number;
  maxBackoffMs: number;
  /** After this many consecutive failures the connector is parked until a human looks. */
  disableAfterFailures: number;
}

export const DEFAULT_SCHEDULER: SchedulerOpts = {
  maxJobs: 50, perPlatform: { google: 10, meta: 5 }, jitterMs: 15 * 60_000, maxBackoffMs: 24 * 3600_000, disableAfterFailures: 6,
};

export interface SyncJob {
  connectorId: string;
  aff: string;
  platform: 'google' | 'meta';
  type: ConnectorType;
  dueAt: number;
  kind: 'first' | 'scheduled' | 'retry';
  /** Idempotency key for the queue: one job per connector per slot. */
  dedupeKey: string;
}

/** Which pull jobs are due now. Push connectors (Ads Script, e-mail, upload) never get jobs; their
 *  lateness shows up in partnerStatus. Deterministic: same registry + state + now → same plan. */
export function planSyncJobs(connectors: ConnectorConfig[], states: Record<string, ConnectorState>, now: number, o: Partial<SchedulerOpts> = {}) {
  const opts = { ...DEFAULT_SCHEDULER, ...o, perPlatform: { ...DEFAULT_SCHEDULER.perPlatform, ...o.perPlatform } };
  const due: SyncJob[] = [];
  const parked: string[] = [];
  for (const c of connectors) {
    if (c.enabled === false || CONNECTOR_MODE[c.type] !== 'pull') continue;
    const st = states[c.id] ?? { consecutiveFailures: 0 };
    if (st.consecutiveFailures >= opts.disableAfterFailures) { parked.push(c.id); continue; }
    const jitter = fnv1a(c.id) % Math.max(1, opts.jitterMs);
    let dueAt: number;
    let kind: SyncJob['kind'];
    if (st.lastAttemptAt == null) { dueAt = now - opts.jitterMs + jitter; kind = 'first'; }
    else if (st.consecutiveFailures > 0) {
      dueAt = st.lastAttemptAt + Math.min(opts.maxBackoffMs, 5 * 60_000 * 2 ** (st.consecutiveFailures - 1)) + jitter % 60_000;
      kind = 'retry';
    } else { dueAt = st.lastAttemptAt + every(c) + jitter; kind = 'scheduled'; }
    if (dueAt <= now) due.push({ connectorId: c.id, aff: c.aff, platform: c.platform, type: c.type, dueAt, kind,
      dedupeKey: `${c.id}@${Math.floor(dueAt / every(c))}` });
  }
  due.sort((a, b) => a.dueAt - b.dueAt || (a.connectorId < b.connectorId ? -1 : 1));
  const jobs: SyncJob[] = [];
  const deferred: string[] = [];
  const used = { google: 0, meta: 0 };
  for (const j of due) {
    if (jobs.length < opts.maxJobs && used[j.platform] < opts.perPlatform[j.platform]) { jobs.push(j); used[j.platform]++; }
    else deferred.push(j.connectorId);
  }
  return { jobs, deferred, parked };
}

/** Update a connector's state after a sync attempt (pure). */
export function recordSync(prev: ConnectorState | undefined, at: number, result: { ok: true; coveredThrough?: string | null } | { ok: false; error: string }): ConnectorState {
  const p = prev ?? { consecutiveFailures: 0 };
  return result.ok
    ? { ...p, lastAttemptAt: at, lastSuccessAt: at, consecutiveFailures: 0, coveredThrough: result.coveredThrough ?? p.coveredThrough ?? null, lastError: null }
    : { ...p, lastAttemptAt: at, consecutiveFailures: p.consecutiveFailures + 1, lastError: result.error };
}

// ───────────────────────────── Ingestion ─────────────────────────────

export type Payload =
  | { connectorId: string; kind: 'google_click_csv' | 'google_daily_csv' | 'meta_csv'; text: string; receivedAt?: number }
  | { connectorId: string; kind: 'google_script_push'; pushes: ScriptPush[] }
  | { connectorId: string; kind: 'google_api'; data: GooglePlatformData }
  | { connectorId: string; kind: 'meta_api'; json: { data?: any[] }; coveredThrough: string | null; receivedAt?: number };

const RANK: Record<Strength, number> = { strong: 3, medium: 2, weak: 1 };

/** Parse every payload, isolating failures: one partner's broken file becomes status 'error' for
 *  that partner only. If an affiliate has several connectors for one platform, the strongest one
 *  with data wins (ties: latest coveredThrough). */
export function ingestFleet(connectors: ConnectorConfig[], payloads: Payload[]) {
  const issues: Record<string, string[]> = {};
  const parsed = new Map<string, { c: ConnectorConfig; r: IngestResult<GooglePlatformData | MetaPlatformData> }>();
  const byId = new Map(connectors.map((c) => [c.id, c]));
  const pushesBy = new Map<string, ScriptPush[]>();
  for (const p of payloads) {
    const c = byId.get(p.connectorId);
    if (!c) { (issues[p.connectorId] ??= []).push('payload for unknown connector ignored'); continue; }
    if (p.kind === 'google_script_push') { (pushesBy.get(c.id) ?? pushesBy.set(c.id, []).get(c.id)!).push(...p.pushes); continue; }
    try {
      parsed.set(c.id, { c, r: parseOne(c, p) });
    } catch (e) {
      parsed.set(c.id, { c, r: { data: errData(c), issues: [`parser crashed: ${(e as Error).message}`], rowsAccepted: 0, rowsRejected: 0 } });
    }
  }
  for (const [id, pushes] of pushesBy) {
    const c = byId.get(id)!;
    try { parsed.set(id, { c, r: googleFromScriptPushes(pushes, { timeZone: c.timeZone, accounts: accountsOf(c), connector: { type: c.type, id } }) }); }
    catch (e) { parsed.set(id, { c, r: { data: errData(c), issues: [`assembly failed: ${(e as Error).message}`], rowsAccepted: 0, rowsRejected: 0 } }); }
  }

  const platform: Record<string, AffiliatePlatformData> = {};
  const chosen: Record<string, string> = {};
  for (const { c, r } of [...parsed.values()].sort((a, b) => (a.c.id < b.c.id ? -1 : 1))) {
    if (r.issues.length) (issues[c.id] ??= []).push(...r.issues);
    const slot = (platform[c.aff] ??= {});
    const cur = slot[c.platform] as GooglePlatformData | MetaPlatformData | undefined;
    const better = !cur || cur.status !== 'ok' && r.data.status === 'ok' ||
      (r.data.status === cur.status && (RANK[CONNECTOR_STRENGTH[c.type]] > RANK[CONNECTOR_STRENGTH[cur.connector!.type]] ||
        (RANK[CONNECTOR_STRENGTH[c.type]] === RANK[CONNECTOR_STRENGTH[cur.connector!.type]] && (r.data.coveredThrough ?? '') > (cur.coveredThrough ?? ''))));
    if (better) { (slot as any)[c.platform] = r.data; chosen[`${c.aff}|${c.platform}`] = c.id; }
  }
  return { platform, issues, chosen };
}

const accountsOf = (c: ConnectorConfig) => [
  ...c.accountIds.map((id) => (c.platform === 'google' ? { customerId: id, linked: true } : { id, linked: true })),
  ...(c.unconnectedAccountIds ?? []).map((id) => (c.platform === 'google' ? { customerId: id, linked: false } : { id, linked: false })),
] as any[];

const errData = (c: ConnectorConfig): any => c.platform === 'google'
  ? { status: 'error', timeZone: c.timeZone, accounts: accountsOf(c), clicks: [], connector: { type: c.type, id: c.id } }
  : { status: 'error', timeZone: c.timeZone, accounts: accountsOf(c), insights: [], connector: { type: c.type, id: c.id } };

function parseOne(c: ConnectorConfig, p: Exclude<Payload, { kind: 'google_script_push' }>): IngestResult<GooglePlatformData | MetaPlatformData> {
  const connector = { type: c.type, id: c.id };
  const base = { timeZone: c.timeZone, accounts: accountsOf(c), connector, importedAt: 'receivedAt' in p ? p.receivedAt ?? null : null };
  switch (p.kind) {
    case 'google_click_csv': return googleClicksFromCsv(p.text, base);
    case 'google_daily_csv': return googleDailyFromCsv(p.text, base);
    case 'meta_csv': return metaFromCsv(p.text, base);
    case 'meta_api': return metaFromApi(p.json, { ...base, coveredThrough: p.coveredThrough });
    case 'google_api': return { data: { ...p.data, connector: p.data.connector ?? connector }, issues: [], rowsAccepted: p.data.clicks.length, rowsRejected: 0 };
  }
}

// ───────────────────────────── Per-affiliate jobs ─────────────────────────────

export interface FleetResult {
  windows: WindowResult[];
  affiliates: AffiliateResult[];
  breakers: Record<string, BreakerState>;
  /** Affiliates whose reconciliation job threw (others are unaffected). */
  failed: Record<string, string>;
  config: ProvenanceConfig;
}

/** One reconciliation job per affiliate (what a queue consumer would run). A throw in one job is
 *  recorded and does not touch the others. `jobFilter` lets the demo/tests inject failures. */
export function runFleet(
  input: { requests: RawRequest[]; platform: Record<string, AffiliatePlatformData>; now: string | number; previous?: Record<string, BreakerState> },
  overrides: ConfigOverrides = {}, jobFilter?: (aff: string) => void,
): FleetResult {
  const cfg = makeConfig(overrides);
  const byAff = new Map<string, RawRequest[]>();
  for (const r of input.requests) { const a = r.aff ? String(r.aff) : '(none)'; (byAff.get(a) ?? byAff.set(a, []).get(a)!).push(r); }
  for (const k of Object.keys(input.previous ?? {})) { const a = k.split('|')[0]; if (!byAff.has(a)) byAff.set(a, []); }
  const out: FleetResult = { windows: [], affiliates: [], breakers: {}, failed: {}, config: cfg };
  for (const aff of [...byAff.keys()].sort()) {
    try {
      jobFilter?.(aff);
      const prev = Object.fromEntries(Object.entries(input.previous ?? {}).filter(([k]) => k.startsWith(`${aff}|`)));
      const rep: ProvenanceReport = runProvenance({ requests: byAff.get(aff)!, platform: { [aff]: input.platform[aff] ?? {} }, now: input.now, previous: prev }, cfg);
      out.windows.push(...rep.windows);
      out.affiliates.push(...rep.affiliates);
      Object.assign(out.breakers, rep.breakers);
    } catch (e) {
      out.failed[aff] = (e as Error).message;
      // Keep the last known breaker states so a failed job never silently resets a BLOCK.
      for (const [k, v] of Object.entries(input.previous ?? {})) if (k.startsWith(`${aff}|`)) out.breakers[k] = v;
    }
  }
  return out;
}

// ───────────────────────────── Status view + spot audits ─────────────────────────────

export interface PartnerStatusRow {
  aff: string;
  platform: 'google' | 'meta';
  connectorId: string;
  type: ConnectorType;
  strength: Strength;
  mode: 'pull' | 'push';
  health: 'healthy' | 'late' | 'failing' | 'parked' | 'never_synced' | 'disabled';
  coveredThrough: string | null;
  lastSuccessAgeHours: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  tier: Tier | null;
  auditRate: number;
}

export function partnerStatus(
  connectors: ConnectorConfig[], states: Record<string, ConnectorState>, affiliates: AffiliateResult[], now: number,
  cfg: ProvenanceConfig = makeConfig(), disableAfterFailures = DEFAULT_SCHEDULER.disableAfterFailures,
): PartnerStatusRow[] {
  const tierOf = new Map(affiliates.map((a) => [a.aff, a.tier]));
  return [...connectors].sort((a, b) => (a.aff + a.platform + a.id < b.aff + b.platform + b.id ? -1 : 1)).map((c) => {
    const st = states[c.id] ?? { consecutiveFailures: 0 };
    const age = st.lastSuccessAt == null ? null : (now - st.lastSuccessAt) / 3600_000;
    const health: PartnerStatusRow['health'] = c.enabled === false ? 'disabled'
      : st.consecutiveFailures >= disableAfterFailures ? 'parked'
      : st.consecutiveFailures > 0 ? 'failing'
      : st.lastSuccessAt == null ? 'never_synced'
      : now - st.lastSuccessAt > 2 * every(c) ? 'late' : 'healthy';
    const strength = CONNECTOR_STRENGTH[c.type];
    return { aff: c.aff, platform: c.platform, connectorId: c.id, type: c.type, strength, mode: CONNECTOR_MODE[c.type], health,
      coveredThrough: st.coveredThrough ?? null, lastSuccessAgeHours: age === null ? null : round(age, 1), consecutiveFailures: st.consecutiveFailures,
      lastError: st.lastError ?? null, tier: tierOf.get(c.aff) ?? null, auditRate: cfg.connectors.auditRates[strength] };
  });
}

/** Deterministic spot-audit selection for a period (e.g. ISO week "2026-W47"). Weak connectors are
 *  audited more often; affiliates with no connector at all are always audited. A spot audit = a
 *  human asks for a live screen-share of the ad account, or a temporary API grant, and compares it
 *  with the data the partner sent. */
export function spotAuditPlan(affs: { aff: string; strength: Strength | 'none' }[], period: string, salt: string, cfg: ProvenanceConfig = makeConfig()) {
  return affs
    .filter(({ aff, strength }) => fnv1a(`${salt}|${period}|${aff}`) / 0x1_0000_0000 < cfg.connectors.auditRates[strength])
    .map((a) => a.aff).sort();
}

/** Strongest connector strength per affiliate (for audits / status), 'none' when nothing is connected. */
export function strengthByAffiliate(connectors: ConnectorConfig[], affs: string[]): { aff: string; strength: Strength | 'none' }[] {
  return affs.map((aff) => {
    const cs = connectors.filter((c) => c.aff === aff && c.enabled !== false);
    if (!cs.length) return { aff, strength: 'none' as const };
    // The weakest platform link decides (an affiliate on Google API + Meta CSV is audited as weak).
    const s = cs.map((c) => CONNECTOR_STRENGTH[c.type]).sort((a, b) => RANK[a] - RANK[b])[0];
    return { aff, strength: s };
  });
}

