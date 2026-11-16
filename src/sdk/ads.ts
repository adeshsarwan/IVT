// Thebes ad loader (ads.js). Separate from ivt.js so the IVT sensor never contains GAM knowledge.
//
// Fail-closed contract: ads render ONLY if
//   1. ivt.js admission produced an Ad Pass, and
//   2. POST /v1/ad-units accepted that pass and returned a valid config.
// No fallback config, no caching, no "load anyway after timeout". Every error = no ads.

const GPT_URL = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";
const DEFAULT_TIMEOUT_MS = 8000;

type AdsOptions = { endpoint: string; timeoutMs?: number };
type Slot = { div: string; path: string; sizes: Array<[number, number]> };
type AdUnits = { slots: Slot[]; targeting: Record<string, string | string[]> };
type Admission = { adPass?: unknown };
type Googletag = { cmd: Array<() => void>; [k: string]: any };
type AdsWindow = Window & {
  __THEBES_IVT_INIT__?: Promise<Admission>;
  __THEBES_ADS_INIT__?: Promise<boolean>;
  googletag?: Googletag;
};

function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function admissionPromise(w: AdsWindow): Promise<Admission> {
  if (w.__THEBES_IVT_INIT__) return w.__THEBES_IVT_INIT__;
  return new Promise<Admission>((resolve, reject) => {
    const onInit = () => {
      w.removeEventListener("thebes:ivt-init", onInit);
      if (w.__THEBES_IVT_INIT__) w.__THEBES_IVT_INIT__.then(resolve, reject);
      else reject(new Error("no admission"));
    };
    w.addEventListener("thebes:ivt-init", onInit);
  });
}

function parseAdUnits(input: any): AdUnits | null {
  if (!input || typeof input !== "object" || input.gpt !== GPT_URL) return null;
  if (typeof input.networkCode !== "string" || !/^\d{1,20}$/.test(input.networkCode)) return null;
  if (!Array.isArray(input.slots) || input.slots.length < 1 || input.slots.length > 20) return null;
  const slots: Slot[] = [];
  for (const s of input.slots) {
    if (!s || typeof s.div !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(s.div)) return null;
    if (typeof s.path !== "string" || !s.path.startsWith(`/${input.networkCode}/`)) return null;
    if (!Array.isArray(s.sizes) || !s.sizes.length || !s.sizes.every((z: unknown) =>
      Array.isArray(z) && z.length === 2 && z.every((n) => Number.isInteger(n) && n > 0))) return null;
    slots.push({ div: s.div, path: s.path, sizes: s.sizes });
  }
  const targeting: Record<string, string | string[]> = {};
  if (!input.targeting || typeof input.targeting !== "object") return null;
  for (const [k, v] of Object.entries(input.targeting)) {
    if (typeof v === "string") targeting[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) targeting[k] = v as string[];
    else return null;
  }
  return { slots, targeting };
}

async function run(w: AdsWindow, options: AdsOptions): Promise<boolean> {
  const endpoint = options.endpoint.replace(/\/$/, "");
  const timeoutMs = Math.max(50, Math.min(20000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const startedAt = Date.now();
  const remaining = () => timeoutMs - (Date.now() - startedAt);

  const admission = await deadline(admissionPromise(w), timeoutMs);
  const adPass = admission?.adPass;
  if (typeof adPass !== "string" || !adPass) return false;
  delete admission.adPass; // single use: nobody else on the page gets to redeem it.

  const left = remaining();
  if (left <= 0) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), left);
  let units: AdUnits | null;
  try {
    const response = await fetch(`${endpoint}/v1/ad-units`, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adPass }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    units = parseAdUnits(await response.json());
  } finally {
    clearTimeout(timer);
  }
  if (!units || remaining() <= 0) return false;

  const placeholders = new Map<string, Element>();
  document.querySelectorAll("[data-ad-slot]").forEach((el) => {
    const name = el.getAttribute("data-ad-slot");
    if (name && !placeholders.has(name)) placeholders.set(name, el);
  });
  const matched = units.slots.filter((s) => placeholders.has(s.div));
  if (!matched.length) return false;
  const ids = matched.map((s) => {
    const el = placeholders.get(s.div)!;
    if (!el.id) el.id = `thebes-ad-${s.div}`;
    return el.id;
  });

  const targeting = units.targeting;
  const googletag: Googletag = (w.googletag = w.googletag || { cmd: [] });
  googletag.cmd.push(() => {
    const pubads = googletag.pubads();
    matched.forEach((s, i) => {
      const slot = googletag.defineSlot(s.path, s.sizes, ids[i]);
      if (slot) slot.addService(pubads);
    });
    for (const [k, v] of Object.entries(targeting)) pubads.setTargeting(k, v);
    pubads.enableSingleRequest();
    googletag.enableServices();
    ids.forEach((id) => googletag.display(id));
  });

  const script = document.createElement("script");
  script.src = GPT_URL;
  script.async = true;
  script.crossOrigin = "anonymous";
  (document.head || document.documentElement).appendChild(script);
  return true;
}

export function initAds(options: AdsOptions): Promise<boolean> {
  const w = window as AdsWindow;
  if (!w.__THEBES_ADS_INIT__) w.__THEBES_ADS_INIT__ = run(w, options).catch(() => false);
  return w.__THEBES_ADS_INIT__;
}

const current = document.currentScript as HTMLScriptElement | null;
if (current) {
  let endpoint = current.dataset.endpoint;
  if (!endpoint && current.src) {
    try { endpoint = new URL(current.src).origin; } catch { endpoint = undefined; }
  }
  const timeoutMs = current.dataset.timeoutMs ? Number(current.dataset.timeoutMs) : undefined;
  if (endpoint) void initAds({ endpoint, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined });
}
