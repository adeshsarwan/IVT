import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getNetworkIntel, normalizeIpinfo, observeOnlyNetworkRisk } from "../src/network";
import worker, { classifySource, riskClass, shadowDecision, type Env } from "../src/worker";

type MockFunction<T extends (...args: any[]) => any> = T & { mock: { calls: Array<Parameters<T>> } };

function mock<T extends (...args: any[]) => any>(implementation: T): MockFunction<T> {
  const calls: Array<Parameters<T>> = [];
  const fn = ((...args: Parameters<T>) => {
    calls.push(args);
    return implementation(...args);
  }) as MockFunction<T>;
  fn.mock = { calls };
  return fn;
}

function assertMatch(actual: unknown, expected: unknown): void {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    assert.deepEqual(actual, expected);
    return;
  }
  assert.ok(actual !== null && typeof actual === "object", "expected an object");
  for (const [key, value] of Object.entries(expected)) {
    assertMatch((actual as Record<string, unknown>)[key], value);
  }
}

class MemoryKv {
  readonly values = new Map<string, string>();
  readonly puts: Array<{ key: string; ttl: number }> = [];
  reads = 0;
  failRead = false;
  failWrite = false;

  async get(key: string): Promise<unknown> {
    this.reads++;
    if (this.failRead) throw new Error("cache unavailable");
    const value = this.values.get(key);
    return value === undefined ? null : JSON.parse(value);
  }

  async put(key: string, value: string, options: { expirationTtl: number }): Promise<void> {
    if (this.failWrite) throw new Error("cache unavailable");
    this.values.set(key, value);
    this.puts.push({ key, ttl: options.expirationTtl });
  }
}

function env(kv = new MemoryKv(), overrides: Record<string, string | undefined> = {}) {
  return {
    IVT_CONFIG: kv as unknown as KVNamespace,
    IPINFO_TOKEN: "unit-test-credential",
    IPINFO_MODE: "observe",
    IPINFO_TIMEOUT_MS: "100",
    NETWORK_CACHE_TTL_SECONDS: "86400",
    NETWORK_ERROR_TTL_SECONDS: "600",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const base = {
  ip: "203.0.113.10",
  geo: { country_code: "US" },
  as: { asn: "AS64500", name: "Example ISP", type: "isp" },
  is_anonymous: false,
  is_hosting: false,
  anonymous: {
    is_vpn: false,
    is_proxy: false,
    is_tor: false,
    is_relay: false,
    is_res_proxy: false,
  },
};

describe("IPinfo normalization", () => {
  it("normalizes a normal residential response", () => {
    assertMatch(normalizeIpinfo(base), {
      vpn: false,
      proxy: false,
      tor: false,
      hosting: false,
      relay: false,
      residentialProxy: false,
      privacy: false,
      asn: "AS64500",
      asName: "Example ISP",
      asType: "isp",
      country: "US",
    });
  });

  for (const [label, override, expected] of [
    ["VPN", { is_anonymous: true, anonymous: { ...base.anonymous, is_vpn: true, name: "Example VPN" } }, { vpn: true, privacy: true, service: "Example VPN" }],
    ["proxy", { is_anonymous: true, anonymous: { ...base.anonymous, is_proxy: true } }, { proxy: true, privacy: true }],
    ["Tor", { is_anonymous: true, anonymous: { ...base.anonymous, is_tor: true } }, { tor: true, privacy: true }],
    ["hosting/datacenter", { is_hosting: true }, { hosting: true }],
    ["relay", { is_anonymous: true, anonymous: { ...base.anonymous, is_relay: true } }, { relay: true, privacy: true }],
    ["residential proxy", { is_anonymous: true, anonymous: { ...base.anonymous, is_res_proxy: true, name: "Example Residential" } }, { residentialProxy: true, privacy: true, service: "Example Residential" }],
  ] as const) {
    it(`normalizes ${label} evidence`, () => {
      const response = { ...base, ...override };
      assertMatch(normalizeIpinfo(response), expected);
    });
  }

  it("tolerates missing optional fields and unknown fields", () => {
    assertMatch(
      normalizeIpinfo({ ip: "203.0.113.10", country_code: "CA", future_field: { any: "value" } }),
      { country: "CA", vpn: null, asn: null },
    );
  });

  it("tolerates null fields", () => {
    assertMatch(normalizeIpinfo({
      ip: "203.0.113.10",
      geo: { country_code: null },
      as: { asn: null, name: null, type: null },
      anonymous: { is_vpn: null, is_proxy: null },
      is_hosting: null,
    }), { country: null, asn: null, vpn: null, proxy: null, hosting: null });
  });

  it("supports the maintained legacy privacy response shape", () => {
    assertMatch(normalizeIpinfo({
      ip: "203.0.113.10",
      country: "GB",
      privacy: { vpn: true, proxy: false, tor: false, hosting: false, relay: false, service: "Legacy VPN" },
    }), { vpn: true, proxy: false, country: "GB", service: "Legacy VPN", privacy: true });
  });

  it("rejects malformed and unrecognized payloads", () => {
    assert.equal(normalizeIpinfo(null), null);
    assert.equal(normalizeIpinfo([]), null);
    assert.equal(normalizeIpinfo({ unexpected: true }), null);
  });
});

describe("IPinfo lookup, caching, and failure handling", () => {
  it("uses a cache miss to perform one provider request and caches success for 24 hours", async () => {
    const kv = new MemoryKv();
    const fetchMock = mock(async () => jsonResponse(base));
    const result = await getNetworkIntel(env(kv), "203.0.113.10", "hash", { fetch: fetchMock });

    assertMatch(result, { lookupStatus: "hit", cacheStatus: "miss", asn: "AS64500" });
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.deepEqual(kv.puts, [{ key: "ipinfo:v2:hash", ttl: 86400 }]);
  });

  it("uses an Authorization header and never puts the credential in the URL or result", async () => {
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => jsonResponse(base));
    const result = await getNetworkIntel(env(), "203.0.113.10", "hash", { fetch: fetchMock });
    const [url, init] = fetchMock.mock.calls[0];

    assert.equal(url, "https://api.ipinfo.io/lookup/203.0.113.10");
    assert.ok(!String(url).includes("unit-test-credential"));
    assertMatch((init as RequestInit).headers, { authorization: "Bearer unit-test-credential" });
    assert.ok(!JSON.stringify(result).includes("unit-test-credential"));
  });

  it("uses a successful cache hit without calling the provider", async () => {
    const kv = new MemoryKv();
    const firstFetch = mock(async () => jsonResponse(base));
    await getNetworkIntel(env(kv), "203.0.113.10", "hash", { fetch: firstFetch });
    const secondFetch = mock(async () => jsonResponse({ ...base, is_hosting: true }));
    const result = await getNetworkIntel(env(kv), "203.0.113.10", "hash", { fetch: secondFetch });

    assertMatch(result, { lookupStatus: "hit", cacheStatus: "hit", hosting: false, lookupMs: 0 });
    assert.equal(secondFetch.mock.calls.length, 0);
  });

  it("fails open on malformed JSON and creates only a short negative cache entry", async () => {
    const kv = new MemoryKv();
    const result = await getNetworkIntel(env(kv), "203.0.113.10", "hash", {
      fetch: async () => new Response("{", { status: 200 }),
    });

    assertMatch(result, { lookupStatus: "error", cacheStatus: "miss", vpn: null });
    assert.deepEqual(kv.puts[0], { key: "ipinfo:v2:hash", ttl: 600 });
    assertMatch(JSON.parse(kv.values.get("ipinfo:v2:hash") || "{}"), { kind: "error" });
  });

  it("fails open on provider timeout", async () => {
    const result = await getNetworkIntel(env(), "203.0.113.10", "hash", {
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    });
    assertMatch(result, { lookupStatus: "error", vpn: null, proxy: null });
  });

  for (const status of [429, 500]) {
    it(`fails open on HTTP ${status} and does not read the body`, async () => {
      let bodyRead = false;
      const response = new Response("provider debug details", { status });
      Object.defineProperty(response, "json", { value: async () => { bodyRead = true; return {}; } });
      const result = await getNetworkIntel(env(), "203.0.113.10", "hash", { fetch: async () => response });

      assertMatch(result, { lookupStatus: "error", cacheStatus: "miss" });
      assert.equal(bodyRead, false);
    });
  }

  it("uses a negative cache hit to avoid another provider request", async () => {
    const kv = new MemoryKv();
    await getNetworkIntel(env(kv), "203.0.113.10", "hash", { fetch: async () => jsonResponse({}, 500) });
    const fetchMock = mock(async () => jsonResponse(base));
    const result = await getNetworkIntel(env(kv), "203.0.113.10", "hash", { fetch: fetchMock });

    assertMatch(result, { lookupStatus: "error", cacheStatus: "negative" });
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("fails open when cache read and write fail", async () => {
    const kv = new MemoryKv();
    kv.failRead = true;
    kv.failWrite = true;
    const result = await getNetworkIntel(env(kv), "203.0.113.10", "hash", { fetch: async () => jsonResponse(base) });
    assertMatch(result, { lookupStatus: "hit", cacheStatus: "error", asn: "AS64500" });
  });

  it("defaults safely to off", async () => {
    const fetchMock = mock(async () => jsonResponse(base));
    const result = await getNetworkIntel(env(new MemoryKv(), { IPINFO_MODE: undefined }), "203.0.113.10", "hash", { fetch: fetchMock });
    assertMatch(result, { lookupStatus: "disabled", cacheStatus: "disabled", provider: "none" });
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("IPINFO_MODE=off disables lookup", async () => {
    const fetchMock = mock(async () => jsonResponse(base));
    const result = await getNetworkIntel(env(new MemoryKv(), { IPINFO_MODE: "off" }), "203.0.113.10", "hash", { fetch: fetchMock });
    assert.equal(result.lookupStatus, "disabled");
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("IPINFO_MODE=observe enables lookup", async () => {
    const fetchMock = mock(async () => jsonResponse(base));
    const result = await getNetworkIntel(env(), "203.0.113.10", "hash", { fetch: fetchMock });
    assert.equal(result.lookupStatus, "hit");
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  it("missing token fails open without a provider request", async () => {
    const fetchMock = mock(async () => jsonResponse(base));
    const result = await getNetworkIntel(env(new MemoryKv(), { IPINFO_TOKEN: undefined }), "203.0.113.10", "hash", { fetch: fetchMock });
    assert.equal(result.lookupStatus, "disabled");
    assert.equal(fetchMock.mock.calls.length, 0);
  });
});

describe("mandatory observe-only decision regression", () => {
  it("keeps source_class, risk_score, classification, and final decision identical", async () => {
    const sourceClass = classifySource({
      attribution: { gclid: "example-click", utm_source: "google" },
      page: { referrer: "https://www.google.com/" },
    }).sourceClass;
    const existingComponents = { browser: 45, identity: 0, behavior: 0, source: 0 };
    const beforeScore = existingComponents.browser + existingComponents.identity + existingComponents.behavior + existingComponents.source;
    const before = {
      sourceClass,
      riskScore: beforeScore,
      classification: riskClass(beforeScore),
      decision: shadowDecision(riskClass(beforeScore)),
    };

    const intel = await getNetworkIntel(env(), "203.0.113.10", "hash", {
      fetch: async () => jsonResponse({ ...base, is_hosting: true }),
    });
    const network = observeOnlyNetworkRisk();
    const afterScore = beforeScore + network.score;
    const after = {
      sourceClass,
      riskScore: afterScore,
      classification: riskClass(afterScore),
      decision: shadowDecision(riskClass(afterScore)),
      telemetry: {
        ipinfo_lookup_status: intel.lookupStatus,
        ipinfo_hosting: intel.hosting,
        ipinfo_proxy: intel.proxy,
      },
    };

    assert.deepEqual(before, {
      sourceClass: "GOOGLE_PAID",
      riskScore: 45,
      classification: "SUSPICIOUS",
      decision: "WOULD_CHALLENGE",
    });
    assertMatch(after, before);
    assert.deepEqual(after.telemetry, {
      ipinfo_lookup_status: "hit",
      ipinfo_hosting: true,
      ipinfo_proxy: false,
    });
    assert.deepEqual(network, { score: 0, reasons: [] });
  });

  it("keeps the full Worker admission decision identical and never exposes the token", async () => {
    class Statement {
      bindings: unknown[] = [];
      constructor(readonly db: Database, readonly sql: string) {}
      bind(...values: unknown[]) { this.bindings = values; return this; }
      async first<T>(): Promise<T | null> {
        if (this.sql.startsWith("SELECT id, hostname")) {
          return { id: 1, hostname: "gamewhame.com", enabled: 1, mode: "shadow" } as T;
        }
        if (this.sql.includes("COUNT(")) return { n: 0 } as T;
        return null;
      }
      async run() {
        assert.equal((this.sql.match(/\?/g) || []).length, this.bindings.length, "SQL binding count must match placeholders");
        this.db.executed.push(this);
        return { success: true };
      }
    }
    class Database {
      executed: Statement[] = [];
      prepare(sql: string) { return new Statement(this, sql); }
      trafficInsert() {
        const statement = this.executed.find((entry) => entry.sql.includes("INSERT INTO traffic_sessions"));
        assert.ok(statement);
        return statement.bindings;
      }
      networkInsert() {
        const statement = this.executed.find((entry) => entry.sql.includes("INSERT INTO network_evidence"));
        assert.ok(statement);
        return statement.bindings;
      }
    }

    const admission = () => {
      const request = new Request("https://ivt.thebesads.com/v1/admit", {
        method: "POST",
        headers: {
          origin: "https://gamewhame.com",
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.10",
        },
        body: JSON.stringify({
          siteKey: "gamewhame",
          nonce: "a".repeat(32),
          page: { href: "https://gamewhame.com/play", referrer: "https://www.google.com/" },
          browser: { ua: "Example Browser", webdriver: true, cookieEnabled: true },
          attribution: { gclid: "example-click", utm_source: "google" },
        }),
      });
      Object.defineProperty(request, "cf", {
        value: { country: "US", colo: "IAD", asn: 64501, botManagement: { score: 99, verifiedBot: false } },
      });
      return request;
    };

    const workerEnv = (db: Database, mode: "off" | "observe"): Env => ({
      DB: db as unknown as D1Database,
      IVT_CONFIG: new MemoryKv() as unknown as KVNamespace,
      REPLAY_GUARD: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({ fetch: async () => new Response("ok") }),
      } as unknown as DurableObjectNamespace,
      IVT_MODE: "shadow",
      RUNTIME_TTL_SECONDS: "60",
      TELEMETRY_TTL_SECONDS: "7200",
      ALLOWED_ORIGINS: "https://gamewhame.com",
      IVT_HASH_SECRET: "unit-test-hmac-secret",
      IPINFO_TOKEN: "unit-test-credential",
      IPINFO_MODE: mode,
      IPINFO_TIMEOUT_MS: "100",
      NETWORK_CACHE_TTL_SECONDS: "86400",
      NETWORK_ERROR_TTL_SECONDS: "600",
    });

    const originalFetch = globalThis.fetch;
    try {
      const beforeDb = new Database();
      const beforeResponse = await worker.fetch(admission(), workerEnv(beforeDb, "off"));

      globalThis.fetch = async () => jsonResponse({
        ...base,
        is_anonymous: true,
        is_hosting: true,
        anonymous: { ...base.anonymous, is_vpn: true, name: "Example VPN" },
      });
      const afterDb = new Database();
      const afterResponse = await worker.fetch(admission(), workerEnv(afterDb, "observe"));

      const decisionFields = (bindings: unknown[]) => ({
        sourceClass: bindings[3],
        networkRisk: bindings[23],
        riskScore: bindings[28],
        classification: bindings[29],
        decision: bindings[30],
      });
      assert.deepEqual(decisionFields(beforeDb.trafficInsert()), {
        sourceClass: "GOOGLE_PAID",
        networkRisk: 0,
        riskScore: 45,
        classification: "SUSPICIOUS",
        decision: "WOULD_CHALLENGE",
      });
      assert.deepEqual(decisionFields(afterDb.trafficInsert()), decisionFields(beforeDb.trafficInsert()));
      assertMatch(afterDb.networkInsert(), {
        15: 64501,
        16: "US",
        17: "hit",
        18: "miss",
        19: 1,
        22: 1,
        27: "AS64500",
        29: "isp",
        30: "US",
      });

      const beforePayload = await beforeResponse.text();
      const afterPayload = await afterResponse.text();
      assert.equal(beforeResponse.status, 200);
      assert.equal(afterResponse.status, 200);
      assert.ok(!afterPayload.includes("unit-test-credential"));
      assert.ok(!afterPayload.toLowerCase().includes("ipinfo"));
      assert.deepEqual(
        { ...JSON.parse(afterPayload), telemetryToken: "redacted", runtime: "redacted" },
        { ...JSON.parse(beforePayload), telemetryToken: "redacted", runtime: "redacted" },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
