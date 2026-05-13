// bridge-helpers.js — pure functions extracted from scripts/bridge.js so
// they can be unit-tested with Node without a DOM.
//
// Exposed on `window.__bridgeHelpers` in the browser (bridge.js reads from
// here at call sites) and via CommonJS `module.exports` in Node.

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
    return;
  }
  root.__bridgeHelpers = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // Whether a background update check should run given the raw localStorage
  // value for the last-check timestamp, the current wall-clock time, and
  // the allowed interval between checks. Any non-positive or malformed
  // stored value is treated as "no record" so the next startup doesn't
  // permanently lock us out due to a bad write.
  function shouldRunBackgroundCheck(rawLastCheck, nowMs, intervalMs) {
    if (rawLastCheck == null) return true;
    var last = parseInt(rawLastCheck, 10);
    if (!isFinite(last) || last <= 0) return true;
    var elapsed = nowMs - last;
    // Clock skew (manual time change, NTP sync) can land a future value
    // in storage. Without this guard elapsed is negative forever and the
    // user stops getting update checks. Treat any future stamp as "no
    // valid record, re-check now".
    if (elapsed < 0) return true;
    return elapsed >= intervalMs;
  }

  // Strip a trailing `.md` / `.MD` from the active tab's title and fall
  // back to "document" when the result would be empty. Used as the default
  // name in the native save dialog for MD/HTML/PDF exports.
  function getExportBaseName(activeTabTitle) {
    if (activeTabTitle == null) return 'document';
    var name = String(activeTabTitle).trim();
    if (!name) return 'document';
    var stripped = name.replace(/\.md$/i, '');
    return stripped || 'document';
  }

  // ---- Webview zoom helpers ----
  // The original Markdown-Viewer relies on the browser's built-in zoom
  // (Cmd/Ctrl +/-/0 and trackpad pinch). Tauri's WKWebView ships with
  // those bindings disabled, so bridge.js intercepts the inputs and
  // routes them through `core:webview:set-webview-zoom`. These helpers
  // keep that logic DOM-free so it can be unit-tested.

  var ZOOM_MIN = 0.3;
  var ZOOM_MAX = 3.0;
  var ZOOM_STEP = 0.1;
  // Wheel deltas span ~2 orders of magnitude between trackpad pinch
  // (~1-10) and mouse wheel + Ctrl (~100). 0.01 maps both into smooth
  // sub-step increments per frame without making pinch feel jumpy.
  var WHEEL_ZOOM_RATIO = 0.01;

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function clampZoom(value, min, max) {
    if (value == null || !isFinite(value)) return 1.0;
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function nextZoomStep(current, direction) {
    if (!direction) return current;
    var sign = direction > 0 ? 1 : -1;
    return clampZoom(round2(current + sign * ZOOM_STEP), ZOOM_MIN, ZOOM_MAX);
  }

  function nextZoomFromWheel(current, deltaY) {
    if (!deltaY) return current;
    // Negative deltaY = scroll-up / pinch-out = zoom in.
    var step = -deltaY * WHEEL_ZOOM_RATIO;
    return clampZoom(round2(current + step), ZOOM_MIN, ZOOM_MAX);
  }

  // ---- View mode helpers ----
  // The submodule's createTab() hard-codes 'split' for every new tab and
  // does not honor the user's recent preference. bridge.js records the
  // last-used mode in localStorage and applies it on each new tab; this
  // helper validates the stored value against the known mode whitelist so
  // a single corrupted write can't push the host into an unrenderable
  // state.

  var VIEW_MODES = ['editor', 'split', 'preview'];

  function pickInitialViewMode(saved, fallback) {
    if (typeof saved === 'string' && VIEW_MODES.indexOf(saved) >= 0) return saved;
    if (typeof fallback === 'string' && VIEW_MODES.indexOf(fallback) >= 0) return fallback;
    return 'split';
  }

  return {
    shouldRunBackgroundCheck: shouldRunBackgroundCheck,
    getExportBaseName: getExportBaseName,
    clampZoom: clampZoom,
    nextZoomStep: nextZoomStep,
    nextZoomFromWheel: nextZoomFromWheel,
    pickInitialViewMode: pickInitialViewMode,
    ZOOM_MIN: ZOOM_MIN,
    ZOOM_MAX: ZOOM_MAX,
    VIEW_MODES: VIEW_MODES,
  };
});
