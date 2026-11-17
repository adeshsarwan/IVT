/*
 * Thebes Ad Pass gate: reference code for any ad stack (Price Optimiser, a GPT tag, Prebid...).
 * Paste it at the top of the ad script and start the ad stack ONLY when it returns a config.
 *
 *   const config = await thebesAdGate();
 *   if (!config) return;            // no pass, refused, server down or too slow: do nothing
 *   startAds(config);               // GPT / bids / slots only from here
 *
 * Plain ES2020, no dependencies. Every failure resolves to null; it never throws.
 * Docs: docs/ad-pass/README.md
 */
async function thebesAdGate(options) {
  var opts = options || {};
  var endpoint = (opts.endpoint || "https://ivt.thebesads.com").replace(/\/$/, "");
  var deadline = Date.now() + (opts.timeoutMs || 8000);
  var remaining = function () { return Math.max(0, deadline - Date.now()); };
  var orNullAtDeadline = function (promise) {
    return Promise.race([promise, new Promise(function (resolve) { setTimeout(function () { resolve(null); }, remaining()); })]);
  };

  try {
    // 1. Wait for ivt.js admission (it may load before or after this script).
    var admission = await orNullAtDeadline(thebesWaitForAdmission());
    var adPass = admission && admission.adPass;
    if (typeof adPass !== "string" || !adPass) return null;

    // 2. Exchange the pass for this visit's ad config. The server re-checks everything.
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, remaining());
    try {
      var response = await orNullAtDeadline(fetch(endpoint + "/v1/ad-units", {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adPass: adPass }),
        signal: controller ? controller.signal : undefined,
      }));
      if (!response || !response.ok) return null;
      var config = await response.json();
      return config && typeof config === "object" && Array.isArray(config.slots) ? config : null;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return null;
  }
}

function thebesWaitForAdmission() {
  var w = window;
  var settle = function (p) { return p ? p.catch(function () { return null; }) : null; };
  if (w.__THEBES_IVT_INIT__) return settle(w.__THEBES_IVT_INIT__);
  return new Promise(function (resolve) {
    w.addEventListener("thebes:ivt-init", function () { resolve(settle(w.__THEBES_IVT_INIT__)); }, { once: true });
  });
}
