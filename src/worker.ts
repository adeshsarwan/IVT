export interface Env {
  DB: D1Database;
  IVT_CONFIG: KVNamespace;
  REPLAY_GUARD: DurableObjectNamespace;
  IVT_MODE: string;
  RUNTIME_TTL_SECONDS: string;
  ALLOWED_ORIGINS: string;
}

type AdmitBody = {
  siteKey?: string;
  nonce?: string;
  page?: { href?: string; referrer?: string };
  browser?: Record<string, unknown>;
  attribution?: Record<string, unknown>;
};

const json = (body: unknown, status = 200, origin?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    },
  });

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = new Set(env.ALLOWED_ORIGINS.split(",").map((v) => v.trim()).filter(Boolean));
  return allowed.has(origin) ? origin : null;
}

function edgeEvidence(request: Request) {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf || {};
  return {
    country: cf.country || null,
    colo: cf.colo || null,
    asn: cf.asn || null,
    asOrganization: cf.asOrganization || null,
    botManagement: cf.botManagement || null,
    tlsVersion: cf.tlsVersion || null,
    httpProtocol: cf.httpProtocol || null,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "thebes-ivt", mode: env.IVT_MODE });
    }

    if (request.method === "OPTIONS") {
      const origin = allowedOrigin(request, env);
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
      const origin = allowedOrigin(request, env);
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

      const admissionId = crypto.randomUUID();
      const trafficId = crypto.randomUUID();
      const capability = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const now = Date.now();
      const ttl = Math.max(15, Math.min(300, Number(env.RUNTIME_TTL_SECONDS || "60")));
      const edge = edgeEvidence(request);

      // v1 deliberately starts in shadow mode. This is not the production risk model.
      const classification = "UNCLASSIFIED";
      const decision = env.IVT_MODE === "shadow" ? "WOULD_OBSERVE" : "OBSERVE";

      await env.DB.prepare(
        `INSERT INTO traffic_sessions
         (id, traffic_id, site_key, origin, nonce, classification, decision, country, asn, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        admissionId,
        trafficId,
        body.siteKey,
        origin,
        body.nonce,
        classification,
        decision,
        edge.country,
        edge.asn,
        new Date(now).toISOString()
      ).run();

      const guardId = env.REPLAY_GUARD.idFromName(capability);
      const guard = env.REPLAY_GUARD.get(guardId);
      await guard.fetch("https://replay-guard/register", {
        method: "POST",
        body: JSON.stringify({ admissionId, origin, expiresAt: now + ttl * 1000 }),
      });

      return json(
        {
          status: "ADMITTED",
          runtime: `/v1/runtime/${capability}`,
          expiresIn: ttl,
        },
        200,
        origin
      );
    }

    if (url.pathname.startsWith("/v1/runtime/") && request.method === "GET") {
      const origin = allowedOrigin(request, env);
      if (!origin) return new Response("", { status: 403 });
      const capability = url.pathname.slice("/v1/runtime/".length);
      if (!/^[a-f0-9]{64}$/i.test(capability)) return new Response("", { status: 404 });

      const guardId = env.REPLAY_GUARD.idFromName(capability);
      const guard = env.REPLAY_GUARD.get(guardId);
      const consumed = await guard.fetch("https://replay-guard/consume", {
        method: "POST",
        body: JSON.stringify({ origin, now: Date.now() }),
      });
      if (!consumed.ok) return new Response("", { status: 404 });

      // Placeholder bootstrap only. No Price Optimiser/GAM knowledge is present here yet.
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
      const data = await request.json<{ admissionId: string; origin: string; expiresAt: number }>();
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
