// Ad Pass: a short-lived, stateless, HMAC-signed ticket that is the ONLY way to obtain the
// ad-unit configuration for a site. See docs/AD_PASS.md for the flow and threat model.
//
// Everything here fails closed: any missing secret, unreadable KV, malformed config, bad token
// or unexpected exception results in "no pass" / HTTP 403 with no body.

const enc = new TextEncoder();

export const GPT_URL = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";
const TOKEN_VERSION = 1;
const TOKEN_KIND = "adpass";
const MAX_TOKEN_LENGTH = 2048;
const CLOCK_SKEW_SECONDS = 5;
const DEFAULT_TTL_SECONDS = 1800;
const MAX_TTL_SECONDS = 3600;
const KID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const BIND_RE = /^[A-Za-z0-9_-]{22}$/;

export type AdPassMode = "off" | "observe" | "enforce";

export interface AdPassEnv {
  IVT_CONFIG: KVNamespace;
  REPLAY_GUARD: DurableObjectNamespace;
  AD_PASS_MODE?: string;
  AD_PASS_SECRET?: string;
  AD_PASS_KID?: string;
  AD_PASS_SECRET_PREVIOUS?: string;
  AD_PASS_PREVIOUS_KID?: string;
  AD_PASS_TTL_SECONDS?: string;
  AD_PASS_SINGLE_USE?: string;
  AD_PASS_POLICY_VERSION?: string;
}

export type AdPassClaims = {
  v: number;      // token format version
  typ: string;    // "adpass" (domain separation from other tokens)
  sid: string;    // IVT session id
  site: number;   // sites.id
  sk: string;     // site key
  o: string;      // exact origin the pass was issued to
  iat: number;    // issued-at, unix seconds
  exp: number;    // expiry, unix seconds
  n: string;      // 128-bit random nonce (single-use key)
  pv: string;     // policy version
  aff: string | null; // affiliate id from ?aff= (validated against the site config); null = house
  e: 0 | 1;       // IVT eligibility at issuance (always 1 in enforce mode)
  ih: string;     // keyed hash of client IP prefix (/24 v4, /64 v6)
  uh: string;     // keyed hash of User-Agent
};

export type AdSlot = { div: string; path: string; sizes: Array<[number, number]> };
export type AdUnitSet = { slots: AdSlot[]; targeting: Record<string, string | string[]> };
export type AdUnitConfig = {
  v: 2;
  networkCode: string;
  affiliates: Record<string, AdUnitSet>; // affiliate id -> that affiliate's own ad units
  house: AdUnitSet | null;               // optional: visits that arrive without ?aff=
};

export const AFFILIATE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_AFFILIATES = 1000;

// ---------- small crypto helpers ----------

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlToText(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
}
async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- configuration ----------

export function adPassMode(env: AdPassEnv): AdPassMode {
  const v = (env.AD_PASS_MODE || "").trim().toLowerCase();
  return v === "observe" || v === "enforce" ? v : "off";
}
export function adPassTtlSeconds(env: AdPassEnv): number {
  const n = Number(env.AD_PASS_TTL_SECONDS || String(DEFAULT_TTL_SECONDS));
  return Number.isFinite(n) ? Math.max(15, Math.min(MAX_TTL_SECONDS, Math.floor(n))) : DEFAULT_TTL_SECONDS;
}
function singleUse(env: AdPassEnv): boolean {
  // Default off: the pass is reusable for its lifetime (same origin + IP prefix + UA) so the
  // loader can fetch config again for placeholders added later (SPA, infinite scroll).
  return (env.AD_PASS_SINGLE_USE || "off").trim().toLowerCase() === "on";
}
function policyVersion(env: AdPassEnv): string {
  return (env.AD_PASS_POLICY_VERSION || "1").trim() || "1";
}
type Key = { kid: string; secret: string };
function currentKey(env: AdPassEnv): Key | null {
  const kid = (env.AD_PASS_KID || "k1").trim();
  const secret = env.AD_PASS_SECRET || "";
  return KID_RE.test(kid) && secret.length >= 32 ? { kid, secret } : null;
}
function keyForKid(env: AdPassEnv, kid: string): Key | null {
  const current = currentKey(env);
  if (current && current.kid === kid) return current;
  const prevKid = (env.AD_PASS_PREVIOUS_KID || "").trim();
  const prev = env.AD_PASS_SECRET_PREVIOUS || "";
  if (prevKid && prevKid === kid && KID_RE.test(prevKid) && prev.length >= 32) return { kid: prevKid, secret: prev };
  return null;
}

// ---------- client binding ----------

// IPv4 -> /24, IPv6 -> /64. Mobile/IPv6 privacy addresses rotate within these prefixes.
export function ipPrefix(raw: string | null): string | null {
  if (!raw) return null;
  let ip = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1];
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null;
    return `${o[0]}.${o[1]}.${o[2]}.0/24`;
  }
  if (!ip.includes(":")) return null;
  ip = ip.split("%")[0];
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const expand = (part: string): string[] | null => {
    if (!part) return [];
    const out: string[] = [];
    for (const g of part.split(":")) {
      if (g.includes(".")) {
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(g);
        if (!m) return null;
        const o = m.slice(1).map(Number);
        if (o.some((x) => x > 255)) return null;
        out.push(((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16));
      } else out.push(g);
    }
    return out;
  };
  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && fill !== 0) || (halves.length === 2 && fill < 1)) return null;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

async function bindHash(secret: string, label: string, value: string): Promise<string> {
  return b64url((await hmac(secret, `adpass.bind.${label}.${value}`)).slice(0, 16));
}
type Binding = { ip: string; ua: string };
function requestBinding(request: Request): Binding | null {
  const ip = ipPrefix(request.headers.get("CF-Connecting-IP"));
  const ua = (request.headers.get("User-Agent") || "").slice(0, 1024);
  return ip && ua ? { ip, ua } : null;
}

// ---------- token ----------

export async function signAdPass(key: Key, claims: AdPassClaims): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const sig = b64url(await hmac(key.secret, `${TOKEN_KIND}.v${TOKEN_VERSION}.${key.kid}.${payload}`));
  return `${key.kid}.${payload}.${sig}`;
}

function validClaims(c: any): c is AdPassClaims {
  return !!c && typeof c === "object" && !Array.isArray(c)
    && c.v === TOKEN_VERSION && c.typ === TOKEN_KIND
    && typeof c.sid === "string" && c.sid.length > 0 && c.sid.length <= 64
    && Number.isInteger(c.site) && typeof c.sk === "string" && c.sk.length > 0 && c.sk.length <= 253
    && typeof c.o === "string" && Number.isInteger(c.iat) && Number.isInteger(c.exp)
    && typeof c.n === "string" && NONCE_RE.test(c.n) && typeof c.pv === "string"
    && (c.aff === null || (typeof c.aff === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(c.aff)))
    && (c.e === 0 || c.e === 1)
    && typeof c.ih === "string" && BIND_RE.test(c.ih) && typeof c.uh === "string" && BIND_RE.test(c.uh);
}

// Verifies everything that can be checked without I/O. Returns claims only if all checks pass.
export async function verifyAdPass(env: AdPassEnv, token: unknown, origin: string, request: Request, nowMs = Date.now()): Promise<AdPassClaims | null> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [kid, payload, supplied] = parts;
  if (!KID_RE.test(kid)) return null;
  const key = keyForKid(env, kid);
  if (!key) return null;
  const expected = b64url(await hmac(key.secret, `${TOKEN_KIND}.v${TOKEN_VERSION}.${kid}.${payload}`));
  if (!constantTimeEqual(expected, supplied)) return null;
  let claims: unknown;
  try { claims = JSON.parse(b64urlToText(payload)); } catch { return null; }
  if (!validClaims(claims)) return null;
  const now = Math.floor(nowMs / 1000);
  if (claims.pv !== policyVersion(env)) return null;
  if (claims.iat > now + CLOCK_SKEW_SECONDS || now >= claims.exp) return null;
  if (claims.exp - claims.iat > MAX_TTL_SECONDS) return null;
  if (claims.o !== origin) return null;
  const binding = requestBinding(request);
  if (!binding) return null;
  const [ih, uh] = await Promise.all([bindHash(key.secret, "ip", binding.ip), bindHash(key.secret, "ua", binding.ua)]);
  if (!constantTimeEqual(ih, claims.ih) || !constantTimeEqual(uh, claims.uh)) return null;
  return claims;
}

// ---------- KV: kill switches and ad-unit config ----------

// A switch key that is absent or "on" allows ads. Any other value disables. Read errors disable.
export async function killSwitchesAllow(kv: KVNamespace, siteKey: string, affiliate: string | null): Promise<boolean> {
  try {
    const keys = ["ads:global", `ads:site:${siteKey}`];
    if (affiliate) keys.push(`ads:aff:${affiliate}`);
    const values = await Promise.all(keys.map((k) => kv.get(k)));
    return values.every((v) => v === null || v.trim().toLowerCase() === "on");
  } catch {
    return false;
  }
}

const TARGETING_KEY_RE = /^[a-z0-9_]{1,20}$/;
const TARGETING_VALUE_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
const RESERVED_TARGETING = new Set(["aff", "ivt_k", "ivt_t", "ivt_e"]);

function parseUnitSet(input: unknown, networkCode: string): AdUnitSet | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const set = input as Record<string, unknown>;
  if (Object.keys(set).some((k) => k !== "slots" && k !== "targeting")) return null;
  if (!Array.isArray(set.slots) || set.slots.length < 1 || set.slots.length > 20) return null;
  const divs = new Set<string>();
  const slots: AdSlot[] = [];
  for (const s of set.slots) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    const slot = s as Record<string, unknown>;
    if (Object.keys(slot).some((k) => !["div", "path", "sizes"].includes(k))) return null;
    if (typeof slot.div !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(slot.div) || divs.has(slot.div)) return null;
    if (typeof slot.path !== "string" || slot.path.length > 256 || !slot.path.startsWith(`/${networkCode}/`)
      || !/^\/\d+(?:,\d+)?(?:\/[A-Za-z0-9._-]+)+$/.test(slot.path)) return null;
    if (!Array.isArray(slot.sizes) || slot.sizes.length < 1 || slot.sizes.length > 10) return null;
    const sizes: Array<[number, number]> = [];
    for (const size of slot.sizes) {
      if (!Array.isArray(size) || size.length !== 2 || !size.every((n) => Number.isInteger(n) && n >= 1 && n <= 2000)) return null;
      sizes.push([size[0], size[1]]);
    }
    divs.add(slot.div);
    slots.push({ div: slot.div, path: slot.path, sizes });
  }
  const targeting: Record<string, string | string[]> = {};
  if (set.targeting !== undefined) {
    if (!set.targeting || typeof set.targeting !== "object" || Array.isArray(set.targeting)) return null;
    const entries = Object.entries(set.targeting as Record<string, unknown>);
    if (entries.length > 20) return null;
    for (const [k, v] of entries) {
      if (!TARGETING_KEY_RE.test(k) || RESERVED_TARGETING.has(k)) return null;
      if (typeof v === "string" && TARGETING_VALUE_RE.test(v)) targeting[k] = v;
      else if (Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every((x) => typeof x === "string" && TARGETING_VALUE_RE.test(x))) targeting[k] = [...v];
      else return null;
    }
  }
  return { slots, targeting };
}

// Strict schema: unknown fields, wrong types or out-of-range values reject the whole config.
export function parseAdUnitConfig(input: unknown): AdUnitConfig | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const c = input as Record<string, unknown>;
  if (Object.keys(c).some((k) => !["v", "networkCode", "affiliates", "house"].includes(k))) return null;
  if (c.v !== 2) return null;
  if (typeof c.networkCode !== "string" || !/^\d{1,20}$/.test(c.networkCode)) return null;
  if (!c.affiliates || typeof c.affiliates !== "object" || Array.isArray(c.affiliates)) return null;
  const entries = Object.entries(c.affiliates as Record<string, unknown>);
  if (entries.length > MAX_AFFILIATES) return null;
  const affiliates: Record<string, AdUnitSet> = Object.create(null);
  for (const [id, raw] of entries) {
    if (!AFFILIATE_RE.test(id)) return null;
    const set = parseUnitSet(raw, c.networkCode);
    if (!set) return null;
    affiliates[id] = set;
  }
  let house: AdUnitSet | null = null;
  if (c.house !== undefined && c.house !== null) {
    house = parseUnitSet(c.house, c.networkCode);
    if (!house) return null;
  }
  if (!entries.length && !house) return null;
  return { v: 2, networkCode: c.networkCode, affiliates, house };
}

export async function loadAdUnitConfig(kv: KVNamespace, siteKey: string): Promise<AdUnitConfig | null> {
  try {
    const raw = await kv.get(`adunits:site:${siteKey}`);
    if (raw === null || raw.length > 524288) return null;
    return parseAdUnitConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Affiliate from the visit: a valid id, null when absent, undefined when malformed.
export function affiliateFromAttribution(attribution: unknown): string | null | undefined {
  if (!attribution || typeof attribution !== "object") return null;
  const raw = (attribution as Record<string, unknown>).aff;
  if (raw === undefined || raw === null || raw === "") return null;
  return typeof raw === "string" && AFFILIATE_RE.test(raw) ? raw : undefined;
}

type Gate = { networkCode: string; units: AdUnitSet };

// Config + kill switches for one site and affiliate. Null means "no ads" for any reason:
// unknown affiliate, no house units for a visit without one, any switch off, any read error.
async function adGate(env: AdPassEnv, siteKey: string, affiliate: string | null): Promise<Gate | null> {
  const [config, allowed] = await Promise.all([
    loadAdUnitConfig(env.IVT_CONFIG, siteKey),
    killSwitchesAllow(env.IVT_CONFIG, siteKey, affiliate),
  ]);
  if (!config || !allowed) return null;
  const units = affiliate === null ? config.house : (Object.hasOwn(config.affiliates, affiliate) ? config.affiliates[affiliate] : null);
  return units ? { networkCode: config.networkCode, units } : null;
}

// ---------- issuance (called from /v1/admit) ----------

export type IssueInput = {
  request: Request;
  sessionId: string;
  siteId: number;
  siteKey: string;
  origin: string;
  eligible: boolean;
  affiliate: string | null | undefined; // from affiliateFromAttribution()
  nowMs?: number;
};

// Returns a pass or null. Never throws.
export async function maybeIssueAdPass(env: AdPassEnv, input: IssueInput): Promise<string | null> {
  try {
    const mode = adPassMode(env);
    if (mode === "off") return null;
    if (mode === "enforce" && !input.eligible) return null;
    const key = currentKey(env);
    const binding = requestBinding(input.request);
    if (!key || !binding || input.affiliate === undefined) return null;
    const gate = await adGate(env, input.siteKey, input.affiliate);
    if (!gate) return null;
    const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const [ih, uh] = await Promise.all([bindHash(key.secret, "ip", binding.ip), bindHash(key.secret, "ua", binding.ua)]);
    return await signAdPass(key, {
      v: TOKEN_VERSION, typ: TOKEN_KIND, sid: input.sessionId, site: input.siteId, sk: input.siteKey,
      o: input.origin, iat: now, exp: now + adPassTtlSeconds(env), n: b64url(nonce), pv: policyVersion(env),
      aff: input.affiliate, e: input.eligible ? 1 : 0, ih, uh,
    });
  } catch {
    return null;
  }
}

// ---------- audit keys ----------

// Stateless daily key: recomputable later from AD_PASS_SECRET for GAM report reconciliation.
export async function dailyAuditKey(secret: string, siteKey: string, nowMs = Date.now()): Promise<string> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return hex((await hmac(secret, `ivt_k.${day}.${siteKey}`)).slice(0, 5));
}
export async function passAuditTag(secret: string, nonce: string): Promise<string> {
  return hex((await hmac(secret, `ivt_t.${nonce}`)).slice(0, 6));
}

// ---------- single use ----------

async function claimNonce(env: AdPassEnv, claims: AdPassClaims): Promise<boolean> {
  try {
    const stub = env.REPLAY_GUARD.get(env.REPLAY_GUARD.idFromName(`adpass:${claims.n}`));
    const res = await stub.fetch("https://replay-guard/claim", {
      method: "POST",
      body: JSON.stringify({ expiresAt: claims.exp * 1000 }),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------- POST /v1/ad-units ----------

function deny(origin: string | null): Response {
  return new Response(null, {
    status: 403,
    headers: { "cache-control": "no-store", ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}) },
  });
}

export async function handleAdUnits(request: Request, env: AdPassEnv, origin: string | null): Promise<Response> {
  if (!origin) return deny(null);
  try {
    if (adPassMode(env) === "off") return deny(origin);
    const length = Number(request.headers.get("content-length") || "0");
    if (length > 4096) return deny(origin);
    let body: unknown;
    try { body = await request.json(); } catch { return deny(origin); }
    const token = body && typeof body === "object" ? (body as Record<string, unknown>).adPass : undefined;
    const claims = await verifyAdPass(env, token, origin, request);
    if (!claims) return deny(origin);

    // Re-check config and kill switches: they may have changed since admission.
    const gate = await adGate(env, claims.sk, claims.aff);
    if (!gate) return deny(origin);

    if (singleUse(env) && !(await claimNonce(env, claims))) return deny(origin);

    const key = currentKey(env);
    if (!key) return deny(origin);
    const [ivtK, ivtT] = await Promise.all([dailyAuditKey(key.secret, claims.sk), passAuditTag(key.secret, claims.n)]);
    const payload = {
      gpt: GPT_URL,
      networkCode: gate.networkCode,
      slots: gate.units.slots,
      targeting: { ...gate.units.targeting, aff: claims.aff ?? "house", ivt_k: ivtK, ivt_t: ivtT, ivt_e: String(claims.e) },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store, private",
        "access-control-allow-origin": origin,
        vary: "Origin",
      },
    });
  } catch {
    return deny(origin);
  }
}
