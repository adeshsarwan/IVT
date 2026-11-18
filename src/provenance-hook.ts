// Traffic Provenance, Hook A2: hand every admitted landing to the (separate) provenance pipeline.
//
// Off unless PROVENANCE_MODE=on AND a PROVENANCE_Q queue binding exists. Fire-and-forget through
// ctx.waitUntil: it never delays /v1/admit, never changes the admit response, and never throws.
// The consumer is provenance/pipeline/worker.ts (a different Worker), which writes to ClickHouse.
//
// Message shape matches provenance/pipeline/worker.ts `PipelineMsg` ({ type: 'landings', rows }).

export interface ProvenanceEnv {
  /** "on" to send. Anything else (default) = off. */
  PROVENANCE_MODE?: string;
  PROVENANCE_Q?: { send(body: unknown): Promise<void> };
}

export type ProvenanceLanding = {
  id: string;            // admit session id
  ts: number;            // epoch ms (UTC)
  site: string;          // site hostname
  aff: string | null;    // ?aff= (validated); null = house traffic
  route: string | null;  // ?route= if the partner's link carries one
  url: string;           // full landing URL incl. gclid / cid / ag / net / dev / plc
  ipHash?: string;       // HMAC (IVT_HASH_SECRET) — same value IVT already stores
  uaHash?: string;
  uaDevice: "mobile" | "desktop" | "tablet" | null;
};

// Google tracking-template values (see docs). Added to the landing URL when the SDK sent them in
// `attribution` but the page URL was cut short (the SDK caps href at 2048 chars).
const URL_KEYS = ["gclid", "gbraid", "wbraid", "cid", "ag", "net", "dev", "plc", "route", "utm_source", "utm_medium", "utm_campaign", "utm_id"];
const ROUTE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function uaDevice(ua: string): ProvenanceLanding["uaDevice"] {
  if (!ua) return null;
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return "mobile";
  return "desktop";
}

export function buildLanding(input: {
  sessionId: string; now: number; siteHost: string; href?: string;
  attribution?: Record<string, unknown>; aff: string | null | undefined;
  ipHash: string | null; uaHash: string | null; ua: string;
}): ProvenanceLanding {
  const attr = input.attribution || {};
  let url: URL;
  try { url = new URL(input.href || `https://${input.siteHost}/`); } catch { url = new URL(`https://${input.siteHost}/`); }
  for (const k of URL_KEYS) {
    const v = attr[k];
    if (typeof v === "string" && v && !url.searchParams.has(k)) url.searchParams.set(k, v.slice(0, 512));
  }
  const route = url.searchParams.get("route");
  return {
    id: input.sessionId,
    ts: input.now,
    site: input.siteHost,
    aff: input.aff ?? null,
    route: route && ROUTE_RE.test(route) ? route : null,
    url: url.toString().slice(0, 4096),
    ...(input.ipHash ? { ipHash: input.ipHash } : {}),
    ...(input.uaHash ? { uaHash: input.uaHash } : {}),
    uaDevice: uaDevice(input.ua),
  };
}

/** Never throws, never awaited by the request path. */
export function sendLanding(env: ProvenanceEnv, ctx: { waitUntil(p: Promise<unknown>): void } | undefined, landing: ProvenanceLanding): boolean {
  if (env.PROVENANCE_MODE !== "on" || !env.PROVENANCE_Q) return false;
  try {
    const p = env.PROVENANCE_Q.send({ type: "landings", rows: [landing] }).catch(() => { /* queue down: drop, IVT unaffected */ });
    if (ctx) ctx.waitUntil(p);
    return true;
  } catch {
    return false;
  }
}
