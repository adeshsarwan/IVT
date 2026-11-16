// Anti-tamper checks for partner-supplied platform data, plus the connector trust floor.
// Self-reported data (CSV, e-mail, sheet) and partner-run code (Ads Script) can be edited by the
// affiliate. These checks look for the fingerprints of an edited or fabricated report:
//  - it can't contain malformed or duplicate click ids (Google never issues those),
//  - it can't be a mirror of our own landings (real platforms always have clicks that never land),
//  - its per-click details must agree with the ValueTrack values Google wrote into OUR landing URL,
//  - dates can't be in the future, Meta counts must obey link ≤ all clicks, LPV ≤ link clicks.
// A report can prove traffic is bad; it can't fully prove it is good — hence the trust floor and spot audits.

import type { ProvenanceConfig } from './config';
import { CONNECTOR_STRENGTH, strengthOf } from './connectors';
import type { ConnectorInfo, GooglePlatformData, MetaInsightRow, NormalizedRequest, Reason, Severity } from './types';
import { highBad } from './rules';
import { isPlausibleClickId } from './normalize';
import { localDate, rateStat, round, toMs } from './util';

const SEV: Record<string, Severity> = { OK: 0, WATCH: 1, THROTTLE: 2, BLOCK: 3 };

/** ValueTrack {network} → ClickStats AdNetworkType (verify the newer PMax / Demand Gen values). */
export const VT_NETWORK: Record<string, string> = { g: 'SEARCH', s: 'SEARCH_PARTNERS', d: 'CONTENT', ytv: 'YOUTUBE_WATCH', vp: 'YOUTUBE_WATCH' };

export function connectorFloorReason(c: ConnectorInfo | undefined, cfg: ProvenanceConfig, platform: 'Google' | 'Meta'): Reason | null {
  if (!c) return null;
  const sev = SEV[cfg.connectors.floors[c.type]];
  const strength = CONNECTOR_STRENGTH[c.type];
  if (!sev) return null;
  return { code: 'connector_trust_floor', severity: sev, edgeOnly: true,
    message: `${platform} data is ${strength === 'weak' ? 'self-reported' : 'partner-run'} (${c.type}): it can show bad traffic but can't prove good traffic → at least ${cfg.connectors.floors[c.type]}` };
}

/** Report-level checks on a partner-supplied Google click list. Skipped for strong (API) sources. */
export function googleReportChecks(
  data: GooglePlatformData, group: NormalizedRequest[], days: Set<string>, cfg: ProvenanceConfig, now: number, skipped: string[],
): { reasons: Reason[]; stats: { reportInvalid?: number; reportDuplicate?: number; platformOnlyShare?: number | null } } {
  const reasons: Reason[] = [];
  if (strengthOf(data.connector) === 'strong' || !data.clicks.length) return { reasons, stats: {} };
  const t = cfg.connectors;

  const n = data.clicks.length;
  const invalid = data.clicks.filter((c) => !isPlausibleClickId(c.GclId)).length;
  const seen = new Set<string>();
  let dup = 0;
  for (const c of data.clicks) { if (seen.has(c.GclId)) dup++; else seen.add(c.GclId); }
  const push = (r: Reason | null) => { if (r) reasons.push(r); };
  push(highBad('report_invalid_click_ids', 'malformed gclids inside the partner report', rateStat(invalid, n, cfg.z), t.reportInvalid, cfg, skipped));
  push(highBad('report_duplicate_click_ids', 'duplicate gclids inside the partner report', rateStat(dup, n, cfg.z), t.reportDuplicate, cfg, skipped));

  const today = localDate(toMs(data.importedAt ?? null) ?? now, data.timeZone);
  const future = data.clicks.filter((c) => c.Date > today).length;
  if (future > 0) reasons.push({ code: 'report_future_dates', severity: 2, value: future, n,
    message: `${future} report row(s) dated after the report was produced (${today}): edited or fabricated report` });

  // Mirror check: on complete days, how many reported clicks did NOT land with us?
  const ours = new Set(group.map((r) => r.gclid).filter(Boolean) as string[]);
  const onDays = data.clicks.filter((c) => days.has(c.Date));
  const platformOnly = onDays.filter((c) => !ours.has(c.GclId)).length;
  const share = onDays.length ? platformOnly / onDays.length : null;
  if (share !== null && onDays.length >= t.mirrorMinClicks && share < t.mirrorBelow)
    reasons.push({ code: 'report_mirrors_landings', severity: 2, value: round(share), threshold: t.mirrorBelow, n: onDays.length,
      message: `only ${round(share * 100, 2)}% of reported clicks never reached us (real accounts: typically several %): the report looks built from our own landings` });
  return { reasons, stats: { reportInvalid: round(invalid / n), reportDuplicate: round(dup / n), platformOnlyShare: share === null ? null : round(share) } };
}

/** Meta report invariants + mirror check (only for partner-supplied sources). */
export function metaReportChecks(rows: MetaInsightRow[], oursByAdDay: Record<string, number>, connector: ConnectorInfo | undefined, cfg: ProvenanceConfig): Reason[] {
  const reasons: Reason[] = [];
  if (strengthOf(connector) === 'strong' || !rows.length) return reasons;
  const bad = rows.filter((r) => r.inline_link_clicks < 0 || r.clicks < r.inline_link_clicks ||
    (r.landing_page_views !== undefined && r.landing_page_views > r.inline_link_clicks * 1.05 + 2)).length;
  const keys = new Set<string>();
  let dup = 0;
  for (const r of rows) { const k = `${r.ad_id}|${r.date_start}|${r.publisher_platform ?? ''}|${r.platform_position ?? ''}`; if (keys.has(k)) dup++; else keys.add(k); }
  if (bad + dup > 0) reasons.push({ code: 'report_inconsistent', severity: (bad + dup) / rows.length > 0.05 ? 2 : 1, value: bad + dup, n: rows.length,
    message: `${bad} row(s) break Meta's invariants (link clicks ≤ all clicks, LPV ≤ link clicks) and ${dup} duplicate row(s): edited report` });

  // Mirror: link clicks per ad-day exactly equal to our landing count on most busy ad-days.
  const linkByAdDay: Record<string, number> = {};
  for (const r of rows) linkByAdDay[`${r.ad_id}|${r.date_start}`] = (linkByAdDay[`${r.ad_id}|${r.date_start}`] || 0) + r.inline_link_clicks;
  const busy = Object.entries(oursByAdDay).filter(([, c]) => c >= 20);
  const exact = busy.filter(([k, c]) => linkByAdDay[k] === c).length;
  if (busy.length >= 5 && exact / busy.length > 0.8)
    reasons.push({ code: 'report_mirrors_landings', severity: 2, value: round(exact / busy.length), n: busy.length,
      message: `link clicks equal our landing counts exactly on ${exact}/${busy.length} ad-days: real Meta clicks always exceed landings` });
  return reasons;
}

export { SEV as SEVERITY_OF };
