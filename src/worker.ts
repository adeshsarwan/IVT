import { getNetworkIntel, scoreNetworkRisk } from "./network";
import { evaluateIdentityRisk } from "./identity";

export interface Env {
  DB: D1Database;
  IVT_CONFIG: KVNamespace;
  REPLAY_GUARD: DurableObjectNamespace;
  IVT_MODE: string;
  RUNTIME_TTL_SECONDS: string;
  TELEMETRY_TTL_SECONDS: string;
  ALLOWED_ORIGINS: string;
  IVT_HASH_SECRET: string;
  IPINFO_TOKEN?: string;
  NETWORK_PROVIDER?: string;
  NETWORK_CACHE_TTL_SECONDS?: string;
  NETWORK_ERROR_TTL_SECONDS?: string;
}

type AdmitBody = {
  siteKey?: string;
  nonce?: string;
  page?: { href?: string; referrer?: string };
  browser?: Record<string, unknown>;
  attribution?: Record<string, unknown>;
};

type SiteRow = { id: number; hostname: string; enabled: number; mode: string };
type RiskClass = "CLEAN" | "OBSERVE" | "SUSPICIOUS" | "HIGH_RISK" | "PROBABLE_IVT";
type EdgeEvidence = {
  country: string | null;
  colo: string | null;
  asn: number | null;
  botScore: number | null;
  verifiedBot: number | null;
  ja4: string | null;
};
type SourceResult = {
  sourceClass: string;
  declaredSource: string | null;
  clickIdType: string | null;
  clickId: string | null;
};
type Component = { score: number; reasons: string[] };
type TelemetryBody = {
  token?: string;
  sequence?: number;
  eventType?: "heartbeat" | "final";
  elapsedMs?: number;
  visibleMs?: number;
  focusedMs?: number;
  activeMs?: number;
  maxScrollPct?: number;
  pointerEvents?: number;
  touchEvents?: number;
  keyEvents?: number;
  visibilityChanges?: number;
  focusChanges?: number;
};
type TelemetryClaims = { sid: string; origin: string; exp: number; v: number };

const enc = new TextEncoder();

const json = (body: unknown, status = 200, origin?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    },
  });

function configuredOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = new Set(env.ALLOWED_ORIGINS.split(",").map((v) => v.trim()).filter(Boolean));
  return allowed.has(origin) ? origin : null;
}

function runtimeRequestOrigin(request: Request, env: Env): string | null {
  const allowed = new Set(env.ALLOWED_ORIGINS.split(",").map((v) => v.trim()).filter(Boolean));

  const origin = request.headers.get("Origin");
  if (origin && allowed.has(origin)) return origin;

  const referer = request.headers.get("Referer");
  if (!referer) return null;

  try {
    const parsed = new URL(referer);
    const refererOrigin = parsed.origin;
    return allowed.has(refererOrigin) ? refererOrigin : null;
  } catch {
    return null;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}
function hostnameFromUrl(value?: string): string | null {
  if (!value) return null;
  try { return normalizeHostname(new URL(value).hostname); } catch { return null; }
}
function siteMatchesOrigin(site: SiteRow, origin: string): boolean {
  const originHost = hostnameFromUrl(origin);
  return !!originHost && normalizeHostname(site.hostname) === originHost;
}

function edgeEvidence(request: Request): EdgeEvidence {
  const cf = (request as Request & { cf?: Record<string, any> }).cf || {};
  const bm = cf.botManagement || {};
  return {
    country: typeof cf.country === "string" ? cf.country : null,
    colo: typeof cf.colo === "string" ? cf.colo : null,
    asn: typeof cf.asn === "number" ? cf.asn : null,
    botScore: typeof bm.score === "number" ? bm.score : null,
    verifiedBot: bm.verifiedBot === true ? 1 : bm.verifiedBot === false ? 0 : null,
    ja4: typeof bm.ja4 === "string" ? bm.ja4 : null,
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`).join(",")}}`;
}

async function hmacBytes(secret: string, value: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(value));
}
async function hmacHex(secret: string, value: string): Promise<string> {
  const sig = await hmacBytes(secret, value);
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlText(value: string): string { return b64urlEncode(enc.encode(value)); }
function b64urlDecodeText(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
}
async function issueTelemetryToken(env: Env, sessionId: string, origin: string): Promise<string> {
  const ttl = Math.max(300, Math.min(14400, Number(env.TELEMETRY_TTL_SECONDS || "7200")));
  const payload = b64urlText(JSON.stringify({ sid: sessionId, origin, exp: Date.now() + ttl * 1000, v: 1 } satisfies TelemetryClaims));
  const sig = b64urlEncode(new Uint8Array(await hmacBytes(env.IVT_HASH_SECRET, `telemetry.${payload}`)));
  return `${payload}.${sig}`;
}
async function verifyTelemetryToken(env: Env, token: string, origin: string): Promise<TelemetryClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, supplied] = parts;
  const expected = b64urlEncode(new Uint8Array(await hmacBytes(env.IVT_HASH_SECRET, `telemetry.${payload}`)));
  if (supplied.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const claims = JSON.parse(b64urlDecodeText(payload)) as TelemetryClaims;
    if (!claims.sid || claims.v !== 1 || claims.origin !== origin || Date.now() > claims.exp) return null;
    return claims;
  } catch { return null; }
}

function attrString(attr: Record<string, unknown> | undefined, key: string): string | null {
  const value = attr?.[key];
  return typeof value === "string" && value.length ? value.slice(0, 512) : null;
}
function classifySource(body: AdmitBody): SourceResult {
  const attr = body.attribution;
  const candidates: Array<[string, string]> = [
    ["gclid", "GOOGLE_PAID"], ["gbraid", "GOOGLE_PAID"], ["wbraid", "GOOGLE_PAID"],
    ["fbclid", "META_PAID"], ["ttclid", "TIKTOK_PAID"], ["ScCid", "SNAPCHAT_PAID"],
  ];
  for (const [key, sourceClass] of candidates) {
    const value = attrString(attr, key);
    if (value) return { sourceClass, declaredSource: attrString(attr, "utm_source"), clickIdType: key, clickId: value };
  }
  const refHost = hostnameFromUrl(body.page?.referrer);
  let sourceClass = "DIRECT";
  if (refHost) {
    if (refHost.includes("google.") || refHost.includes("bing.com") || refHost.includes("yahoo.")) sourceClass = "ORGANIC_SEARCH";
    else if (["facebook.com", "instagram.com", "tiktok.com", "snapchat.com"].some((v) => refHost.includes(v))) sourceClass = "ORGANIC_SOCIAL";
    else sourceClass = "REFERRAL";
  }
  return { sourceClass, declaredSource: attrString(attr, "utm_source"), clickIdType: null, clickId: null };
}

function scoreBrowser(body: AdmitBody, edge: EdgeEvidence): Component {
  let score = 0;
  const reasons: string[] = [];
  const browser = body.browser || {};
  const ua = typeof browser.ua === "string" ? browser.ua : "";
  if (browser.webdriver === true) { score += 45; reasons.push("WEBDRIVER_TRUE"); }
  if (!ua) { score += 15; reasons.push("BROWSER_UA_MISSING"); }
  if (browser.cookieEnabled === false) { score += 5; reasons.push("COOKIES_DISABLED"); }
  if (edge.verifiedBot === 1) { score += 60; reasons.push("CF_VERIFIED_BOT"); }
  else if (edge.botScore !== null && edge.botScore <= 10) { score += 45; reasons.push("CF_BOT_SCORE_VERY_LOW"); }
  return { score: Math.min(65, score), reasons };
}
function scoreSource(source: SourceResult): Component {
  const reasons: string[] = [];
  let score = 0;
  const declared = (source.declaredSource || "").toLowerCase();
  if (source.sourceClass === "GOOGLE_PAID" && declared && !declared.includes("google")) { score += 10; reasons.push("SOURCE_DECLARATION_MISMATCH"); }
  if (source.sourceClass === "META_PAID" && declared && !/(facebook|meta|instagram)/.test(declared)) { score += 10; reasons.push("SOURCE_DECLARATION_MISMATCH"); }
  return { score, reasons };
}
function riskClass(score: number): RiskClass {
  return score >= 80 ? "PROBABLE_IVT" : score >= 60 ? "HIGH_RISK" : score >= 40 ? "SUSPICIOUS" : score >= 20 ? "OBSERVE" : "CLEAN";
}
function shadowDecision(c: RiskClass): string {
  if (c === "CLEAN") return "WOULD_PASS";
  if (c === "OBSERVE") return "WOULD_OBSERVE";
  if (c === "SUSPICIOUS") return "WOULD_CHALLENGE";
  return "WOULD_BLOCK";
}
function enforceDecision(c: RiskClass): string {
  if (c === "CLEAN") return "PASS";
  if (c === "OBSERVE") return "OBSERVE";
  if (c === "SUSPICIOUS") return "CHALLENGE";
  return "BLOCK";
}
function validMetric(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}
function scoreBehavior(t: TelemetryBody): Component {
  let score = 0;
  const reasons: string[] = [];
  const elapsed = t.elapsedMs || 0;
  const visible = t.visibleMs || 0;
  const active = t.activeMs || 0;
  const interactions = (t.pointerEvents || 0) + (t.touchEvents || 0) + (t.keyEvents || 0);
  const scroll = t.maxScrollPct || 0;
  if (elapsed >= 60000 && visible >= 30000 && active === 0 && interactions === 0 && scroll === 0) {
    score += 10;
    reasons.push("LONG_VISIBLE_NO_ACTIVITY");
  }
  if (elapsed >= 120000 && visible >= 60000 && interactions === 0 && (t.visibilityChanges || 0) === 0 && (t.focusChanges || 0) === 0) {
    score += 5;
    reasons.push("LONG_STATIC_SESSION");
  }
  return { score, reasons };
}

async function storeComponent(env: Env, sessionId: string, component: string, value: Component) {
  await env.DB.prepare(
    "INSERT INTO risk_components (session_id, component, score, reasons_json, evidence_version) VALUES (?, ?, ?, ?, 'v2')"
  ).bind(sessionId, component, value.score, JSON.stringify(value.reasons)).run();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "thebes-ivt", mode: env.IVT_MODE, evidenceVersion: "v2" });

    if (request.method === "OPTIONS") {
      const origin = configuredOrigin(request, env);
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600", vary: "Origin",
      }});
    }

    if (url.pathname === "/v1/admit" && request.method === "POST") {
      const origin = configuredOrigin(request, env);
      if (!origin) return json({ status: "NO_RUNTIME" }, 403);
      let body: AdmitBody;
      try { body = await request.json<AdmitBody>(); } catch { return json({ status: "NO_RUNTIME" }, 400, origin); }
      if (!body.siteKey || !body.nonce || body.nonce.length < 24 || body.nonce.length > 256) return json({ status: "NO_RUNTIME" }, 400, origin);

      const site = await env.DB.prepare("SELECT id, hostname, enabled, mode FROM sites WHERE site_key = ? LIMIT 1").bind(body.siteKey).first<SiteRow>();
      if (!site || !site.enabled || !siteMatchesOrigin(site, origin)) return json({ status: "NO_RUNTIME" }, 403, origin);
      const pageHost = hostnameFromUrl(body.page?.href);
      if (pageHost && pageHost !== normalizeHostname(site.hostname)) return json({ status: "NO_RUNTIME" }, 403, origin);

      const sessionId = crypto.randomUUID();
      const capability = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const now = Date.now();
      const ttl = Math.max(15, Math.min(300, Number(env.RUNTIME_TTL_SECONDS || "60")));
      const edge = edgeEvidence(request);
      const mode = site.mode || env.IVT_MODE || "shadow";
      const source = classifySource(body);

      const rawIp = request.headers.get("CF-Connecting-IP");
      const ipHash = rawIp ? await hmacHex(env.IVT_HASH_SECRET, rawIp) : null;
      const nonceHash = await hmacHex(env.IVT_HASH_SECRET, body.nonce);
      const clickIdHash = source.clickId ? await hmacHex(env.IVT_HASH_SECRET, source.clickId) : null;
      const ua = typeof body.browser?.ua === "string" ? body.browser.ua.slice(0, 1024) : "";
      const userAgentHash = ua ? await hmacHex(env.IVT_HASH_SECRET, ua) : null;
      const browserEvidenceHash = body.browser ? await hmacHex(env.IVT_HASH_SECRET, canonicalize(body.browser)) : null;

      const networkIntel = await getNetworkIntel(env, rawIp, ipHash);
      const network = scoreNetworkRisk(networkIntel);
      const browser = scoreBrowser(body, edge);
      const sourceRisk = scoreSource(source);
      const identityResult = await evaluateIdentityRisk({
        db: env.DB,
        siteId: site.id,
        clickIdHash,
        ipHash,
        browserEvidenceHash,
      });
      const identity: Component = { score: identityResult.score, reasons: identityResult.reasons };
      const behavior: Component = { score: 0, reasons: [] };
      const total = Math.min(100, network.score + browser.score + sourceRisk.score + identity.score + behavior.score);
      const classification = riskClass(total);
      const decision = mode === "shadow" ? shadowDecision(classification) : enforceDecision(classification);

      await env.DB.prepare(`INSERT INTO traffic_sessions
        (id, site_id, client_nonce_hash, source_class, declared_source, click_id_type, click_id_hash,
         country, colo, asn, cf_bot_score, cf_verified_bot, cf_ja4, user_agent_hash, browser_evidence_hash,
         ip_hash, network_provider, network_service, is_hosting, is_proxy, is_tor, is_relay, is_vpn,
         network_risk, browser_risk, identity_risk, behavior_risk, source_risk,
         risk_score, classification, decision, mode, evidence_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v2')`
      ).bind(
        sessionId, site.id, nonceHash, source.sourceClass, source.declaredSource, source.clickIdType, clickIdHash,
        edge.country, edge.colo, edge.asn, edge.botScore, edge.verifiedBot, edge.ja4, userAgentHash, browserEvidenceHash,
        ipHash, networkIntel.provider, networkIntel.service, boolDb(networkIntel.hosting), boolDb(networkIntel.proxy), boolDb(networkIntel.tor),
        boolDb(networkIntel.relay), boolDb(networkIntel.vpn), network.score, browser.score, identity.score, behavior.score, sourceRisk.score,
        total, classification, decision, mode
      ).run();

      await env.DB.prepare(`INSERT INTO network_evidence
        (session_id, ip_hash, asn, country, provider, provider_version, hosting, proxy, tor, relay, vpn,
         residential_proxy, service, cache_status, lookup_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(sessionId, ipHash || "", edge.asn, edge.country, networkIntel.provider, networkIntel.providerVersion || null,
        boolDb(networkIntel.hosting), boolDb(networkIntel.proxy), boolDb(networkIntel.tor), boolDb(networkIntel.relay), boolDb(networkIntel.vpn),
        boolDb(networkIntel.residentialProxy), networkIntel.service, networkIntel.cacheStatus, networkIntel.lookupMs).run();

      await env.DB.prepare(`INSERT INTO identity_signals
        (session_id, click_reuse_24h, ip_sessions_10m, ip_browser_fanout_24h, browser_sessions_10m, browser_ip_fanout_24h)
        VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        sessionId,
        identityResult.signals.clickReuse24h,
        identityResult.signals.ipSessions10m,
        identityResult.signals.ipBrowserFanout24h,
        identityResult.signals.browserSessions10m,
        identityResult.signals.browserIpFanout24h,
      ).run();

      await Promise.all([
        storeComponent(env, sessionId, "network", network),
        storeComponent(env, sessionId, "browser", browser),
        storeComponent(env, sessionId, "identity", identity),
        storeComponent(env, sessionId, "behavior", behavior),
        storeComponent(env, sessionId, "source", sourceRisk),
      ]);

      const reasons = [...network.reasons, ...browser.reasons, ...identity.reasons, ...sourceRisk.reasons];
      if (reasons.length) await env.DB.prepare("INSERT INTO ivt_events (session_id, event_type, event_data) VALUES (?, 'RISK_REASONS', ?)").bind(sessionId, JSON.stringify(reasons)).run();
      if (source.clickId && source.clickIdType) {
        await env.DB.prepare("INSERT INTO click_reconciliation (session_id, platform, status) VALUES (?, ?, 'CAPTURED')")
          .bind(sessionId, source.sourceClass.replace("_PAID", "")).run();
      }

      if (mode !== "shadow" && decision === "BLOCK") return json({ status: "NO_RUNTIME" }, 200, origin);

      const capabilityHash = await hmacHex(env.IVT_HASH_SECRET, capability);
      await env.DB.prepare("INSERT INTO runtime_capabilities (id, session_id, capability_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), sessionId, capabilityHash, new Date(now).toISOString(), new Date(now + ttl * 1000).toISOString()).run();
      const guard = env.REPLAY_GUARD.get(env.REPLAY_GUARD.idFromName(capability));
      await guard.fetch("https://replay-guard/register", { method: "POST", body: JSON.stringify({ sessionId, origin, expiresAt: now + ttl * 1000 }) });

      const telemetryToken = await issueTelemetryToken(env, sessionId, origin);
      return json({ status: "ADMITTED", runtime: `/v1/runtime/${capability}`, telemetryToken, expiresIn: ttl }, 200, origin);
    }

    if (url.pathname === "/v2/telemetry" && request.method === "POST") {
      const origin = configuredOrigin(request, env);
      if (!origin) return json({ ok: false }, 403);
      let body: TelemetryBody;
      try { body = await request.json<TelemetryBody>(); } catch { return json({ ok: false }, 400, origin); }
      if (!body.token) return json({ ok: false }, 401, origin);
      const claims = await verifyTelemetryToken(env, body.token, origin);
      if (!claims) return json({ ok: false }, 401, origin);

      if (!Number.isInteger(body.sequence) || !validMetric(body.sequence, 0, 10000) || !["heartbeat", "final"].includes(body.eventType || "")) return json({ ok: false }, 400, origin);
      const metrics: Array<[unknown, number]> = [
        [body.elapsedMs, 86400000], [body.visibleMs, 86400000], [body.focusedMs, 86400000], [body.activeMs, 86400000],
        [body.maxScrollPct, 100], [body.pointerEvents, 1000000], [body.touchEvents, 1000000], [body.keyEvents, 1000000],
        [body.visibilityChanges, 100000], [body.focusChanges, 100000],
      ];
      if (metrics.some(([v, max]) => !validMetric(v, 0, max))) return json({ ok: false }, 400, origin);
      if ((body.visibleMs || 0) > (body.elapsedMs || 0) + 1000 || (body.focusedMs || 0) > (body.elapsedMs || 0) + 1000 || (body.activeMs || 0) > (body.elapsedMs || 0) + 1000) return json({ ok: false }, 400, origin);

      const exists = await env.DB.prepare("SELECT id, mode, network_risk, browser_risk, identity_risk, source_risk FROM traffic_sessions WHERE id = ? LIMIT 1")
        .bind(claims.sid).first<{ id:string; mode:string; network_risk:number; browser_risk:number; identity_risk:number; source_risk:number }>();
      if (!exists) return json({ ok: false }, 404, origin);

      try {
        await env.DB.prepare(`INSERT INTO telemetry_summaries
          (session_id, sequence, event_type, elapsed_ms, visible_ms, focused_ms, active_ms, max_scroll_pct,
           pointer_events, touch_events, key_events, visibility_changes, focus_changes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(claims.sid, body.sequence, body.eventType, body.elapsedMs, body.visibleMs, body.focusedMs, body.activeMs,
          body.maxScrollPct, body.pointerEvents, body.touchEvents, body.keyEvents, body.visibilityChanges, body.focusChanges).run();
      } catch {
        return json({ ok: true, duplicate: true }, 200, origin);
      }

      const behavior = scoreBehavior(body);
      const total = Math.min(100, exists.network_risk + exists.browser_risk + exists.identity_risk + exists.source_risk + behavior.score);
      const classification = riskClass(total);
      const decision = exists.mode === "shadow" ? shadowDecision(classification) : enforceDecision(classification);
      await env.DB.prepare("UPDATE traffic_sessions SET behavior_risk = ?, risk_score = ?, classification = ?, decision = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(behavior.score, total, classification, decision, claims.sid).run();
      await storeComponent(env, claims.sid, "behavior_telemetry", behavior);
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname.startsWith("/v1/runtime/") && request.method === "GET") {
      const origin = runtimeRequestOrigin(request, env);
      if (!origin) return new Response("", { status: 403 });
      const capability = url.pathname.slice("/v1/runtime/".length);
      if (!/^[a-f0-9]{64}$/i.test(capability)) return new Response("", { status: 404 });
      const guard = env.REPLAY_GUARD.get(env.REPLAY_GUARD.idFromName(capability));
      const consumed = await guard.fetch("https://replay-guard/consume", { method: "POST", body: JSON.stringify({ origin, now: Date.now() }) });
      if (!consumed.ok) return new Response("", { status: 404 });
      const capabilityHash = await hmacHex(env.IVT_HASH_SECRET, capability);
      await env.DB.prepare("UPDATE runtime_capabilities SET consumed_at = CURRENT_TIMESTAMP WHERE capability_hash = ? AND consumed_at IS NULL").bind(capabilityHash).run();
      const bootstrap = `(()=>{window.dispatchEvent(new CustomEvent("thebes:ivt-admitted",{detail:{v:2}}));})();`;
      return new Response(bootstrap, { headers: {
        "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store, private",
        "x-content-type-options": "nosniff", "access-control-allow-origin": origin, vary: "Origin",
      }});
    }

    return new Response("Not found", { status: 404 });
  },
};

function boolDb(v: boolean | null): number | null { return v === null ? null : v ? 1 : 0; }

export class ReplayGuard {
  constructor(private state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/register" && request.method === "POST") {
      const data = await request.json<{ sessionId:string; origin:string; expiresAt:number }>();
      await this.state.storage.put("capability", { ...data, consumed:false });
      return new Response("ok");
    }
    if (url.pathname === "/consume" && request.method === "POST") {
      const input = await request.json<{ origin:string; now:number }>();
      const cap = await this.state.storage.get<{ origin:string; expiresAt:number; consumed:boolean }>("capability");
      if (!cap || cap.consumed || input.now > cap.expiresAt || input.origin !== cap.origin) return new Response("invalid", { status:404 });
      await this.state.storage.put("capability", { ...cap, consumed:true });
      return new Response("ok");
    }
    return new Response("Not found", { status:404 });
  }
}
