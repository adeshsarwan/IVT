export type NetworkIntel = {
  provider: string;
  providerVersion?: string | null;
  hosting: boolean | null;
  proxy: boolean | null;
  tor: boolean | null;
  relay: boolean | null;
  vpn: boolean | null;
  residentialProxy: boolean | null;
  service: string | null;
  cacheStatus: "HIT" | "MISS" | "NEGATIVE" | "DISABLED" | "ERROR";
  lookupMs: number | null;
};

export type NetworkEnv = {
  IVT_CONFIG: KVNamespace;
  IPINFO_TOKEN?: string;
  NETWORK_PROVIDER?: string;
  NETWORK_CACHE_TTL_SECONDS?: string;
  NETWORK_ERROR_TTL_SECONDS?: string;
};

type CacheRecord = {
  intel: Omit<NetworkIntel, "cacheStatus" | "lookupMs">;
  cachedAt: number;
};

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function normalizeIpinfo(data: any): Omit<NetworkIntel, "cacheStatus" | "lookupMs"> {
  const privacy = data?.privacy ?? {};
  return {
    provider: "ipinfo",
    providerVersion: "privacy-api-v1",
    hosting: boolOrNull(privacy.hosting),
    proxy: boolOrNull(privacy.proxy),
    tor: boolOrNull(privacy.tor),
    relay: boolOrNull(privacy.relay),
    vpn: boolOrNull(privacy.vpn),
    residentialProxy: boolOrNull(privacy.residential_proxy ?? privacy.residentialProxy),
    service: typeof privacy.service === "string" && privacy.service ? privacy.service.slice(0, 128) : null,
  };
}

function disabled(): NetworkIntel {
  return {
    provider: "none",
    providerVersion: null,
    hosting: null,
    proxy: null,
    tor: null,
    relay: null,
    vpn: null,
    residentialProxy: null,
    service: null,
    cacheStatus: "DISABLED",
    lookupMs: null,
  };
}

export async function getNetworkIntel(
  env: NetworkEnv,
  ip: string | null,
  ipHash: string | null,
): Promise<NetworkIntel> {
  if (!ip || !ipHash) return disabled();

  const provider = (env.NETWORK_PROVIDER || "none").toLowerCase();
  if (provider !== "ipinfo" || !env.IPINFO_TOKEN) return disabled();

  const cacheKey = `net:${ipHash}`;
  const cached = await env.IVT_CONFIG.get(cacheKey, "json") as CacheRecord | null;
  if (cached?.intel) {
    return { ...cached.intel, cacheStatus: "HIT", lookupMs: 0 };
  }

  const started = Date.now();
  try {
    const url = new URL(`https://ipinfo.io/${encodeURIComponent(ip)}/json`);
    url.searchParams.set("token", env.IPINFO_TOKEN);
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    if (!response.ok) {
      const errorTtl = Math.max(300, Math.min(3600, Number(env.NETWORK_ERROR_TTL_SECONDS || "600")));
      await env.IVT_CONFIG.put(`neterr:${ipHash}`, String(response.status), { expirationTtl: errorTtl });
      return { ...disabled(), provider: "ipinfo", cacheStatus: "ERROR", lookupMs: Date.now() - started };
    }

    const data = await response.json<any>();
    const intel = normalizeIpinfo(data);
    const ttl = Math.max(3600, Math.min(172800, Number(env.NETWORK_CACHE_TTL_SECONDS || "86400")));
    await env.IVT_CONFIG.put(cacheKey, JSON.stringify({ intel, cachedAt: Date.now() } satisfies CacheRecord), {
      expirationTtl: ttl,
    });

    return { ...intel, cacheStatus: "MISS", lookupMs: Date.now() - started };
  } catch {
    return { ...disabled(), provider: "ipinfo", cacheStatus: "ERROR", lookupMs: Date.now() - started };
  }
}

export function scoreNetworkRisk(intel: NetworkIntel): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Deliberately conservative: privacy tooling alone is never enough to block a user.
  if (intel.relay) {
    score += 2;
    reasons.push("NETWORK_RELAY");
  }
  if (intel.vpn) {
    score += 8;
    reasons.push("NETWORK_VPN");
  }
  if (intel.hosting) {
    score += 15;
    reasons.push("NETWORK_HOSTING");
  }
  if (intel.proxy) {
    score += 20;
    reasons.push("NETWORK_PROXY");
  }
  if (intel.residentialProxy) {
    score += 25;
    reasons.push("NETWORK_RESIDENTIAL_PROXY");
  }
  if (intel.tor) {
    score += 30;
    reasons.push("NETWORK_TOR");
  }

  return { score: Math.min(40, score), reasons };
}
