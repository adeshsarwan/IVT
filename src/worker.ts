export interface Env {
  DB: D1Database;
  IVT_CONFIG: KVNamespace;
  REPLAY_GUARD: DurableObjectNamespace;
  IVT_MODE: string;
  RUNTIME_TTL_SECONDS: string;
  ALLOWED_ORIGINS: string;
  IVT_HASH_SECRET: string;
}

type AdmitBody = {
  siteKey?: string;
  nonce?: string;
  page?: { href?: string; referrer?: string };
  browser?: Record<string, unknown>;
  attribution?: Record<string, unknown>;
};

type SiteRow = {
  id: number;
  hostname: string;
  enabled: number;
  mode: string;
};

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

type RiskResult = {
  score: number;
  classification: "CLEAN" | "OBSERVE" | "SUSPICIOUS" | "HIGH_RISK" | "PROBABLE_IVT";
  reasons: string[];
};

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

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function hostnameFromUrl(value?: string): string | null {
  if (!value) return null;
  try {
    return normalizeHostname(new URL(value).hostname);
  } catch {
    return null;
  }
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
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`)
    .join(",")}}`;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function attrString(attr: Record<string, unknown> | undefined, key: string): string | null {
  const value = attr?.[key];
  return typeof value === "string" && value.length ? value.slice(0, 512) : null;
}

function classifySource(body: AdmitBody): SourceResult {
  const attr = body.attribution;
  const candidates: Array<[string, string]> = [
    ["gclid", "GOOGLE_PAID"],
    ["gbraid", "GOOGLE_PAID"],
    ["wbraid", "GOOGLE_PAID"],
    ["fbclid", "META_PAID"],
    ["ttclid", "TIKTOK_PAID"],
    ["ScCid", "SNAPCHAT_PAID"],
  ];

  for (const [key, sourceClass] of candidates) {
    const value = attrString(attr, key);
    if (value) {
      return {
        sourceClass,
        declaredSource: attrString(attr, "utm_source"),
        clickIdType: key,
        clickId: value,
      };
    }
  }

  const refHost = hostnameFromUrl(body.page?.referrer);
  let sourceClass = "DIRECT";
  if (refHost) {
    if (/^(google\.|www\.google\.)/.test(refHost) || refHost.includes("bing.com") || refHost.includes("yahoo.")) {
      sourceClass = "ORGANIC_SEARCH";
    } else if (
      refHost.includes("facebook.com") ||
      refHost.includes("instagram.com") ||
      refHost.includes("tiktok.com") ||
      refHost.includes("snapchat.com")
    ) {
      sourceClass = "ORGANIC_SOCIAL";
    } else {
      sourceClass = "REFERRAL";
    }
  }

  return {
    sourceClass,
    declaredSource: attrString(attr, "utm_source"),
    clickIdType: null,
    clickId: null,
  };
}

function scoreRisk(body: AdmitBody, edge: EdgeEvidence): RiskResult {
  let score = 0;
  const reasons: string[] = [];
  const browser = body.browser || {};
  const webdriver = browser.webdriver === true;
  const ua = typeof browser.ua === "string" ? browser.ua : "";

  if (webdriver) {
    score += 45;
    reasons.push("WEBDRIVER_TRUE");
  }

  if (!ua) {
    score += 15;
    reasons.push("BROWSER_UA_MISSING");
  }

  if (edge.verifiedBot === 1) {
    score += 80;
    reasons.push("CF_VERIFIED_BOT");
  } else if (edge.botScore !== null) {
    if (edge.botScore <= 10) {
      score += 70;
      reasons.push("CF_BOT_SCORE_VERY_LOW");
    } else if (edge.botScore <= 29) {
      score += 45;
      reasons.push("CF_BOT_SCORE_LOW");
    } else if (edge.botScore <= 49) {
      score += 20;
      reasons.push("CF_BOT_SCORE_MID");
    }
  }

  if (typeof browser.cookieEnabled === "boolean" && browser.cookieEnabled === false) {
    score += 5;
    reasons.push("COOKIES_DISABLED");
  }

  score = Math.min(100, score);
  const classification =
    score >= 80 ? "PROBABLE_IVT" : score >= 60 ? "HIGH_RISK" : score >= 40 ? "SUSPICIOUS" : score >= 20 ? "OBSERVE" : "CLEAN";
  return { score, classification, reasons };
}

function shadowDecision(classification: RiskResult["classification"]): string {
  if (classification === "CLEAN") return "WOULD_PASS";
  if (classification === "OBSERVE") return "WOULD_OBSERVE";
  if (classification === "SUSPICIOUS") return "WOULD_CHALLENGE";
  return "WOULD_BLOCK";
}

function enforceDecision(classification: RiskResult["classification"]): string {
  if (classification === "CLEAN") return "PASS";
  if (classification === "OBSERVE") return "OBSERVE";
  if (classification === "SUSPICIOUS") return "CHALLENGE";
  return "BLOCK";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "thebes-ivt", mode: env.IVT_MODE });
    }

    if (request.method === "OPTIONS") {
      const origin = configuredOrigin(request, env);
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "POST,OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
          vary: "Origin",
        },
      });
    }

    if (url.pathname === "/v1/admit" && request.method === "POST") {
      const origin = configuredOrigin(request, env);
      if (!origin) return json({ status: "NO_RUNTIME" }, 403);

      let body: AdmitBody;
      try {
        body = await request.json<AdmitBody>();
      } catch {
        return json({ status: "NO_RUNTIME" }, 400, origin);
      }

      if (!body.siteKey || !body.nonce || body.nonce.length < 24 || body.nonce.length > 256) {
        return json({ status: "NO_RUNTIME" }, 400, origin);
      }

      const site = await env.DB.prepare(
        "SELECT id, hostname, enabled, mode FROM sites WHERE site_key = ? LIMIT 1"
      ).bind(body.siteKey).first<SiteRow>();

      if (!site || !site.enabled || !siteMatchesOrigin(site, origin)) {
        return json({ status: "NO_RUNTIME" }, 403, origin);
      }

      const pageHost = hostnameFromUrl(body.page?.href);
      if (pageHost && pageHost !== normalizeHostname(site.hostname)) {
        return json({ status: "NO_RUNTIME" }, 403, origin);
      }

      const sessionId = crypto.randomUUID();
      const capability = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const now = Date.now();
      const ttl = Math.max(15, Math.min(300, Number(env.RUNTIME_TTL_SECONDS || "60")));
      const edge = edgeEvidence(request);
      const mode = site.mode || env.IVT_MODE || "shadow";
      const source = classifySource(body);
      const risk = scoreRisk(body, edge);
      const decision = mode === "shadow" ? shadowDecision(risk.classification) : enforceDecision(risk.classification);

      const nonceHash = await hmacHex(env.IVT_HASH_SECRET, body.nonce);
      const clickIdHash = source.clickId ? await hmacHex(env.IVT_HASH_SECRET, source.clickId) : null;
      const ua = typeof body.browser?.ua === "string" ? body.browser.ua.slice(0, 1024) : "";
      const userAgentHash = ua ? await hmacHex(env.IVT_HASH_SECRET, ua) : null;
      const browserEvidenceHash = body.browser ? await hmacHex(env.IVT_HASH_SECRET, canonicalize(body.browser)) : null;

      await env.DB.prepare(
        `INSERT INTO traffic_sessions
         (id, site_id, client_nonce_hash, source_class, declared_source, click_id_type, click_id_hash,
          country, colo, asn, cf_bot_score, cf_verified_bot, cf_ja4, user_agent_hash,
          browser_evidence_hash, risk_score, classification, decision, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        sessionId,
        site.id,
        nonceHash,
        source.sourceClass,
        source.declaredSource,
        source.clickIdType,
        clickIdHash,
        edge.country,
        edge.colo,
        edge.asn,
        edge.botScore,
        edge.verifiedBot,
        edge.ja4,
        userAgentHash,
        browserEvidenceHash,
        risk.score,
        risk.classification,
        decision,
        mode
      ).run();

      if (risk.reasons.length) {
        await env.DB.prepare(
          "INSERT INTO ivt_events (session_id, event_type, event_data) VALUES (?, 'RISK_REASONS', ?)"
        ).bind(sessionId, JSON.stringify(risk.reasons)).run();
      }

      if (source.clickId && source.clickIdType) {
        const platform = source.sourceClass.replace("_PAID", "");
        await env.DB.prepare(
          "INSERT INTO click_reconciliation (session_id, platform, status) VALUES (?, ?, 'CAPTURED')"
        ).bind(sessionId, platform).run();
      }

      // Shadow mode deliberately continues issuing runtime capabilities even for traffic
      // that the current model WOULD_BLOCK, so we can measure false positives safely.
      if (mode !== "shadow" && decision === "BLOCK") {
        return json({ status: "NO_RUNTIME" }, 200, origin);
      }

      const capabilityHash = await hmacHex(env.IVT_HASH_SECRET, capability);
      await env.DB.prepare(
        "INSERT INTO runtime_capabilities (id, session_id, capability_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        sessionId,
        capabilityHash,
        new Date(now).toISOString(),
        new Date(now + ttl * 1000).toISOString()
      ).run();

      const guard = env.REPLAY_GUARD.get(env.REPLAY_GUARD.idFromName(capability));
      await guard.fetch("https://replay-guard/register", {
        method: "POST",
        body: JSON.stringify({ sessionId, origin, expiresAt: now + ttl * 1000 }),
      });

      return json({ status: "ADMITTED", runtime: `/v1/runtime/${capability}`, expiresIn: ttl }, 200, origin);
    }

    if (url.pathname.startsWith("/v1/runtime/") && request.method === "GET") {
      const origin = configuredOrigin(request, env);
      if (!origin) return new Response("", { status: 403 });
      const capability = url.pathname.slice("/v1/runtime/".length);
      if (!/^[a-f0-9]{64}$/i.test(capability)) return new Response("", { status: 404 });

      const guard = env.REPLAY_GUARD.get(env.REPLAY_GUARD.idFromName(capability));
      const consumed = await guard.fetch("https://replay-guard/consume", {
        method: "POST",
        body: JSON.stringify({ origin, now: Date.now() }),
      });
      if (!consumed.ok) return new Response("", { status: 404 });

      const capabilityHash = await hmacHex(env.IVT_HASH_SECRET, capability);
      await env.DB.prepare(
        "UPDATE runtime_capabilities SET consumed_at = CURRENT_TIMESTAMP WHERE capability_hash = ? AND consumed_at IS NULL"
      ).bind(capabilityHash).run();

      // Placeholder admission bootstrap only. No Price Optimiser/GAM knowledge lives in ivt.js.
      const bootstrap = `(()=>{window.dispatchEvent(new CustomEvent("thebes:ivt-admitted",{detail:{v:1}}));})();`;
      return new Response(bootstrap, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store, private",
          "x-content-type-options": "nosniff",
          "access-control-allow-origin": origin,
          vary: "Origin",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

export class ReplayGuard {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      const data = await request.json<{ sessionId: string; origin: string; expiresAt: number }>();
      await this.state.storage.put("capability", { ...data, consumed: false });
      return new Response("ok");
    }

    if (url.pathname === "/consume" && request.method === "POST") {
      const input = await request.json<{ origin: string; now: number }>();
      const cap = await this.state.storage.get<{ origin: string; expiresAt: number; consumed: boolean }>("capability");
      if (!cap || cap.consumed || input.now > cap.expiresAt || input.origin !== cap.origin) {
        return new Response("invalid", { status: 404 });
      }
      await this.state.storage.put("capability", { ...cap, consumed: true });
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  }
}
