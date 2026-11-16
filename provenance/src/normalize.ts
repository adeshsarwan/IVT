// Our side: turn a logged request into a NormalizedRequest.
// Param aliases accept both the short names in our mandated tracking template (doc 03) and
// the raw ValueTrack / Meta names, so either setup works.

import type { ProvenanceConfig } from './config';
import type { NormalizedRequest, RawRequest, Source } from './types';
import { inSample, toMs } from './util';

const GOOGLE_ALIASES = {
  campaignId: ['campaignid', 'cid', 'gcid', 'utm_id'],
  adGroupId: ['adgroupid', 'ag'],
  creative: ['creative', 'cr'],
  keyword: ['keyword', 'kw'],
  placement: ['placement', 'plc'],
  network: ['network', 'net'],
  device: ['device', 'dev'],
  matchType: ['matchtype', 'mt'],
} as const;

const META_ALIASES = {
  campaignId: ['campaign_id', 'fb_cid', 'cid'],
  adsetId: ['adset_id', 'as'],
  adId: ['ad_id', 'ad'],
  siteSource: ['site_source_name', 'ss'],
  placement: ['placement', 'plc'],
} as const;

/** Values Meta/Google would never send; seen when a URL is hand-built or the macro wasn't expanded. */
const MACRO_RE = /\{\{?[^{}]*\}?\}|%7B/i;

const GOOGLE_UTM = new Set(['google', 'adwords', 'googleads', 'google_ads', 'gads']);
const META_UTM = new Set(['facebook', 'fb', 'ig', 'instagram', 'meta', 'messenger', 'an', 'audience_network']);

export function parseParams(raw: RawRequest): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw.url) {
    try {
      const u = new URL(raw.url, 'https://placeholder.invalid');
      u.searchParams.forEach((v, k) => { if (!(k.toLowerCase() in out)) out[k.toLowerCase()] = v; });
    } catch { /* malformed URL: params stay empty */ }
  }
  if (raw.params) for (const [k, v] of Object.entries(raw.params)) out[k.toLowerCase()] = String(v);
  return out;
}

const pick = (p: Record<string, string>, names: readonly string[]): string | null => {
  for (const n of names) { const v = p[n]; if (v !== undefined && v !== '') return v; }
  return null;
};

export function sourceFromUtm(v: string | null): Source | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (GOOGLE_UTM.has(s)) return 'google';
  if (META_UTM.has(s)) return 'meta';
  return null;
}

export function normalizeRequest(raw: RawRequest, cfg: ProvenanceConfig): NormalizedRequest | null {
  const ts = toMs(raw.ts);
  if (!raw || typeof raw.id !== 'string' || raw.id === '' || ts === null) return null;
  const p = parseParams(raw);

  const gclid = p.gclid || null;
  const gbraid = p.gbraid || null;
  const wbraid = p.wbraid || null;
  const fbclid = p.fbclid || null;
  const inferred: Source = gclid || gbraid || wbraid ? 'google' : fbclid ? 'meta' : 'unknown';

  // Platform claim, strongest first. URL-derived claims are attacker-controlled; route is not.
  let claimed: Source = 'unknown';
  let claimSource: NormalizedRequest['claimSource'] = 'none';
  const routeClaim = raw.route ? cfg.routes[raw.route] : undefined;
  const srcClaim = p.src === 'google' || p.src === 'meta' ? (p.src as Source) : null;
  const utmClaim = sourceFromUtm(p.utm_source || null);
  if (routeClaim) { claimed = routeClaim; claimSource = 'route'; }
  else if (srcClaim) { claimed = srcClaim; claimSource = 'src'; }
  else if (utmClaim) { claimed = utmClaim; claimSource = 'utm'; }
  else if (inferred !== 'unknown') { claimed = inferred; claimSource = 'click_id'; }

  const g = Object.fromEntries(Object.entries(GOOGLE_ALIASES).map(([k, names]) => [k, pick(p, names)])) as unknown as NormalizedRequest['g'];
  const m = Object.fromEntries(Object.entries(META_ALIASES).map(([k, names]) => [k, pick(p, names)])) as unknown as NormalizedRequest['m'];

  const checked = ['gclid', 'gbraid', 'wbraid', 'fbclid',
    ...new Set([...Object.values(GOOGLE_ALIASES).flat(), ...Object.values(META_ALIASES).flat()])];
  const unexpandedMacros = checked.filter((k) => p[k] !== undefined && MACRO_RE.test(p[k]));

  return {
    id: raw.id,
    ts,
    site: raw.site,
    aff: raw.aff ? String(raw.aff) : '(none)',
    route: raw.route ?? null,
    claimed,
    claimSource,
    inferred,
    gclid, gbraid, wbraid, fbclid,
    utmSource: p.utm_source || null,
    utmMedium: p.utm_medium || null,
    utmCampaign: p.utm_campaign || null,
    g, m,
    unexpandedMacros,
    ipHash: raw.ipHash ?? null,
    uaHash: raw.uaHash ?? null,
    uaDevice: raw.uaDevice ?? null,
    inSample: inSample(raw.id, cfg.sampleSalt, cfg.sampleRate),
  };
}

/** Plausible-format checks. Real IDs are long base64url-ish strings; the exact grammar is not
 *  documented (verify), so these only reject obvious junk: short, wrong charset, placeholders. */
const CLICK_ID_RE = /^[A-Za-z0-9_\-.~]+$/;
const JUNK = new Set(['test', 'null', 'undefined', 'none', 'nan', '0', '1', 'gclid', 'fbclid', '{gclid}']);

export function isPlausibleClickId(v: string | null, min = 20, max = 512): boolean {
  if (!v) return false;
  if (JUNK.has(v.toLowerCase())) return false;
  if (v.length < min || v.length > max) return false;
  if (MACRO_RE.test(v)) return false;
  return CLICK_ID_RE.test(v);
}

/** Normalize, drop invalid rows, drop exact duplicate request ids (first one wins, by ts then id). */
export function normalizeAll(raws: RawRequest[], cfg: ProvenanceConfig) {
  const parsed: NormalizedRequest[] = [];
  let invalidDropped = 0;
  for (const r of raws) {
    const n = normalizeRequest(r, cfg);
    if (n) parsed.push(n); else invalidDropped++;
  }
  parsed.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set<string>();
  const out: NormalizedRequest[] = [];
  let duplicatesDropped = 0;
  for (const n of parsed) {
    if (seen.has(n.id)) { duplicatesDropped++; continue; }
    seen.add(n.id);
    out.push(n);
  }
  return { requests: out, duplicatesDropped, invalidDropped };
}
