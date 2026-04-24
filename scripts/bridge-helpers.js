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

  return {
    shouldRunBackgroundCheck: shouldRunBackgroundCheck,
    getExportBaseName: getExportBaseName,
  };
});
