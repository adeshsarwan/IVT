export type LookupStatus = "hit" | "miss" | "error" | "disabled";
export type CacheStatus = "hit" | "miss" | "negative" | "disabled" | "error";

export type NetworkIntel = {
  lookupStatus: LookupStatus;
  cacheStatus: CacheStatus;
  provider: "ipinfo" | "none";
  providerVersion: string | null;
  vpn: boolean | null;
  proxy: boolean | null;
  tor: boolean | null;
  hosting: boolean | null;
  relay: boolean | null;
  residentialProxy: boolean | null;
  privacy: boolean | null;
  service: string | null;
  asn: string | null;
  asName: string | null;
  asType: string | null;
  country: string | null;
  lookupMs: number | null;
};

export type NetworkEnv = {
  IVT_CONFIG: KVNamespace;
  IPINFO_TOKEN?: string;
  IPINFO_MODE?: string;
  IPINFO_TIMEOUT_MS?: string;
  NETWORK_CACHE_TTL_SECONDS?: string;
  NETWORK_ERROR_TTL_SECONDS?: string;
};

type NormalizedIntel = Omit<NetworkIntel, "lookupStatus" | "cacheStatus" | "lookupMs">;
type SuccessCacheRecord = { version: 2; kind: "success"; intel: NormalizedIntel; cachedAt: number };
type ErrorCacheRecord = { version: 2; kind: "error"; cachedAt: number };
type CacheRecord = SuccessCacheRecord | ErrorCacheRecord;

type NetworkDependencies = {
  fetch?: typeof fetch;
  now?: () => number;
};

const IPINFO_ENDPOINT = "https://api.ipinfo.io/lookup/";
const PROVIDER_VERSION = "lookup-v2";

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringOrNull(value: unknown, maxLength = 128): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    const normalized = boolOrNull(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function firstString(maxLength: number, ...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = stringOrNull(value, maxLength);
    if (normalized !== null) return normalized;
  }
  return null;
}

function inferredPrivacy(explicit: unknown, signals: Array<boolean | null>): boolean | null {
  const normalized = boolOrNull(explicit);
  if (normalized !== null) return normalized;
  if (signals.some((value) => value === true)) return true;
  return signals.every((value) => value === false) ? false : null;
}

function recognizedIpinfoShape(
  root: Record<string, unknown>,
  anonymous: Record<string, unknown> | null,
  privacy: Record<string, unknown> | null,
  as: Record<string, unknown> | null,
  geo: Record<string, unknown> | null,
): boolean {
  const rootFields = ["ip", "country", "country_code", "asn", "as_name", "as_type", "is_hosting", "is_anonymous", "service"];
  const anonymousFields = ["is_vpn", "is_proxy", "is_tor", "is_relay", "is_res_proxy", "name"];
  const privacyFields = ["vpn", "proxy", "tor", "hosting", "relay", "residential_proxy", "residentialProxy", "service"];
  return rootFields.some((key) => hasOwn(root, key))
    || anonymousFields.some((key) => !!anonymous && hasOwn(anonymous, key))
    || privacyFields.some((key) => !!privacy && hasOwn(privacy, key))
    || ["asn", "name", "type"].some((key) => !!as && hasOwn(as, key))
    || ["country_code", "country"].some((key) => !!geo && hasOwn(geo, key));
}

/**
 * Accepts both IPinfo's current /lookup schema and the maintained legacy privacy
 * schema. Unknown fields are ignored; a response with no recognized IPinfo fields
 * is rejected so malformed provider data is never cached as valid evidence.
 */
export function normalizeIpinfo(data: unknown): NormalizedIntel | null {
  const root = recordOrNull(data);
  if (!root) return null;

  const anonymous = recordOrNull(root.anonymous);
  const privacy = recordOrNull(root.privacy);
  const as = recordOrNull(root.as);
  const geo = recordOrNull(root.geo);
  if (!recognizedIpinfoShape(root, anonymous, privacy, as, geo)) return null;

  const vpn = firstBoolean(anonymous?.is_vpn, privacy?.vpn);
  const proxy = firstBoolean(anonymous?.is_proxy, privacy?.proxy);
  const tor = firstBoolean(anonymous?.is_tor, privacy?.tor);
  const hosting = firstBoolean(root.is_hosting, privacy?.hosting);
  const relay = firstBoolean(anonymous?.is_relay, privacy?.relay);
  const residentialProxy = firstBoolean(
    anonymous?.is_res_proxy,
    privacy?.residential_proxy,
    privacy?.residentialProxy,
  );

  return {
    provider: "ipinfo",
    providerVersion: PROVIDER_VERSION,
    vpn,
    proxy,
    tor,
    hosting,
    relay,
    residentialProxy,
    privacy: inferredPrivacy(root.is_anonymous, [vpn, proxy, tor, relay, residentialProxy]),
    service: firstString(128, anonymous?.name, privacy?.service, root.service),
    asn: firstString(32, as?.asn, root.asn),
    asName: firstString(256, as?.name, root.as_name),
    asType: firstString(64, as?.type, root.as_type),
    country: firstString(64, geo?.country_code, root.country_code, root.country, geo?.country),
  };
}

function emptyIntel(
  lookupStatus: LookupStatus,
  cacheStatus: CacheStatus,
  provider: "ipinfo" | "none",
  lookupMs: number | null,
): NetworkIntel {
  return {
    lookupStatus,
    cacheStatus,
    provider,
    providerVersion: provider === "ipinfo" ? PROVIDER_VERSION : null,
    vpn: null,
    proxy: null,
    tor: null,
    hosting: null,
    relay: null,
    residentialProxy: null,
    privacy: null,
    service: null,
    asn: null,
    asName: null,
    asType: null,
    country: null,
    lookupMs,
  };
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function validCachedIntel(value: unknown): NormalizedIntel | null {
  const root = recordOrNull(value);
  if (!root || root.provider !== "ipinfo" || root.providerVersion !== PROVIDER_VERSION) return null;
  const fields = ["vpn", "proxy", "tor", "hosting", "relay", "residentialProxy", "privacy"] as const;
  if (fields.some((field) => root[field] !== null && typeof root[field] !== "boolean")) return null;
  const strings = ["service", "asn", "asName", "asType", "country"] as const;
  if (strings.some((field) => root[field] !== null && typeof root[field] !== "string")) return null;
  return root as NormalizedIntel;
}

function parseCacheRecord(value: unknown): CacheRecord | null {
  const root = recordOrNull(value);
  if (!root || root.version !== 2 || typeof root.cachedAt !== "number") return null;
  if (root.kind === "error") return root as ErrorCacheRecord;
  if (root.kind !== "success") return null;
  const intel = validCachedIntel(root.intel);
  return intel ? { version: 2, kind: "success", intel, cachedAt: root.cachedAt } : null;
}

async function safeCacheRead(env: NetworkEnv, key: string): Promise<{ record: CacheRecord | null; failed: boolean }> {
  try {
    const value = await env.IVT_CONFIG.get(key, "json");
    return { record: parseCacheRecord(value), failed: false };
  } catch {
    return { record: null, failed: true };
  }
}

async function safeCacheWrite(
  env: NetworkEnv,
  key: string,
  record: CacheRecord,
  expirationTtl: number,
): Promise<boolean> {
  try {
    await env.IVT_CONFIG.put(key, JSON.stringify(record), { expirationTtl });
    return true;
  } catch {
    return false;
  }
}

function providerResult(
  status: "error" | "miss",
  cacheStatus: CacheStatus,
  started: number,
  now: () => number,
): NetworkIntel {
  return emptyIntel(status, cacheStatus, "ipinfo", Math.max(0, now() - started));
}

export async function getNetworkIntel(
  env: NetworkEnv,
  ip: string | null,
  ipHash: string | null,
  dependencies: NetworkDependencies = {},
): Promise<NetworkIntel> {
  const mode = (env.IPINFO_MODE || "off").trim().toLowerCase();
  if (mode !== "observe" || !ip || !ipHash || !env.IPINFO_TOKEN) {
    return emptyIntel("disabled", "disabled", "none", null);
  }

  const now = dependencies.now || Date.now;
  const fetchImpl = dependencies.fetch || fetch;
  const cacheKey = `ipinfo:v2:${ipHash}`;
  const cache = await safeCacheRead(env, cacheKey);
  if (cache.record?.kind === "success") {
    return { ...cache.record.intel, lookupStatus: "hit", cacheStatus: "hit", lookupMs: 0 };
  }
  if (cache.record?.kind === "error") {
    return emptyIntel("error", "negative", "ipinfo", 0);
  }

  const started = now();
  const timeoutMs = boundedNumber(env.IPINFO_TIMEOUT_MS, 1500, 100, 5000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;

  try {
    response = await fetchImpl(`${IPINFO_ENDPOINT}${encodeURIComponent(ip)}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.IPINFO_TOKEN}`,
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    clearTimeout(timeout);
    const errorTtl = boundedNumber(env.NETWORK_ERROR_TTL_SECONDS, 600, 60, 3600);
    const wrote = await safeCacheWrite(env, cacheKey, { version: 2, kind: "error", cachedAt: now() }, errorTtl);
    return providerResult("error", cache.failed || !wrote ? "error" : "miss", started, now);
  }

  if (!response.ok) {
    clearTimeout(timeout);
    const errorTtl = boundedNumber(env.NETWORK_ERROR_TTL_SECONDS, 600, 60, 3600);
    const wrote = await safeCacheWrite(env, cacheKey, { version: 2, kind: "error", cachedAt: now() }, errorTtl);
    const status = response.status === 404 ? "miss" : "error";
    return providerResult(status, cache.failed || !wrote ? "error" : "miss", started, now);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    clearTimeout(timeout);
    const errorTtl = boundedNumber(env.NETWORK_ERROR_TTL_SECONDS, 600, 60, 3600);
    const wrote = await safeCacheWrite(env, cacheKey, { version: 2, kind: "error", cachedAt: now() }, errorTtl);
    return providerResult("error", cache.failed || !wrote ? "error" : "miss", started, now);
  }
  clearTimeout(timeout);

  const intel = normalizeIpinfo(data);
  if (!intel) {
    const errorTtl = boundedNumber(env.NETWORK_ERROR_TTL_SECONDS, 600, 60, 3600);
    const wrote = await safeCacheWrite(env, cacheKey, { version: 2, kind: "error", cachedAt: now() }, errorTtl);
    return providerResult("error", cache.failed || !wrote ? "error" : "miss", started, now);
  }

  const ttl = boundedNumber(env.NETWORK_CACHE_TTL_SECONDS, 86400, 3600, 172800);
  const wrote = await safeCacheWrite(
    env,
    cacheKey,
    { version: 2, kind: "success", intel, cachedAt: now() },
    ttl,
  );
  return {
    ...intel,
    lookupStatus: "hit",
    cacheStatus: cache.failed || !wrote ? "error" : "miss",
    lookupMs: Math.max(0, now() - started),
  };
}

/** IPinfo is telemetry-only in this release and contributes no decision reasons or score. */
export function observeOnlyNetworkRisk(): { score: 0; reasons: [] } {
  return { score: 0, reasons: [] };
}
