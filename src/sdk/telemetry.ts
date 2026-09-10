export type TelemetrySummary = {
  sequence: number;
  eventType: "heartbeat" | "final";
  elapsedMs: number;
  visibleMs: number;
  focusedMs: number;
  activeMs: number;
  maxScrollPct: number;
  pointerEvents: number;
  touchEvents: number;
  keyEvents: number;
  visibilityChanges: number;
  focusChanges: number;
};

type TelemetryOptions = {
  endpoint: string;
  token: string;
  heartbeatMs?: number;
};

// Privacy-preserving aggregate behavior collector. It never records coordinates,
// typed keys, DOM contents, game data, GAM state or monetisation information.
export function startTelemetry(options: TelemetryOptions): () => void {
  const endpoint = options.endpoint.replace(/\/$/, "");
  const startedAt = performance.now();
  let lastTick = startedAt;
  let visibleMs = 0;
  let focusedMs = 0;
  let activeMs = 0;
  let maxScrollPct = 0;
  let pointerEvents = 0;
  let touchEvents = 0;
  let keyEvents = 0;
  let visibilityChanges = 0;
  let focusChanges = 0;
  let sequence = 0;
  let lastActivityAt: number | null = null;
  let stopped = false;

  const activity = () => { lastActivityAt = performance.now(); };
  const onPointer = () => { pointerEvents++; activity(); };
  const onTouch = () => { touchEvents++; activity(); };
  const onKey = () => { keyEvents++; activity(); };
  const onVisibility = () => { visibilityChanges++; };
  const onFocus = () => { focusChanges++; };
  const onScroll = () => {
    const root = document.documentElement;
    const denominator = Math.max(1, root.scrollHeight - window.innerHeight);
    maxScrollPct = Math.max(maxScrollPct, Math.min(100, Math.round((window.scrollY / denominator) * 100)));
    activity();
  };

  const tick = () => {
    const now = performance.now();
    const delta = Math.max(0, now - lastTick);
    if (document.visibilityState === "visible") visibleMs += delta;
    if (document.hasFocus()) focusedMs += delta;
    if (lastActivityAt !== null && now - lastActivityAt <= 15_000 && document.visibilityState === "visible") {
      activeMs += delta;
    }
    lastTick = now;
  };

  const summary = (eventType: "heartbeat" | "final"): TelemetrySummary => {
    tick();
    return {
      sequence: sequence++,
      eventType,
      elapsedMs: Math.round(performance.now() - startedAt),
      visibleMs: Math.round(visibleMs),
      focusedMs: Math.round(focusedMs),
      activeMs: Math.round(activeMs),
      maxScrollPct,
      pointerEvents,
      touchEvents,
      keyEvents,
      visibilityChanges,
      focusChanges,
    };
  };

  const send = (eventType: "heartbeat" | "final", keepalive = false) => {
    if (stopped && eventType !== "final") return;
    const body = JSON.stringify({ token: options.token, ...summary(eventType) });
    void fetch(`${endpoint}/v2/telemetry`, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      keepalive,
      headers: { "content-type": "application/json" },
      body,
    }).catch(() => undefined);
  };

  window.addEventListener("pointerdown", onPointer, { passive: true });
  window.addEventListener("touchstart", onTouch, { passive: true });
  window.addEventListener("keydown", onKey, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("visibilitychange", onVisibility, { passive: true });
  window.addEventListener("focus", onFocus, { passive: true });
  window.addEventListener("blur", onFocus, { passive: true });

  const interval = window.setInterval(() => send("heartbeat"), Math.max(15_000, options.heartbeatMs || 30_000));
  const onPageHide = () => send("final", true);
  window.addEventListener("pagehide", onPageHide, { once: true });

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    window.removeEventListener("pointerdown", onPointer);
    window.removeEventListener("touchstart", onTouch);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onFocus);
    window.removeEventListener("pagehide", onPageHide);
    send("final", true);
  };
}
