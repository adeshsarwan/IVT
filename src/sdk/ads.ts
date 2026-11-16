// Thebes ad loader (ads.js). Separate from ivt.js so the IVT sensor never contains GAM knowledge.
//
// Fail-closed contract: ads render ONLY if
//   1. ivt.js admission produced an Ad Pass, and
//   2. POST /v1/ad-units accepted that pass and returned a valid config.
// No fallback config, no caching, no "load anyway after timeout". Every error = no ads.

const GPT_URL = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";
const DEFAULT_TIMEOUT_MS = 8000;
const REFETCH_DEBOUNCE_MS = 250;
const MAX_REFETCHES = 20;

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

async function fetchUnits(endpoint: string, adPass: string, timeoutMs: number): Promise<AdUnits | null> {
  if (timeoutMs <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    if (!response.ok) return null;
    return parseAdUnits(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Placeholders not yet handed to GPT.
function pendingPlaceholders(): Element[] {
  const out: Element[] = [];
  document.querySelectorAll("[data-ad-slot]").forEach((el) => {
    if (!el.getAttribute("data-ad-filled")) out.push(el);
  });
  return out;
}

let slotSeq = 0;

// Defines and displays GPT slots for matching placeholders. Returns how many were filled.
function fill(w: AdsWindow, units: AdUnits, elements: Element[]): number {
  const bySlot = new Map(units.slots.map((s) => [s.div, s] as const));
  const jobs: Array<{ slot: Slot; id: string }> = [];
  for (const el of elements) {
    const slot = bySlot.get(el.getAttribute("data-ad-slot") || "");
    if (!slot) { el.setAttribute("data-ad-filled", "none"); continue; } // unknown name: don't refetch for it
    el.setAttribute("data-ad-filled", "1");
    if (!el.id) el.id = `thebes-ad-${slot.div}-${++slotSeq}`;
    jobs.push({ slot, id: el.id });
  }
  if (!jobs.length) return 0;

  const targeting = units.targeting;
  // GPT is requested once per document; the DOM is the source of truth.
  const needScript = !document.querySelector(`script[src="${GPT_URL}"]`);
  const googletag: Googletag = (w.googletag = w.googletag || { cmd: [] });
  googletag.cmd.push(() => {
    const pubads = googletag.pubads();
    for (const [k, v] of Object.entries(targeting)) pubads.setTargeting(k, v);
    for (const job of jobs) {
      const slot = googletag.defineSlot(job.slot.path, job.slot.sizes, job.id);
      if (slot) slot.addService(pubads);
    }
    googletag.enableServices(); // idempotent in GPT
    for (const job of jobs) googletag.display(job.id);
  });

  if (needScript) {
    const script = document.createElement("script");
    script.src = GPT_URL;
    script.async = true;
    script.crossOrigin = "anonymous";
    (document.head || document.documentElement).appendChild(script);
  }
  return jobs.length;
}

// Later placeholders (SPA navigation, infinite scroll) re-redeem the same pass, so the server
// re-checks expiry, binding, kill switches and config every time. Any refusal stops watching.
function watchForNewPlaceholders(w: AdsWindow, endpoint: string, adPass: string, timeoutMs: number) {
  if (typeof MutationObserver !== "function" || !document.body) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let refetches = 0;
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (busy || !pendingPlaceholders().length) return;
      if (++refetches > MAX_REFETCHES) { observer.disconnect(); return; }
      busy = true;
      try {
        const units = await fetchUnits(endpoint, adPass, timeoutMs);
        if (!units) { observer.disconnect(); return; }
        fill(w, units, pendingPlaceholders());
      } finally {
        busy = false;
      }
    }, REFETCH_DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function run(w: AdsWindow, options: AdsOptions): Promise<boolean> {
  const endpoint = options.endpoint.replace(/\/$/, "");
  const timeoutMs = Math.max(50, Math.min(20000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const startedAt = Date.now();

  const admission = await deadline(admissionPromise(w), timeoutMs);
  const adPass = admission?.adPass;
  if (typeof adPass !== "string" || !adPass) return false;
  delete admission.adPass; // only this loader holds the pass from here on.

  const units = await fetchUnits(endpoint, adPass, timeoutMs - (Date.now() - startedAt));
  if (!units || Date.now() - startedAt > timeoutMs) return false;
  const filled = fill(w, units, pendingPlaceholders());
  watchForNewPlaceholders(w, endpoint, adPass, timeoutMs);
  return filled > 0;
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
