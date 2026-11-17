// In-browser Ad Pass demo. Runs the REAL Worker (src/worker.ts), the REAL ivt.js (src/sdk/ivt.ts)
// and the REAL reference gate (docs/ad-pass/ad-gate.js, injected by demo/build.mjs) in one page. Calls to the Worker are routed in-page to
// worker.fetch() with in-memory KV/D1/Durable Object stand-ins. Google's GPT is stubbed:
// no real ad requests are made. A Price Optimiser stand-in renders placeholder ads. Never deployed; built by `npm run build:demo`.
import worker, { type Env } from "../src/worker";
import { initIVT } from "../src/sdk/ivt";

// Global from docs/ad-pass/ad-gate.js (inlined before this bundle).
declare function thebesAdGate(options?: { endpoint?: string; timeoutMs?: number }): Promise<any | null>;

const ENDPOINT = "https://ivt.thebesads.com";
const SITE = "gamewhame.com";
const SITE_ORIGIN = "https://gamewhame.com";
const VISITOR_IP = "203.0.113.7";

type Scenario = "real" | "bot" | "noivt" | "down" | "stolen" | "otherbrowser" | "tampered" | "expired" | "crosssite";
const SCENARIOS: Record<Scenario, { label: string; what: string }> = {
  real: { label: "Real visitor", what: "A normal browser on gamewhame.com. ivt.js runs, the server approves, and the ad script starts only after the server confirms the pass." },
  bot: { label: "Bot (headless browser)", what: "The browser reports webdriver = true. In enforce mode the server gives no pass, so the ad script has nothing to redeem." },
  noivt: { label: "Partner removed ivt.js", what: "Only the ad script is on the page. Its gate waits for a pass that never comes, then gives up. No ads." },
  down: { label: "IVT server unreachable", what: "Every call to ivt.thebesads.com fails. No pass, no ad units, no ads." },
  stolen: { label: "Pass replayed from another network", what: "A valid pass is sent to /v1/ad-check from IP 198.51.100.23 instead of 203.0.113.x. The IP binding fails." },
  otherbrowser: { label: "Pass replayed from a script", what: "A valid pass is sent with User-Agent python-requests. The browser binding fails." },
  tampered: { label: "Pass edited to never expire", what: "The browser rewrites exp to one year from now and keeps the old signature. The signature check fails." },
  expired: { label: "Pass used after 31 minutes", what: "The ad-check call happens 31 minutes after admission. The 30 minute pass has expired." },
  crosssite: { label: "Pass reused on another site", what: "A pass issued to gamewhame.com is redeemed from jobsqualified.com. The origin binding fails." },
};

const state = {
  scenario: "real" as Scenario,
  mode: "enforce",
  kill: { global: false, site: false, aff42: false, aff77: false },
  aff: "42" as string, // "" = no ?aff= in the URL
};

// The ad script (Price Optimiser) owns its ad units. The server never sees or returns these.
const AD_STACK_SLOTS: Record<string, { path: string; sizes: number[][] }> = {
  top: { path: "/1234567/gamewhame/top", sizes: [[300, 250]] },
  mid: { path: "/1234567/gamewhame/mid", sizes: [[300, 250]] },
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
      if (key === "ads:aff:42") return state.kill.aff42 ? "off" : null;
      if (key === "ads:aff:77") return state.kill.aff77 ? "off" : null;
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
      ["affiliate", c.aff === null ? "none" : String(c.aff)],
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

// The demo reuses one document for many simulated page loads. A real reload gives each page a
// fresh document, so a previous page's pass can never reach the next page. Mirror that here:
// only the pass issued during the current simulated load may be redeemed.
let currentPass: string | null = null;

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(ENDPOINT)) return realFetch(input, init);
  const path = new URL(url).pathname;
  if (path === "/v2/telemetry") return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
  const isAdCheck = path === "/v1/ad-check";
  if (isAdCheck) {
    let sent: unknown;
    try { sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}").adPass; } catch { sent = undefined; }
    if (!currentPass || sent !== currentPass) return new Response(null, { status: 403 }); // left over from a previous simulated page
  }
  const actor = isAdCheck ? "ad script → server" : "ivt.js → server";

  if (state.scenario === "down") {
    log(actor, `POST ${path} · network error`, "deny", "The IVT server could not be reached.");
    throw new TypeError("Failed to fetch");
  }

  let body = typeof init?.body === "string" ? init.body : undefined;
  if (path === "/v1/admit" && body) {
    // The demo itself is hosted elsewhere; report the simulated publisher page instead.
    const parsed = JSON.parse(body);
    parsed.page = { href: `${SITE_ORIGIN}/games/word-sprint`, referrer: "https://www.google.com/" };
    parsed.attribution = state.aff ? { aff: state.aff } : {};
    if (state.scenario === "bot") parsed.browser = { ...parsed.browser, webdriver: true };
    body = JSON.stringify(parsed);
  }
  const headers = new Headers({
    "content-type": "application/json",
    Origin: isAdCheck && state.scenario === "crosssite" ? "https://jobsqualified.com" : SITE_ORIGIN,
    "CF-Connecting-IP": isAdCheck && state.scenario === "stolen" ? "198.51.100.23" : VISITOR_IP,
    "User-Agent": isAdCheck && state.scenario === "otherbrowser" ? "python-requests/2.32" : navigator.userAgent,
  });
  const request = new Request(url, { method: init?.method || "GET", body });
  Object.defineProperty(request, "headers", { value: headers });

  const realNow = Date.now;
  if (isAdCheck && state.scenario === "expired") Date.now = () => realNow() + 31 * 60_000;
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
    currentPass = typeof data.adPass === "string" ? data.adPass : null;
    if (data.adPass) {
      log(actor, `POST /v1/admit · ${response.status} · Ad Pass issued`, "pass", decodePass(data.adPass));
      if (state.scenario === "tampered") log("browser", "Pass edited: expiry pushed one year out, old signature kept", "warn");
    } else {
      const why = state.mode === "off" ? "AD_PASS_MODE is off"
        : data.monetization?.eligible === false && state.mode === "enforce" ? "visit is not eligible"
        : state.aff && !/^[A-Za-z0-9_-]{1,32}$/.test(state.aff) ? "the ?aff= value is malformed"
        : "a kill switch is on";
      log(actor, `POST /v1/admit · ${response.status} · no Ad Pass`, "deny", [["status", String(data.status)], ["eligible", String(data.monetization?.eligible)], ["reason (server side only)", why]]);
    }
  } else if (isAdCheck) {
    if (response.ok) {
      const data = JSON.parse(text);
      log(actor, "POST /v1/ad-check · 200 · approved", "pass", [
        ["answer", "ads allowed (no ad units: the ad script owns those)"],
        ["key-values", Object.entries(data.targeting).map(([k, v]) => `${k}=${v}`).join("  ")],
        ["pass valid until", new Date(data.expiresAt * 1000).toLocaleTimeString()],
        ["cache-control", response.headers.get("cache-control") || ""],
      ]);
    } else {
      log(actor, `POST /v1/ad-check · ${response.status} · refused`, "deny", "Empty body by design: the browser learns nothing about why.");
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
  return realAppend(node);
};

// Stand-in for Price Optimiser: it starts only after the gate approved, uses its OWN slot list,
// and adds the server's key-values. The real PO would load GPT and run its auction here.
function startAdStack(approval: any, runId: number) {
  if (runId !== currentRun) return 0;
  const bySlot = new Map(Object.entries(AD_STACK_SLOTS));
  let filled = 0;
  for (const el of document.querySelectorAll<HTMLElement>("#site [data-ad-slot]:not(.filled)")) {
    const slot = bySlot.get(el.getAttribute("data-ad-slot") || "");
    if (!slot) continue;
    renderAd(el, slot, approval.targeting || {});
    filled++;
  }
  return filled;
}

function renderAd(el: HTMLElement, slot: { path: string; sizes: number[][] }, targeting: Record<string, unknown>) {
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
  log("ad stack (stand-in)", `Ad rendered in “${el.getAttribute("data-ad-slot")}” slot`, "pass");
}

// ---------- page lifecycle ----------

let currentRun = 0;
let stopTelemetry: (() => void) | undefined;
let running = false;
let extraSlots = 0;

function resetPage() {
  currentRun++;
  stopTelemetry?.();
  stopTelemetry = undefined;
  const w = window as any;
  delete w.__THEBES_IVT_INIT__;
  guards.clear();
  currentPass = null;
  extraSlots = 0;
  $("#log").innerHTML = "";
  for (const el of document.querySelectorAll("#site [data-ad-slot]")) {
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
    const runId = currentRun;
    log("page", "Ad script starts; its gate waits for an Ad Pass", "info");
    const approval = await thebesAdGate({ endpoint: ENDPOINT, timeoutMs: 2500 });
    if (runId !== currentRun) return;
    const shown = approval ? startAdStack(approval, runId) > 0 : false;
    if (shown) {
      const observeOnly = state.mode === "observe" && state.scenario === "bot";
      setVerdict("pass", "Ads shown", observeOnly
        ? "Observe mode: this visit would be blocked, but ads still load, tagged ivt_e=0 so GAM reports can measure it."
        : "The server confirmed the pass, so the ad script started.");
      ($("#more") as HTMLButtonElement).disabled = false;
    } else {
      log("ad script", "Gate returned nothing. The ad stack never starts: no GPT, no bids.", "deny");
      setVerdict("deny", "No ads", SCENARIOS[state.scenario].what);
    }
  } finally {
    running = false;
  }
}

async function addSlot() {
  extraSlots++;
  const block = document.createElement("div");
  block.className = "extra";
  block.innerHTML = `<h3>More to play: puzzle pack ${extraSlots + 1}</h3><p>Another article loaded by infinite scroll. It brings its own ad placeholder.</p><div class="slot" data-ad-slot="mid"></div>`;
  $("#feed").appendChild(block);
  log("page", "New placeholder added (infinite scroll). The ad script runs the gate again with the same pass.", "info");
  const runId = currentRun;
  const approval = await thebesAdGate({ endpoint: ENDPOINT, timeoutMs: 2500 });
  if (!approval) { log("ad script", "Gate refused. The new slot stays empty.", "deny"); return; }
  startAdStack(approval, runId);
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
  for (const k of ["global", "site", "aff42", "aff77"] as const) {
    $(`#kill-${k}`).addEventListener("change", (e) => { state.kill[k] = (e.target as HTMLInputElement).checked; });
  }
  $("#aff").addEventListener("change", (e) => {
    state.aff = (e.target as HTMLSelectElement).value;
    $("#url").textContent = `https://gamewhame.com/games/word-sprint${state.aff ? `?aff=${state.aff}` : ""}`;
  });
  $("#load").addEventListener("click", () => void loadPage());
  $("#more").addEventListener("click", () => void addSlot());
}

renderScenarios();
wireControls();
resetPage();
