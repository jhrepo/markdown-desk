// Shared localStorage-session utilities for e2e specs.

// Freeze writes to the submodule's tab-session keys for the remainder of the
// CURRENT page. Markdown-Viewer 3.7.x (PERF-008) flushes its in-memory `tabs`
// array to markdownViewerTabs on `beforeunload`; any spec that seeds or
// clears the session and then reloads would otherwise have that flush clobber
// the seed with the previous page's stale tabs. The patch dies with the page
// on reload (fresh JS context), so all keys persist normally afterwards.
//
// Usage: `await browser.execute(installTabSessionWriteFreeze)` right before
// the reload (wdio serializes this function into the browser context, so it
// must stay self-contained). Keep the key list in sync with bridge.js
// hardReload()'s in-page copy — production code cannot import from here.
export function installTabSessionWriteFreeze() {
  const origSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (k === 'markdownViewerTabs' || k === 'markdownViewerActiveTab') return;
    return origSetItem.call(this, k, v);
  };
}
