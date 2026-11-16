// In-browser Ad Pass demo. Runs the REAL Worker (src/worker.ts) and the REAL browser SDK
// (src/sdk/ivt.ts, src/sdk/ads.ts) in one page. Calls to the Worker are routed in-page to
// worker.fetch() with in-memory KV/D1/Durable Object stand-ins. Google's GPT is stubbed:
// no real ad requests are made. Never deployed; built by `npm run build:demo`.
import worker, { type Env } from "../src/worker";
import { initIVT } from "../src/sdk/ivt";
import { initAds } from "../src/sdk/ads";

const ENDPOINT = "https://ivt.thebesads.com";
const SITE = "gamewhame.com";
const SITE_ORIGIN = "https://gamewhame.com";
const GPT_URL = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";
const VISITOR_IP = "203.0.113.7";

type Scenario = "real" | "bot" | "noivt" | "down" | "stolen" | "otherbrowser" | "tampered" | "expired" | "crosssite";
const SCENARIOS: Record<Scenario, { label: string; what: string }> = {
  real: { label: "Real visitor", what: "A normal browser on gamewhame.com. ivt.js runs, the server approves, ads.js swaps the pass for ad units." },
  bot: { label: "Bot (headless browser)", what: "The browser reports webdriver = true. In enforce mode the server gives no pass, so ads.js has nothing to redeem." },
  noivt: { label: "Partner removed ivt.js", what: "Only ads.js is on the page. It waits for a pass that never comes, then gives up. No ads." },
  down: { label: "IVT server unreachable", what: "Every call to ivt.thebesads.com fails. No pass, no ad units, no ads." },
  stolen: { label: "Pass replayed from another network", what: "A valid pass is sent to /v1/ad-units from IP 198.51.100.23 instead of 203.0.113.x. The IP binding fails." },
  otherbrowser: { label: "Pass replayed from a script", what: "A valid pass is sent with User-Agent python-requests. The browser binding fails." },
  tampered: { label: "Pass edited to never expire", what: "The browser rewrites exp to one year from now and keeps the old signature. The signature check fails." },
  expired: { label: "Pass used after 31 minutes", what: "The ad-units call happens 31 minutes after admission. The 30 minute pass has expired." },
  crosssite: { label: "Pass reused on another site", what: "A pass issued to gamewhame.com is redeemed from jobsqualified.com. The origin binding fails." },
};

const state = {
  scenario: "real" as Scenario,
  mode: "enforce",
  kill: { global: false, site: false, aff: false },
  config: "ok" as "ok" | "missing" | "broken",
};

const adConfig = {
  v: 1,
  networkCode: "1234567",
  affiliate: "42",
  slots: [
    { div: "top", path: "/1234567/aff_42/gamewhame_top", sizes: [[300, 250], [336, 280]] },
    { div: "mid", path: "/1234567/aff_42/gamewhame_mid", sizes: [[300, 250]] },
  ],
  targeting: { aff: "42" },
};

// ---------- in-memory Cloudflare bindings ----------

const sites = [
  { id: 1, site_key: "gamewhame.com", hostname: "gamewhame.com", enabled: 1, mode: "shadow" },
  { id: 2, site_key: "jobsqualified.com", hostname: "jobsqualified.com", enabled: 1, mode: "shadow" },
];
const guards = new Map<string, any>();
const env = {
  IVT_MODE: "shadow",
  RUNTIME_TTL_SECONDS: "60",
  TELEMETRY_TTL_SECONDS: "7200",
  ALLOWED_ORIGINS: "https://gamewhame.com,https://www.gamewhame.com,https://jobsqualified.com,https://www.jobsqualified.com",
  IVT_HASH_SECRET: "demo-ivt-hash-secret",
  AD_PASS_SECRET: "demo-ad-pass-secret-not-for-production-0001",
  AD_PASS_KID: "k1",
  AD_PASS_TTL_SECONDS: "1800",
  AD_PASS_SINGLE_USE: "off",
  AD_PASS_POLICY_VERSION: "1",
  get AD_PASS_MODE() { return state.mode; },
  DB: { prepare(sql: string) { return {
    values: [] as any[],
    bind(...values: any[]) { this.values = values; return this; },
    async first() {
      if (sql.startsWith("SELECT id, hostname")) return sites.find((s) => s.site_key === this.values[0]) || null;
      if (sql.includes("COUNT(")) return { n: 0 };
      return null;
    },
    async run() { return { success: true }; },
  }; } },
  IVT_CONFIG: {
    async get(key: string) {
      if (key === "ads:global") return state.kill.global ? "off" : null;
      if (key === `ads:site:${SITE}`) return state.kill.site ? "off" : null;
      if (key === "ads:aff:42") return state.kill.aff ? "off" : null;
      if (key === `adunits:site:${SITE}`) {
        if (state.config === "missing") return null;
        if (state.config === "broken") return '{"v":1,"networkCode":"1234567","slots":[{"div":"top"';
        return JSON.stringify(adConfig);
      }
      return null;
    },
    async put() {},
  },
  REPLAY_GUARD: {
    idFromName: (name: string) => name,
    get: (name: string) => ({ async fetch(url: string, init: any) {
      const body = JSON.parse(init.body);
      if (url.endsWith("/register")) { guards.set(name, body); return new Response("ok"); }
      if (url.endsWith("/claim")) {
        if (guards.has(name)) return new Response("used", { status: 409 });
        guards.set(name, true); return new Response("ok");
      }
      const stored = guards.get(name);
      if (!stored || stored.origin !== body.origin || body.now > stored.expiresAt) return new Response("", { status: 404 });
      guards.delete(name); return new Response("ok");
    } }),
  },
} as unknown as Env;

// ---------- log ----------

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
let t0 = 0;
type Tone = "pass" | "deny" | "info" | "warn";
function log(actor: string, title: string, tone: Tone, detail?: Array<[string, string]> | string) {
  const li = document.createElement("li");
  li.className = `entry ${tone}`;
  const ms = Math.max(0, Math.round(performance.now() - t0));
  const head = document.createElement("div");
  head.className = "entry-head";
  head.innerHTML = `<span class="t">+${ms} ms</span><span class="actor"></span><span class="title"></span>`;
  (head.querySelector(".actor") as HTMLElement).textContent = actor;
  (head.querySelector(".title") as HTMLElement).textContent = title;
  li.appendChild(head);
  if (detail) {
    if (typeof detail === "string") {
      const pre = document.createElement("pre");
      pre.textContent = detail;
      li.appendChild(pre);
    } else {
      const dl = document.createElement("dl");
      for (const [k, v] of detail) {
        const dt = document.createElement("dt"); dt.textContent = k;
        const dd = document.createElement("dd"); dd.textContent = v;
        dl.append(dt, dd);
      }
      li.appendChild(dl);
    }
  }
  $("#log").appendChild(li);
}

function decodePass(pass: string): Array<[string, string]> {
  try {
    const [kid, payload, sig] = pass.split(".");
    const c = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    const mins = Math.round((c.exp - c.iat) / 60);
    return [
      ["key id", kid],
      ["site / origin", `${c.sk} · ${c.o}`],
      ["valid for", `${mins} min (until ${new Date(c.exp * 1000).toLocaleTimeString()})`],
      ["affiliate", String(c.aff)],
      ["eligible at issue", c.e ? "yes" : "no"],
      ["IP range hash", c.ih],
      ["browser hash", c.uh],
      ["nonce", c.n],
      ["signature", sig.slice(0, 22) + "…"],
    ];
  } catch {
    return [["pass", pass.slice(0, 60) + "…"]];
  }
}

// ---------- route Worker traffic in-page ----------

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(ENDPOINT)) return realFetch(input, init);
  const path = new URL(url).pathname;
  if (path === "/v2/telemetry") return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
  const isAdUnits = path === "/v1/ad-units";
  const actor = isAdUnits ? "ads.js → server" : "ivt.js → server";

  if (state.scenario === "down") {
    log(actor, `POST ${path} · network error`, "deny", "The IVT server could not be reached.");
    throw new TypeError("Failed to fetch");
  }

  let body = typeof init?.body === "string" ? init.body : undefined;
  if (path === "/v1/admit" && body) {
    // The demo itself is hosted elsewhere; report the simulated publisher page instead.
    const parsed = JSON.parse(body);
    parsed.page = { href: `${SITE_ORIGIN}/games/word-sprint`, referrer: "https://www.google.com/" };
    if (state.scenario === "bot") parsed.browser = { ...parsed.browser, webdriver: true };
    body = JSON.stringify(parsed);
  }
  const headers = new Headers({
    "content-type": "application/json",
    Origin: isAdUnits && state.scenario === "crosssite" ? "https://jobsqualified.com" : SITE_ORIGIN,
    "CF-Connecting-IP": isAdUnits && state.scenario === "stolen" ? "198.51.100.23" : VISITOR_IP,
    "User-Agent": isAdUnits && state.scenario === "otherbrowser" ? "python-requests/2.32" : navigator.userAgent,
  });
  const request = new Request(url, { method: init?.method || "GET", body });
  Object.defineProperty(request, "headers", { value: headers });

  const realNow = Date.now;
  if (isAdUnits && state.scenario === "expired") Date.now = () => realNow() + 31 * 60_000;
  let response: Response;
  try { response = await worker.fetch(request, env); } finally { Date.now = realNow; }

  const text = await response.clone().text();
  if (path === "/v1/admit") {
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* empty */ }
    if (data.adPass && state.scenario === "tampered") {
      const [kid, payload, sig] = data.adPass.split(".");
      const c = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      c.exp += 365 * 86400;
      const forged = btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      data.adPass = `${kid}.${forged}.${sig}`;
      response = new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    }
    if (data.adPass) {
      log(actor, `POST /v1/admit · ${response.status} · Ad Pass issued`, "pass", decodePass(data.adPass));
      if (state.scenario === "tampered") log("browser", "Pass edited: expiry pushed one year out, old signature kept", "warn");
    } else {
      const why = state.mode === "off" ? "AD_PASS_MODE is off"
        : data.monetization?.eligible === false && state.mode === "enforce" ? "visit is not eligible"
        : "kill switch on or ad config unusable";
      log(actor, `POST /v1/admit · ${response.status} · no Ad Pass`, "deny", [["status", String(data.status)], ["eligible", String(data.monetization?.eligible)], ["reason (server side only)", why]]);
    }
  } else if (isAdUnits) {
    if (response.ok) {
      const data = JSON.parse(text);
      log(actor, `POST /v1/ad-units · 200 · ad units returned`, "pass", [
        ["network", data.networkCode],
        ["slots", data.slots.map((s: any) => `${s.div} → ${s.path}`).join("\n")],
        ["key-values", Object.entries(data.targeting).map(([k, v]) => `${k}=${v}`).join("  ")],
        ["cache-control", response.headers.get("cache-control") || ""],
      ]);
    } else {
      log(actor, `POST /v1/ad-units · ${response.status} · refused`, "deny", "Empty body by design: the browser learns nothing about why.");
    }
  }
  return response;
};

// ---------- script loads: runtime capability and GPT (stubbed) ----------

const head = document.head as any;
const realAppend = head.appendChild.bind(head);
head.appendChild = (node: any) => {
  if (node instanceof HTMLScriptElement && node.src.startsWith(`${ENDPOINT}/v1/runtime/`)) {
    const request = new Request(node.src);
    Object.defineProperty(request, "headers", { value: new Headers({ Referer: `${SITE_ORIGIN}/` }) });
    void worker.fetch(request, env).then((r) => {
      log("ivt.js → server", `GET /v1/runtime/… · ${r.status}`, r.ok ? "info" : "warn", "Existing one-time runtime capability (unchanged).");
      if (r.ok) node.onload?.(new Event("load")); else node.onerror?.(new Event("error"));
    });
    return node;
  }
  if (node instanceof HTMLScriptElement && node.src === GPT_URL) {
    log("ads.js", "Loads Google Publisher Tag (stubbed in this demo)", "info");
    installFakeGpt();
    node.type = "text/plain"; // inert marker so ads.js sees GPT as already requested
    return realAppend(node);
  }
  return realAppend(node);
};

function installFakeGpt() {
  const w = window as any;
  const g = (w.googletag = w.googletag || { cmd: [] });
  if (g.__demo) return;
  const targeting: Record<string, unknown> = {};
  const slots = new Map<string, { path: string; sizes: number[][] }>();
  Object.assign(g, {
    __demo: true,
    pubads: () => ({ setTargeting: (k: string, v: unknown) => { targeting[k] = v; } }),
    defineSlot: (path: string, sizes: number[][], id: string) => { slots.set(id, { path, sizes }); return { addService() {} }; },
    enableServices() {},
    display: (id: string) => renderAd(id, slots.get(id)!, { ...targeting }),
  });
  const queue: Array<() => void> = Array.isArray(g.cmd) ? g.cmd : [];
  g.cmd = { push: (f: () => void) => { f(); return 0; } };
  queue.forEach((f) => f());
}

function renderAd(id: string, slot: { path: string; sizes: number[][] }, targeting: Record<string, unknown>) {
  const el = document.getElementById(id);
  if (!el) return;
  const [w, h] = slot.sizes[0];
  el.innerHTML = "";
  const ad = document.createElement("div");
  ad.className = "ad";
  ad.style.aspectRatio = `${w} / ${h}`;
  ad.innerHTML = `<span class="ad-tag">Ad · ${w}×${h}</span><code class="ad-path"></code><code class="ad-kv"></code>`;
  (ad.querySelector(".ad-path") as HTMLElement).textContent = slot.path;
  (ad.querySelector(".ad-kv") as HTMLElement).textContent = Object.entries(targeting).map(([k, v]) => `${k}=${v}`).join(" · ");
  el.appendChild(ad);
  el.classList.add("filled");
  log("GPT (stub)", `Ad rendered in “${el.getAttribute("data-ad-slot")}” slot`, "pass");
}

// ---------- page lifecycle ----------

const observers: MutationObserver[] = [];
const RealMO = window.MutationObserver;
(window as any).MutationObserver = class extends RealMO {
  constructor(cb: MutationCallback) { super(cb); observers.push(this); }
};

let stopTelemetry: (() => void) | undefined;
let running = false;
let extraSlots = 0;

function resetPage() {
  observers.splice(0).forEach((o) => o.disconnect());
  stopTelemetry?.();
  stopTelemetry = undefined;
  const w = window as any;
  delete w.__THEBES_IVT_INIT__;
  delete w.__THEBES_ADS_INIT__;
  delete w.googletag;
  document.querySelectorAll(`script[src="${GPT_URL}"]`).forEach((el) => el.remove());
  guards.clear();
  extraSlots = 0;
  $("#log").innerHTML = "";
  for (const el of document.querySelectorAll("#site [data-ad-slot]")) {
    el.removeAttribute("data-ad-filled");
    el.removeAttribute("id");
    el.classList.remove("filled");
    el.innerHTML = "";
  }
  document.querySelectorAll("#site .extra").forEach((el) => el.remove());
  setVerdict("idle", "Not loaded yet", "Choose a visitor and server settings, then load the page.");
}

function setVerdict(kind: "idle" | "busy" | "pass" | "deny", title: string, text: string) {
  const v = $("#verdict");
  v.dataset.kind = kind;
  $("#verdict-title").textContent = title;
  $("#verdict-text").textContent = text;
}

async function loadPage() {
  if (running) return;
  running = true;
  resetPage();
  t0 = performance.now();
  setVerdict("busy", "Loading…", SCENARIOS[state.scenario].what);
  ($("#more") as HTMLButtonElement).disabled = true;
  try {
    if (state.scenario !== "noivt") {
      log("page", "ivt.js starts and collects browser evidence", "info");
      initIVT({ endpoint: ENDPOINT, siteKey: SITE, heartbeatMs: 3_600_000 })
        .then((r) => { stopTelemetry = r.stopTelemetry; })
        .catch(() => log("ivt.js", "Admission failed", "deny"));
    } else {
      log("page", "ivt.js is missing from the page", "warn");
    }
    log("page", "ads.js starts and waits for an Ad Pass", "info");
    const shown = await initAds({ endpoint: ENDPOINT, timeoutMs: 2500 });
    if (shown) {
      const observeOnly = state.mode === "observe" && state.scenario === "bot";
      setVerdict("pass", "Ads shown", observeOnly
        ? "Observe mode: this visit would be blocked, but ads still load, tagged ivt_e=0 so GAM reports can measure it."
        : "The server approved this visit and handed out the ad units.");
      ($("#more") as HTMLButtonElement).disabled = false;
    } else {
      log("ads.js", "Stops. No GPT request is made.", "deny");
      setVerdict("deny", "No ads", SCENARIOS[state.scenario].what);
    }
  } finally {
    running = false;
  }
}

function addSlot() {
  extraSlots++;
  const block = document.createElement("div");
  block.className = "extra";
  block.innerHTML = `<h3>More to play: puzzle pack ${extraSlots + 1}</h3><p>Another article loaded by infinite scroll. It brings its own ad placeholder.</p><div class="slot" data-ad-slot="mid"></div>`;
  $("#feed").appendChild(block);
  log("page", "New placeholder added (infinite scroll). ads.js redeems the same pass again.", "info");
}

// ---------- controls ----------

function renderScenarios() {
  const list = $("#scenarios");
  for (const [key, s] of Object.entries(SCENARIOS) as Array<[Scenario, { label: string; what: string }]>) {
    const id = `sc-${key}`;
    const label = document.createElement("label");
    label.className = "choice";
    label.htmlFor = id;
    label.innerHTML = `<input type="radio" name="scenario" id="${id}" value="${key}"${key === state.scenario ? " checked" : ""}><span><b></b><small></small></span>`;
    (label.querySelector("b") as HTMLElement).textContent = s.label;
    (label.querySelector("small") as HTMLElement).textContent = s.what;
    list.appendChild(label);
  }
  list.addEventListener("change", (e) => { state.scenario = (e.target as HTMLInputElement).value as Scenario; });
}

function wireControls() {
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((el) =>
    el.addEventListener("change", () => { if (el.checked) state.mode = el.value; }));
  for (const k of ["global", "site", "aff"] as const) {
    $(`#kill-${k}`).addEventListener("change", (e) => { state.kill[k] = (e.target as HTMLInputElement).checked; });
  }
  $("#config").addEventListener("change", (e) => { state.config = (e.target as HTMLSelectElement).value as typeof state.config; });
  $("#load").addEventListener("click", () => void loadPage());
  $("#more").addEventListener("click", addSlot);
}

renderScenarios();
wireControls();
resetPage();
