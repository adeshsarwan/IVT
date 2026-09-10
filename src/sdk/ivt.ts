import { startTelemetry } from "./telemetry";

type IVTOptions = {
  endpoint: string;
  siteKey: string;
  heartbeatMs?: number;
};

type Admission = {
  status: string;
  runtime?: string;
  telemetryToken?: string;
  expiresIn?: number;
};

type IVTResult = {
  admitted: boolean;
  stopTelemetry?: () => void;
};

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function browserEvidence() {
  return {
    ua: navigator.userAgent,
    language: navigator.language,
    languages: navigator.languages,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory || null,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    webdriver: navigator.webdriver === true,
    cookieEnabled: navigator.cookieEnabled,
    screen: {
      width: screen.width,
      height: screen.height,
      colorDepth: screen.colorDepth,
      pixelRatio: window.devicePixelRatio || 1,
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    visibility: document.visibilityState,
  };
}

function attributionEvidence() {
  const p = new URLSearchParams(location.search);
  const keys = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "ScCid", "utm_source", "utm_medium", "utm_campaign", "utm_id"];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = p.get(key);
    if (value) out[key] = value.slice(0, 512);
  }
  return out;
}

async function loadRuntime(endpoint: string, runtime: string): Promise<void> {
  const src = new URL(runtime, endpoint).toString();
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("IVT runtime unavailable"));
    (document.head || document.documentElement).appendChild(script);
  });
}

export async function initIVT(options: IVTOptions): Promise<IVTResult> {
  const endpoint = options.endpoint.replace(/\/$/, "");
  const response = await fetch(`${endpoint}/v1/admit`, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      siteKey: options.siteKey,
      nonce: randomNonce(),
      page: { href: location.href.slice(0, 2048), referrer: document.referrer.slice(0, 2048) },
      browser: browserEvidence(),
      attribution: attributionEvidence(),
    }),
  });

  if (!response.ok) return { admitted: false };
  const admission = (await response.json()) as Admission;
  if (admission.status !== "ADMITTED" || !admission.runtime || !admission.telemetryToken) {
    return { admitted: false };
  }

  // Telemetry is IVT-only. The token is short-lived and signed by the Worker; it contains
  // no GAM, Price Optimiser, buyer credential, or monetisation configuration.
  const stopTelemetry = startTelemetry({
    endpoint,
    token: admission.telemetryToken,
    heartbeatMs: options.heartbeatMs,
  });

  try {
    await loadRuntime(endpoint, admission.runtime);
  } catch (error) {
    stopTelemetry();
    throw error;
  }

  return { admitted: true, stopTelemetry };
}

// Optional auto-init for script-tag integrations. The SDK remains unaware of what runtime follows admission.
const current = document.currentScript as HTMLScriptElement | null;
if (current?.dataset.autoInit === "true") {
  const endpoint = current.dataset.endpoint;
  const siteKey = current.dataset.siteKey;
  const heartbeatMs = current.dataset.heartbeatMs ? Number(current.dataset.heartbeatMs) : undefined;
  if (endpoint && siteKey) {
    void initIVT({
      endpoint,
      siteKey,
      heartbeatMs: Number.isFinite(heartbeatMs) ? heartbeatMs : undefined,
    }).catch(() => undefined);
  }
}
