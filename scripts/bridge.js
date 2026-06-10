// bridge.js — Tauri ↔ Web app bridge
// Injected into <head> via prepare-frontend.sh (runs before original scripts)
(function() {

  // Sidecar map from tab id → canonical file path.
  // Tab title alone is ambiguous when two open files share the same basename
  // (e.g. ~/work/README.md + ~/personal/README.md), so the watcher's updates
  // need a stable per-tab key. The map is persisted so it survives reloads.
  var BRIDGE_TAB_PATHS_KEY = 'bridge-tab-paths';
  function bridgeLoadTabPaths() {
    try { return JSON.parse(localStorage.getItem(BRIDGE_TAB_PATHS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function bridgeSaveTabPaths(m) {
    try { localStorage.setItem(BRIDGE_TAB_PATHS_KEY, JSON.stringify(m)); } catch (_) {}
  }

  // Drop entries whose tab id no longer appears in the host app's tab list.
  // Without this, every closed tab leaks an entry forever — long-lived
  // sessions (esp. workflows that auto-generate temp .md files) can push the
  // map past localStorage's quota, at which point bridgeSaveTabPaths fails
  // silently and the watcher loses path matching for *all* tabs. Same failure
  // class as the original title-vs-path bug (silent + scoped to a known set).
  //
  // The earlier title-vs-path basename heuristic for auto-recovering
  // poisoned entries was removed: Markdown-Viewer's renameTab() lets the
  // user overwrite tab.title freely, so basename mismatch is the *normal*
  // state after a rename. Dropping the entry there would permanently break
  // live-reload for that tab until it's closed and re-opened. The
  // first-seen gate in bridgeStampTabPath already prevents fresh
  // poisoning, so stale-id GC is enough on its own.
  function bridgeGcTabPaths(map) {
    var liveTabs;
    try {
      liveTabs = JSON.parse(localStorage.getItem('markdownViewerTabs') || '[]');
    } catch (_) { return false; }
    var byId = Object.create(null);
    liveTabs.forEach(function(t) { if (t && t.id) byId[t.id] = t; });

    var changed = false;
    Object.keys(map).forEach(function(id) {
      if (!byId[id]) { delete map[id]; changed = true; }
    });
    return changed;
  }

  document.addEventListener('DOMContentLoaded', function() {
    window.__bridgeTabPaths = bridgeLoadTabPaths();
    // One-shot GC on startup: collapse any drift that accumulated before this
    // version (or that closeTabsByIds missed if the host re-rendered before
    // we could observe the click).
    if (bridgeGcTabPaths(window.__bridgeTabPaths)) {
      bridgeSaveTabPaths(window.__bridgeTabPaths);
    }
    // Pushed by Rust js_new_tab right before dispatching each synthetic
    // file-input change. A FIFO queue (not a single variable) is required so
    // a multi-file open — N rapid evals followed by N MutationObserver
    // callbacks possibly batched into one — keeps each tab paired with the
    // path it was opened with. A scalar would be overwritten by the last
    // push and silently swap paths between tabs.
    window.__bridgeNextPaths = window.__bridgeNextPaths || [];

    // Tab ids whose first-paint stamp we've already considered. The queue
    // must only be drained for *new* tab nodes — never for re-renders of
    // tabs we already know about. Without this guard, renderTabBar's
    // wholesale `tabList.innerHTML = ''` + re-append means the Welcome
    // tab (or any pre-existing tab) replays through the MO callback and
    // can pull the queued path from under the actually-new tab. The
    // resulting silent path swap leaves the new tab with no data-path,
    // so the watcher's path-based match never fires and the editor
    // never refreshes — exactly the live-reload regression that
    // motivated this gate.
    var seenTabIds = Object.create(null);

    function bridgeStampTabPath(item) {
      if (!item || !item.classList || !item.classList.contains('tab-item')) return;
      var id = item.getAttribute('data-tab-id');
      var existing = id ? window.__bridgeTabPaths[id] : null;
      var firstSeen = !!id && !seenTabIds[id];
      var path;
      if (existing) {
        // Re-render of a known tab: restamp from the per-tab map.
        path = existing;
      } else if (firstSeen && window.__bridgeNextPaths.length) {
        // Genuinely new tab (host just created it for a freshly opened
        // file): pair it with the next queued path.
        path = window.__bridgeNextPaths.shift();
      }
      if (id) seenTabIds[id] = 1;
      if (!path) return;
      item.setAttribute('data-path', path);
      if (id && !existing) {
        window.__bridgeTabPaths[id] = path;
        bridgeSaveTabPaths(window.__bridgeTabPaths);
      }
    }

    function bridgeRestampAllTabs() {
      var items = document.querySelectorAll('#tab-list .tab-item');
      // Mark all pre-existing tabs as seen BEFORE stamping so none of
      // them can drain __bridgeNextPaths if the host happens to have
      // pre-pushed entries (e.g. file-association open arriving before
      // DOMContentLoaded resolves).
      items.forEach(function(it) {
        var id = it.getAttribute('data-tab-id');
        if (id) seenTabIds[id] = 1;
      });
      items.forEach(bridgeStampTabPath);
    }

    // Re-apply data-path on an existing tab using only the sidecar map.
    // Used when an attribute-mutation observer reports a data-tab-id change
    // (in-place id rename rather than node destroy/recreate). The queue
    // must NOT be consumed here — id rename ≠ new file open, so taking
    // from the queue would mis-pair a path with the wrong tab.
    function bridgeRestampFromMap(item) {
      if (!item || !item.classList || !item.classList.contains('tab-item')) return;
      var id = item.getAttribute('data-tab-id');
      var existing = id ? window.__bridgeTabPaths[id] : null;
      if (existing) item.setAttribute('data-path', existing);
    }

    (function installTabPathObserver() {
      var tabList = document.getElementById('tab-list');
      if (!tabList) return;
      var mo = new MutationObserver(function(records) {
        records.forEach(function(rec) {
          if (rec.type === 'childList') {
            Array.from(rec.addedNodes).forEach(function(node) {
              if (node && node.nodeType === 1) bridgeStampTabPath(node);
            });
          } else if (rec.type === 'attributes' && rec.target && rec.target.nodeType === 1) {
            // Defensive: today the host re-renders by destroying + recreating
            // tab nodes, but a future switch to in-place data-tab-id rename
            // would silently lose data-path without this. Cheap insurance —
            // attributeFilter scopes us to data-tab-id, and our own
            // setAttribute('data-path', …) won't re-trigger the observer.
            bridgeRestampFromMap(rec.target);
          }
        });
      });
      mo.observe(tabList, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-tab-id'],
      });
      bridgeRestampAllTabs();
    })();

    // Override Reset buttons to hard reload
    var resetBtn = document.getElementById('tab-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        hardReload();
      }, true);
    }
    var mobileResetBtn = document.getElementById('mobile-tab-reset-btn');
    if (mobileResetBtn) {
      mobileResetBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        hardReload();
      }, true);
    }

    // Restore file watchers on app restart
    // Migrate old single-path key to new array key
    var oldPath = localStorage.getItem('markdown-desk-watched-path');
    if (oldPath) {
      var existing;
      try {
        existing = JSON.parse(localStorage.getItem('markdown-desk-watched-paths') || '[]');
      } catch (e) { existing = []; }
      if (existing.indexOf(oldPath) < 0) existing.push(oldPath);
      localStorage.setItem('markdown-desk-watched-paths', JSON.stringify(existing));
      localStorage.removeItem('markdown-desk-watched-path');
    }
    var watchedPaths;
    try {
      watchedPaths = JSON.parse(localStorage.getItem('markdown-desk-watched-paths') || '[]');
    } catch (e) { watchedPaths = []; }
    if (watchedPaths.length && window.__TAURI_INTERNALS__) {
      watchedPaths.forEach(function(p) {
        window.__TAURI_INTERNALS__.invoke('restore_watcher', { path: p })
          .then(function(canonical) {
            if (!canonical || canonical === p) return;
            // Realign the sidecar map and any tab DOM whose data-path was
            // stamped from the pre-canonical input (e.g. `/var/…` vs
            // `/private/var/…` on macOS). Watcher updates use canonical, so
            // matching has to use canonical too.
            var changed = false;
            Object.keys(window.__bridgeTabPaths).forEach(function(id) {
              if (window.__bridgeTabPaths[id] === p) {
                window.__bridgeTabPaths[id] = canonical;
                changed = true;
                var el = document.querySelector('[data-tab-id="' + id + '"]');
                if (el) el.setAttribute('data-path', canonical);
              }
            });
            // Also update the persisted watched-paths list so the next
            // startup skips this realignment entirely.
            try {
              var arr = JSON.parse(localStorage.getItem('markdown-desk-watched-paths') || '[]');
              var idx = arr.indexOf(p);
              if (idx >= 0) {
                arr[idx] = canonical;
                localStorage.setItem('markdown-desk-watched-paths', JSON.stringify(arr));
              }
            } catch (_) {}
            if (changed) bridgeSaveTabPaths(window.__bridgeTabPaths);
          })
          .catch(function(e) {
            console.warn('[bridge] Failed to restore watcher:', p, e);
          });
      });
    }

    // Re-read the active tab's file from disk and push the latest content in.
    // Shared by tab-switch and window-refocus paths. refresh_active_tab is a
    // no-op when the on-disk content already matches the editor (the Rust side
    // skips paths outside the watched set, and js_update_tab bails when the
    // content is unchanged), so calling it speculatively is safe.
    function refreshActiveFromDisk() {
      if (!window.__TAURI_INTERNALS__) return;
      var activeEl = document.querySelector('#tab-list .tab-item.active');
      var path = activeEl ? activeEl.getAttribute('data-path') : '';
      if (path) {
        window.__TAURI_INTERNALS__.invoke('refresh_active_tab', { path: path });
      }
    }

    // Refresh active tab on tab switch. The .active class is set asynchronously
    // after the click, so let it settle before reading data-path.
    var tabList = document.getElementById('tab-list');
    var mobileTabList = document.getElementById('mobile-tab-list');
    function onTabClick() {
      setTimeout(refreshActiveFromDisk, 50);
    }
    if (tabList) { tabList.addEventListener('click', onTabClick); }
    if (mobileTabList) { mobileTabList.addEventListener('click', onTabClick); }

    // Re-sync when the window returns to the foreground. While Markdown Desk is
    // not frontmost, macOS App Nap can defer the WebView's preview-render timer,
    // and if the window is minimized/occluded WebKit pauses timers outright — so
    // a file edited elsewhere may not have rendered yet. Re-reading on
    // visibility/focus regain reflects it without requiring a tab switch.
    // (NSAppSleepDisabled in Info.plist keeps live updates flowing while the
    // window is merely visible-but-not-focused; this covers the hidden cases.)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshActiveFromDisk();
    });
    window.addEventListener('focus', refreshActiveFromDisk);

    // Fix mermaid zoom modal SVG sizing for WKWebView
    // WKWebView resolves SVG width:auto to 0 inside flex containers
    (function() {
      var modal = document.getElementById('mermaid-zoom-modal');
      var modalDiagram = document.getElementById('mermaid-modal-diagram');
      if (!modal || !modalDiagram) return;

      var observer = new MutationObserver(function() {
        if (!modal.classList.contains('active')) return;
        var svg = modalDiagram.querySelector('svg');
        if (!svg || svg.getAttribute('data-bridge-fixed')) return;
        svg.setAttribute('data-bridge-fixed', 'true');

        // Read intrinsic size from viewBox
        var vb = svg.getAttribute('viewBox');
        if (vb) {
          var parts = vb.split(/[\s,]+/);
          var vbW = parseFloat(parts[2]) || 500;
          var vbH = parseFloat(parts[3]) || 300;

          // Set explicit dimensions instead of 'auto' (WKWebView fix)
          // Calculate size to fit within 80vw x 60vh while preserving aspect ratio
          var maxW = window.innerWidth * 0.8;
          var maxH = window.innerHeight * 0.6;
          var scale = Math.min(maxW / vbW, maxH / vbH, 1);
          svg.style.width = (vbW * scale) + 'px';
          svg.style.height = (vbH * scale) + 'px';
          // Disable transition to prevent flicker during drag/pan
          svg.style.transition = 'none';
        }
      });
      observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
    })();

    // Override file-input click to use native dialog
    var fileInput = document.getElementById('file-input');
    if (fileInput) {
      fileInput.click = function() {
        if (window.__TAURI_INTERNALS__) {
          window.__TAURI_INTERNALS__.invoke('native_open_file');
        }
      };
    }
  });

  // --- Auto-update check ---
  var MODE_MANUAL = 'manual';         // menu "Check for Updates…" — confirm dialog, shows "latest" when none
  var MODE_BACKGROUND = 'background'; // periodic/startup check — in-app banner + title suffix, silent when none
  var UPDATE_SNOOZED_KEY = 'markdown-desk-update-snoozed-version';
  var UPDATE_LAST_CHECK_KEY = 'markdown-desk-update-last-check';
  var UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  var UPDATE_BANNER_CLASS = 'bridge-update-banner';
  var _updateChecking = false;
  var _pendingUpdate = null; // cached updater object so banner can install without re-checking

  window.checkForUpdates = function() { doCheckForUpdates(MODE_MANUAL); };

  async function doCheckForUpdates(mode) {
    if (_updateChecking) return;
    _updateChecking = true;
    try {
      if (!window.__TAURI__ || !window.__TAURI__.updater) {
        if (mode === MODE_MANUAL && window.__TAURI__ && window.__TAURI__.dialog) {
          await window.__TAURI__.dialog.message('Update check is not available.');
        }
        return;
      }
      var update = await window.__TAURI__.updater.check();
      try { localStorage.setItem(UPDATE_LAST_CHECK_KEY, String(Date.now())); } catch (e) {}
      if (update) {
        _pendingUpdate = update;
        // Unified alert path: both manual and background land on the status
        // bar. Background respects the snooze (so we don't repeatedly nag),
        // but a manual menu click bypasses snooze — the user explicitly
        // asked, and silently doing nothing would look like the check broke.
        // showUpdateBanner owns the full teardown→set sequence for the title
        // suffix so the set invoke always wins over any nested hide.
        var snoozed = localStorage.getItem(UPDATE_SNOOZED_KEY);
        if (mode === MODE_MANUAL || snoozed !== update.version) {
          showUpdateBanner(update.version);
        }
      } else if (mode === MODE_MANUAL) {
        if (window.__TAURI__.dialog) {
          await window.__TAURI__.dialog.message('You are using the latest version.', { title: 'Markdown Desk' });
        }
      }
    } catch (e) {
      console.log('[updater] Check failed:', e);
      if (mode === MODE_MANUAL && window.__TAURI__ && window.__TAURI__.dialog) {
        await window.__TAURI__.dialog.message('Failed to check for updates.', { title: 'Error' });
      }
    } finally {
      _updateChecking = false;
    }
  }

  async function runUpdateInstall(update, opts) {
    if (!window.__TAURI__ || !window.__TAURI__.dialog) return;
    opts = opts || {};
    if (!opts.skipConfirm) {
      var confirmed = await window.__TAURI__.dialog.confirm(
        'New version ' + update.version + ' is available. Update now?',
        { title: 'Update Available', kind: 'info' }
      );
      if (!confirmed) return;
    }
    try {
      await update.downloadAndInstall();
      // Install succeeded — the snooze key targeted the *old* version and
      // would be stale after relaunch. Clear it before we hand off to the
      // new binary so it never influences the freshly-started process.
      try { localStorage.removeItem(UPDATE_SNOOZED_KEY); } catch (e) {}
      _pendingUpdate = null;
      var doRestart = await window.__TAURI__.dialog.confirm(
        'Update installed. Restart now?',
        { title: 'Update Complete', kind: 'info' }
      );
      if (doRestart && window.__TAURI__.process) {
        var proc = window.__TAURI__.process;
        if (typeof proc.relaunch === 'function') {
          await proc.relaunch();
        } else if (typeof proc.restart === 'function') {
          await proc.restart();
        } else if (typeof proc.exit === 'function') {
          await proc.exit(0);
        }
      }
    } catch (dlErr) {
      console.log('[updater] Download failed:', dlErr);
      _pendingUpdate = null;
      if (window.__TAURI__ && window.__TAURI__.dialog) {
        await window.__TAURI__.dialog.message(
          'Update failed: ' + String(dlErr),
          { title: 'Update Error' }
        );
      }
    }
  }

  function setUpdateTitleSuffix(suffix) {
    if (!window.__TAURI_INTERNALS__) return;
    window.__TAURI_INTERNALS__.invoke('set_update_title_suffix', { suffix: suffix || '' })
      .catch(function(e) { console.warn('[updater] set_update_title_suffix failed:', e); });
  }

  // Slim bottom status-bar styles. Full accent fill keeps the cue clearly
  // visible (the prior top-fixed bar was too invasive vertically; a muted
  // bg would have been too easy to miss). Height target ~26-30px; the
  // e2e height guard pins ≤40 to block regressions to the old thick bar.
  var updateBannerStyle = document.createElement('style');
  updateBannerStyle.textContent =
    '.' + UPDATE_BANNER_CLASS + '{position:fixed;bottom:0;left:0;right:0;z-index:9998;display:flex;align-items:center;gap:10px;padding:4px 12px;background:var(--accent-color,#0969da);color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;line-height:1.4;box-shadow:0 -2px 6px rgba(0,0,0,.15);}' +
    '.' + UPDATE_BANNER_CLASS + '-msg{flex:1;}' +
    '.' + UPDATE_BANNER_CLASS + '-release-link{color:#fff;text-decoration:underline;cursor:pointer;}' +
    '.' + UPDATE_BANNER_CLASS + '-release-link:hover{opacity:.85;}' +
    '.' + UPDATE_BANNER_CLASS + ' button{padding:2px 10px;border:1px solid rgba(255,255,255,.55);border-radius:3px;background:transparent;color:#fff;font:inherit;cursor:pointer;}' +
    '.' + UPDATE_BANNER_CLASS + ' button:hover{background:rgba(255,255,255,.18);}' +
    '.' + UPDATE_BANNER_CLASS + '-update{background:#fff;color:var(--accent-color,#0969da);border-color:#fff;font-weight:600;}' +
    '.' + UPDATE_BANNER_CLASS + '-update:hover{background:rgba(255,255,255,.88);}' +
    '.' + UPDATE_BANNER_CLASS + '-close{padding:0 6px;font-size:16px;line-height:1;border:none;}';
  document.head.appendChild(updateBannerStyle);

  function showUpdateBanner(version) {
    // Same whitelist Rust applies at the IPC boundary — re-check on the JS
    // side so a malformed updater payload can never splice into the
    // "What's new" href (which the browser would follow verbatim outside
    // Tauri, e.g. dev server or e2e Playwright).
    //
    // Fail closed: if helpers aren't loaded (test harness, broken bundle)
    // we can't validate the token and must refuse to render rather than
    // splice an unchecked value into the DOM. Matches the posture of the
    // zoom (L914) and view-mode (L1045) entry points elsewhere in this file.
    var helpers = (typeof window !== 'undefined' && window.__bridgeHelpers) || null;
    if (!helpers || !helpers.buildReleaseUrl) {
      console.warn('[updater] showUpdateBanner: bridge helpers unavailable; refusing to render banner');
      return;
    }
    var releaseUrl = helpers.buildReleaseUrl(version);
    if (!releaseUrl) {
      console.warn('[updater] showUpdateBanner: rejecting unsafe version token:', version);
      return;
    }
    // Tear down any prior banner DOM *without* touching the title — a full
    // hide-dismiss here would clear the suffix we're about to set, and the
    // final Rust invoke would be the clear (C-1).
    removeBannerDom();
    setUpdateTitleSuffix(' — Update Available');

    var banner = document.createElement('div');
    banner.className = UPDATE_BANNER_CLASS;
    banner.setAttribute('data-version', version);

    var msg = document.createElement('span');
    msg.className = UPDATE_BANNER_CLASS + '-msg';
    msg.textContent = '⬆ New version ' + version + ' is available';

    // "What's new" link → GitHub release tag page. The href stays a real
    // URL (e2e asserts on it) but clicks are intercepted to route through
    // a Tauri command that opens the user's default browser. GitHub itself
    // serves a friendly "release not found" page if the tag hasn't fully
    // propagated, so we no longer probe before opening. The URL is built
    // via the helper above (already validated) so the format-string lives
    // in exactly one place.
    var releaseLink = document.createElement('a');
    releaseLink.className = UPDATE_BANNER_CLASS + '-release-link';
    releaseLink.href = releaseUrl;
    releaseLink.target = '_blank';
    releaseLink.rel = 'noopener noreferrer';
    releaseLink.textContent = "What's new";
    releaseLink.addEventListener('click', function(e) {
      if (window.__TAURI_INTERNALS__) {
        // Defense-in-depth: the Rust side re-validates on every IPC, but
        // re-checking here keeps the JS surface fail-closed too. Two
        // guards in one branch:
        //   1. `helpers.isSafeVersionToken` itself must exist — a future
        //      partial bundle where helpers loaded but the function got
        //      tree-shaken would TypeError on call, skipping
        //      `e.preventDefault()` and letting the anchor's href follow.
        //   2. The version must pass the whitelist.
        // preventDefault runs in both rejection paths so the click never
        // falls through to the browser-follow fallback.
        if (!helpers.isSafeVersionToken || !helpers.isSafeVersionToken(version)) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        window.__TAURI_INTERNALS__.invoke('open_release_page', { version: version })
          .catch(function(err) { console.warn('[updater] open_release_page failed:', err); });
      }
    });

    var updateBtn = document.createElement('button');
    updateBtn.type = 'button';
    updateBtn.className = UPDATE_BANNER_CLASS + '-update';
    updateBtn.textContent = 'Update';
    updateBtn.addEventListener('click', async function() {
      hideUpdateBanner();
      if (_pendingUpdate) {
        await runUpdateInstall(_pendingUpdate, { skipConfirm: true });
      }
    });

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = UPDATE_BANNER_CLASS + '-close';
    closeBtn.setAttribute('aria-label', 'Close update notice');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function() {
      try { localStorage.setItem(UPDATE_SNOOZED_KEY, version); } catch (e) {}
      _pendingUpdate = null;
      hideUpdateBanner();
    });

    banner.appendChild(msg);
    banner.appendChild(releaseLink);
    banner.appendChild(updateBtn);
    banner.appendChild(closeBtn);
    document.body.appendChild(banner);
  }

  // DOM-only teardown. Call this when you intend to follow it with another
  // banner render (e.g., showUpdateBanner replacing its own prior banner).
  function removeBannerDom() {
    var existing = document.querySelector('.' + UPDATE_BANNER_CLASS);
    if (existing) existing.remove();
  }

  // hideUpdateBanner is the full dismiss: DOM teardown + title suffix reset.
  // Any path that tears down the notice for good (Later, Update, install
  // cancel, install failure) goes through here and leaves the title clean.
  function hideUpdateBanner() {
    removeBannerDom();
    setUpdateTitleSuffix('');
  }

  // @dev-hook-start
  // SECURITY: This surface is stripped from release builds by
  // scripts/prepare-frontend.sh when TAURI_ENV_DEBUG != 'true'. Keep it
  // limited to banner DOM + snooze localStorage. Never add triggers that
  // install, relaunch, or invoke privileged Tauri commands here.
  window.__mdDeskUpdateInternals = {
    showBanner: showUpdateBanner,
    hideBanner: hideUpdateBanner,
    getSnoozedVersion: function() { return localStorage.getItem(UPDATE_SNOOZED_KEY); },
    clearSnooze: function() { localStorage.removeItem(UPDATE_SNOOZED_KEY); },
  };
  // @dev-hook-end

  function shouldRunBackgroundCheck() {
    return window.__bridgeHelpers.shouldRunBackgroundCheck(
      localStorage.getItem(UPDATE_LAST_CHECK_KEY),
      Date.now(),
      UPDATE_CHECK_INTERVAL_MS
    );
  }
  // --- Default app prompt (once per version; re-asks after update) ---
  var DEFAULT_APP_DISMISSED_KEY = 'markdown-desk-default-app-dismissed';
  async function promptDefaultApp() {
    if (!window.__TAURI__ || !window.__TAURI__.dialog || !window.__TAURI_INTERNALS__) return;
    try {
      var isDefault = await window.__TAURI_INTERNALS__.invoke('is_default_md_app');
      if (isDefault) return;
      // %%APP_VERSION%% is replaced with the actual version at build time
      // by scripts/prepare-frontend.sh (e.g. '26.4.1')
      var currentVersion = '%%APP_VERSION%%';
      if (currentVersion.indexOf('%%') === 0) return; // build-time injection failed
      var dismissedVersion = localStorage.getItem(DEFAULT_APP_DISMISSED_KEY);
      if (dismissedVersion === currentVersion) return;
      var confirmed = await window.__TAURI__.dialog.confirm(
        'Would you like to set Markdown Desk as the default app for Markdown files?',
        { title: 'Markdown Desk', kind: 'info' }
      );
      if (confirmed) {
        await window.__TAURI_INTERNALS__.invoke('set_default_md_app');
        localStorage.removeItem(DEFAULT_APP_DISMISSED_KEY);
      } else {
        localStorage.setItem(DEFAULT_APP_DISMISSED_KEY, currentVersion);
      }
    } catch (e) {
      console.error('[bridge] default app prompt failed:', e);
    }
  }

  // Auto-check on startup: default app prompt first, then update check.
  // Startup check is gated on the 24h window so reopening the app multiple
  // times a day doesn't re-hit the updater server.
  setTimeout(async function() {
    await promptDefaultApp();
    if (shouldRunBackgroundCheck()) {
      doCheckForUpdates(MODE_BACKGROUND);
    }
  }, 2000);

  // Periodic 24h background check while the app stays open.
  setInterval(function() {
    doCheckForUpdates(MODE_BACKGROUND);
  }, UPDATE_CHECK_INTERVAL_MS);

  // --- Hard reload: clear all state except global state and default-app dismissed ---
  var GLOBAL_STATE_KEY = 'markdownViewerGlobalState';
  function hardReload() {
    var globalState = localStorage.getItem(GLOBAL_STATE_KEY);
    var dismissed = localStorage.getItem(DEFAULT_APP_DISMISSED_KEY);
    localStorage.clear();
    if (globalState) localStorage.setItem(GLOBAL_STATE_KEY, globalState);
    if (dismissed) localStorage.setItem(DEFAULT_APP_DISMISSED_KEY, dismissed);
    // Markdown-Viewer 3.7.x (PERF-008) flushes its in-memory `tabs` array to
    // markdownViewerTabs on `beforeunload`. The reload below fires that flush,
    // which would write the just-cleared session straight back and defeat the
    // reset (the open documents would survive). Suppress writes to the two
    // tab-session keys for the remainder of this about-to-be-discarded page so
    // the reset actually clears the tabs. Scoped to those keys so the
    // globalState/dismissed restores above (and any other write) still persist;
    // the override dies with the page on reload.
    try {
      var origSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'markdownViewerTabs' || k === 'markdownViewerActiveTab') return;
        return origSetItem.call(this, k, v);
      };
    } catch (e) {}
    // Clearing localStorage above drops the JS watched-paths list, but the
    // Rust WatcherState lives in the process and outlives this reload — so
    // it would keep watching the just-reset files (JS↔Rust state divergence,
    // and FSEvents watches accumulating across Resets within one session).
    // Clear it via the same reset_watcher IPC the e2e isolation uses. invoke
    // posts the message synchronously, so the reload below can't race it;
    // reload regardless of resolve/reject so a failed IPC can't strand Reset.
    var reload = function () { window.location.reload(); };
    if (window.__TAURI_INTERNALS__) {
      window.__TAURI_INTERNALS__.invoke('reset_watcher').then(reload, reload);
    } else {
      reload();
    }
  }

  // --- Export overrides: use Tauri native save dialog instead of browser download ---
  if (window.__TAURI_INTERNALS__) {
    function getExportBaseName() {
      var activeEl = document.querySelector('#tab-list .tab-item.active .tab-title');
      return window.__bridgeHelpers.getExportBaseName(activeEl ? activeEl.textContent : null);
    }

    // Override FileSaver.js saveAs() for MD and HTML exports
    var _origSaveAs = window.saveAs;
    window.saveAs = function(blob, filename) {
      if (!window.__TAURI_INTERNALS__) {
        return _origSaveAs && _origSaveAs(blob, filename);
      }
      var baseName = getExportBaseName();
      var ext = (filename || '').split('.').pop() || 'md';
      var filterName = ext === 'html' ? 'HTML' : 'Markdown';
      var reader = new FileReader();
      reader.onload = function() {
        window.__TAURI_INTERNALS__.invoke('export_text_file', {
          defaultName: baseName + '.' + ext,
          content: reader.result,
          filterName: filterName,
          extensions: [ext]
        });
      };
      reader.onerror = function() {
        console.error('[bridge] Failed to read blob for export');
        if (_origSaveAs) _origSaveAs(blob, filename);
      };
      reader.readAsText(blob);
    };

    // Override jsPDF.save() for PDF export
    document.addEventListener('DOMContentLoaded', function() {
      var pollCount = 0;
      var waitForJsPDF = setInterval(function() {
        pollCount++;
        if (pollCount > 200) { // 10s timeout
          clearInterval(waitForJsPDF);
          console.warn('[bridge] jsPDF not found after 10s, PDF export will use browser default');
          return;
        }
        var jsPDFClass = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
        if (!jsPDFClass) return;
        clearInterval(waitForJsPDF);
        var _origPdfSave = jsPDFClass.prototype.save;
        jsPDFClass.prototype.save = function(filename) {
          if (!window.__TAURI_INTERNALS__) {
            return _origPdfSave.call(this, filename);
          }
          var baseName = getExportBaseName();
          var pdfBytes = this.output('arraybuffer');
          var uint8 = new Uint8Array(pdfBytes);
          window.__TAURI_INTERNALS__.invoke('export_binary_file', {
            defaultName: baseName + '.pdf',
            data: Array.from(uint8),
            filterName: 'PDF',
            extensions: ['pdf']
          });
        };
      }, 50);
    });
  }

  // --- Find in page (Cmd+F) ---
  (function() {
    var findBar = null;
    var findInput = null;
    var findCount = null;
    var matches = [];
    var currentIdx = -1;
    var HIGHLIGHT_CLASS = 'bridge-find-highlight';
    var ACTIVE_CLASS = 'bridge-find-active';

    // Inject CSS
    var style = document.createElement('style');
    style.textContent =
      '.bridge-find-bar{position:fixed;top:0;right:0;z-index:9999;display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg-color,#fff);border:1px solid var(--border-color,#ccc);border-top:none;border-radius:0 0 0 8px;box-shadow:0 2px 8px rgba(0,0,0,.15);font-size:13px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}' +
      '.bridge-find-bar input{width:200px;padding:4px 8px;border:1px solid var(--border-color,#ccc);border-radius:4px;outline:none;font-size:13px;background:var(--editor-bg,#fff);color:var(--text-color,#333);}' +
      '.bridge-find-bar input:focus{border-color:var(--accent-color,#0969da);}' +
      '.bridge-find-bar button{padding:4px 8px;border:1px solid var(--border-color,#ccc);border-radius:4px;background:var(--button-bg,#f0f0f0);color:var(--text-color,#333);cursor:pointer;font-size:12px;line-height:1;}' +
      '.bridge-find-bar button:hover{background:var(--border-color,#ddd);}' +
      '.bridge-find-bar .bridge-find-count{color:var(--text-color,#666);font-size:12px;min-width:60px;text-align:center;}' +
      '.' + HIGHLIGHT_CLASS + '{background:rgba(255,200,0,.4);border-radius:2px;}' +
      '.' + ACTIVE_CLASS + '{background:rgba(255,150,0,.6);border-radius:2px;outline:2px solid rgba(255,120,0,.8);}';
    document.head.appendChild(style);

    function createFindBar() {
      findBar = document.createElement('div');
      findBar.className = 'bridge-find-bar';

      findInput = document.createElement('input');
      findInput.type = 'text';
      findInput.placeholder = 'Find...';
      findInput.setAttribute('aria-label', 'Find in page');

      findCount = document.createElement('span');
      findCount.className = 'bridge-find-count';
      findCount.textContent = '';

      var btnPrev = document.createElement('button');
      btnPrev.textContent = '\u25B2';
      btnPrev.title = 'Previous (Shift+Enter)';
      btnPrev.setAttribute('aria-label', 'Previous match');
      btnPrev.addEventListener('click', function() { navigateMatch(-1); });

      var btnNext = document.createElement('button');
      btnNext.textContent = '\u25BC';
      btnNext.title = 'Next (Enter)';
      btnNext.setAttribute('aria-label', 'Next match');
      btnNext.addEventListener('click', function() { navigateMatch(1); });

      var btnClose = document.createElement('button');
      btnClose.textContent = '\u2715';
      btnClose.title = 'Close (Esc)';
      btnClose.setAttribute('aria-label', 'Close find bar');
      btnClose.addEventListener('click', function() { closeFindBar(); });

      findBar.appendChild(findInput);
      findBar.appendChild(findCount);
      findBar.appendChild(btnPrev);
      findBar.appendChild(btnNext);
      findBar.appendChild(btnClose);

      var searchTimer = null;
      findInput.addEventListener('input', function() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function() { doSearch(findInput.value); }, 150);
      });
      findInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          navigateMatch(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          closeFindBar();
        }
      });

      document.body.appendChild(findBar);
    }

    function openFindBar() {
      // Don't open find bar when mermaid modal is active
      var modal = document.getElementById('mermaid-zoom-modal');
      if (modal && modal.classList.contains('active')) return;
      if (!findBar) createFindBar();
      findBar.style.display = 'flex';
      findInput.focus();
      findInput.select();
    }

    function closeFindBar() {
      if (!findBar) return;
      findBar.style.display = 'none';
      clearHighlights();
      findInput.value = '';
      findCount.textContent = '';
      matches = [];
      currentIdx = -1;
    }

    function clearHighlights() {
      var preview = document.getElementById('markdown-preview');
      if (!preview) return;
      var marks = preview.querySelectorAll('.' + HIGHLIGHT_CLASS);
      for (var i = marks.length - 1; i >= 0; i--) {
        var mark = marks[i];
        var parent = mark.parentNode;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      }
    }

    function doSearch(query) {
      clearHighlights();
      matches = [];
      currentIdx = -1;

      if (!query) {
        findCount.textContent = '';
        return;
      }

      var preview = document.getElementById('markdown-preview');
      if (!preview) return;

      var walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, null, false);
      var textNodes = [];
      var node;
      while (node = walker.nextNode()) {
        if (node.nodeValue.trim()) textNodes.push(node);
      }

      var lowerQuery = query.toLowerCase();
      for (var i = 0; i < textNodes.length; i++) {
        var textNode = textNodes[i];
        var text = textNode.nodeValue;
        var lowerText = text.toLowerCase();
        var idx = 0;
        var parts = [];
        var lastEnd = 0;

        while ((idx = lowerText.indexOf(lowerQuery, idx)) !== -1) {
          if (idx > lastEnd) {
            parts.push({ text: text.substring(lastEnd, idx), match: false });
          }
          parts.push({ text: text.substring(idx, idx + query.length), match: true });
          lastEnd = idx + query.length;
          idx = lastEnd;
        }

        if (parts.length > 0) {
          if (lastEnd < text.length) {
            parts.push({ text: text.substring(lastEnd), match: false });
          }
          var frag = document.createDocumentFragment();
          for (var j = 0; j < parts.length; j++) {
            if (parts[j].match) {
              var span = document.createElement('span');
              span.className = HIGHLIGHT_CLASS;
              span.textContent = parts[j].text;
              matches.push(span);
              frag.appendChild(span);
            } else {
              frag.appendChild(document.createTextNode(parts[j].text));
            }
          }
          textNode.parentNode.replaceChild(frag, textNode);
        }
      }

      findCount.textContent = matches.length > 0 ? '0/' + matches.length : 'No results';
      if (matches.length > 0) {
        navigateMatch(1);
      }
    }

    function navigateMatch(direction) {
      if (matches.length === 0) return;

      // Stale DOM check: if highlights were removed (Live Reload, Mermaid re-render), re-search
      if (matches[0] && !document.contains(matches[0])) {
        doSearch(findInput.value);
        return;
      }

      if (currentIdx >= 0 && currentIdx < matches.length) {
        matches[currentIdx].className = HIGHLIGHT_CLASS;
      }

      currentIdx += direction;
      if (currentIdx >= matches.length) currentIdx = 0;
      if (currentIdx < 0) currentIdx = matches.length - 1;

      matches[currentIdx].className = HIGHLIGHT_CLASS + ' ' + ACTIVE_CLASS;
      matches[currentIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      findCount.textContent = (currentIdx + 1) + '/' + matches.length;
    }

    // Cmd+F → open find bar
    document.addEventListener('keydown', function(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        openFindBar();
      }
    }, true);

    // Esc → close find bar (global, for when focus is elsewhere)
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && findBar && findBar.style.display !== 'none') {
        closeFindBar();
      }
    });

    // Close find bar on tab switch or view mode change
    // Use event delegation on document since bridge.js runs before DOM is ready
    document.addEventListener('click', function(e) {
      if (!findBar || findBar.style.display === 'none') return;
      var target = e.target.closest('.tab-item, .view-toggle-btn, .mobile-view-mode-btn');
      if (target) closeFindBar();
    });
  })();

  // --- Keyboard shortcuts ---

  // Cmd+S → save to original file
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      e.stopPropagation();
      if (window.__TAURI_INTERNALS__) {
        var activeEl = document.querySelector('#tab-list .tab-item.active');
        var path = activeEl ? activeEl.getAttribute('data-path') : '';
        var editor = document.getElementById('markdown-editor');
        if (path && editor) {
          window.__TAURI_INTERNALS__.invoke('save_file', {
            path: path,
            content: editor.value
          });
        }
      }
    }
  }, true);

  // Cmd+O → native file dialog
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
      e.preventDefault();
      e.stopPropagation();
      if (window.__TAURI_INTERNALS__) {
        window.__TAURI_INTERNALS__.invoke('native_open_file');
      }
    }
  }, true);

  // Cmd+R / Cmd+Shift+R → hard reload
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
      e.preventDefault();
      e.stopPropagation();
      hardReload();
    }
  }, true);

  // Cmd+T → new tab, Cmd+W → close active tab.
  // Markdown-Viewer 3.7.3 gates these bindings behind `typeof Neutralino !==
  // 'undefined'` (upstream's own Neutralino desktop shell), so they are dead
  // in the Tauri WebView; only the web bindings (Alt+Shift+T/W) survive.
  // Stubbing a fake window.Neutralino would un-gate them, but script.js also
  // CALLS Neutralino APIs (os.showSaveDialog, filesystem.*) on other paths —
  // a bare stub trades dead shortcuts for runtime TypeErrors. Instead,
  // intercept Cmd+T/W and re-dispatch them as the web bindings the submodule
  // handles unconditionally. The synthetic event carries altKey, not meta,
  // so it cannot re-enter this handler. Pinned by lib.rs
  // cmd_t_and_w_forward_to_submodule_web_bindings and the upstream half in
  // tests/unit/submodule-contract.test.mjs.
  function bridgeForwardDesktopShortcut(key) {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: key,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    }));
  }
  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 't' || e.key === 'w')) {
      e.preventDefault();
      e.stopPropagation();
      bridgeForwardDesktopShortcut(e.key);
    }
  }, true);

  // ---- Webview zoom (Cmd/Ctrl +/-/0 and trackpad pinch / Ctrl+wheel) ----
  // Tauri WKWebView ships with browser-default zoom bindings disabled, so
  // we intercept the inputs and call core:webview:set-webview-zoom. The
  // helpers in scripts/bridge-helpers.js keep the math DOM-free; here we
  // only wire events and persist the level across reloads.
  (function() {
    var helpers = (typeof window !== 'undefined' && window.__bridgeHelpers) || null;
    if (!helpers || !helpers.nextZoomStep) return;

    var STORAGE_KEY = 'markdown-desk-webview-zoom';
    var currentZoom = 1.0;
    try {
      var stored = parseFloat(localStorage.getItem(STORAGE_KEY));
      currentZoom = helpers.clampZoom(stored, helpers.ZOOM_MIN, helpers.ZOOM_MAX);
    } catch (e) { /* localStorage may be unavailable in some sandboxes */ }

    // Test-only recorder for the set_webview_zoom IPC. Tauri 2 freezes
    // `__TAURI_INTERNALS__.invoke` as non-writable, so e2e cannot stub it;
    // instead applyZoom appends to this buffer alongside the real invoke,
    // and the dev-hook below exposes drain accessors. Stripped at release
    // build time by prepare-frontend.sh so production never allocates it.
    // @dev-hook-start
    var _zoomIpcLog = [];
    // @dev-hook-end

    function applyZoom(level) {
      var next = helpers.clampZoom(level, helpers.ZOOM_MIN, helpers.ZOOM_MAX);
      if (next === currentZoom) return;
      currentZoom = next;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch (e) {}
      if (window.__TAURI_INTERNALS__) {
        // @dev-hook-start
        _zoomIpcLog.push({ name: 'plugin:webview|set_webview_zoom', args: { value: next } });
        // @dev-hook-end
        // Surface invoke errors instead of silently dropping them — without
        // this, a regressed capability or removed plugin would leave
        // localStorage and the visible zoom level drifting apart with no log.
        window.__TAURI_INTERNALS__.invoke('plugin:webview|set_webview_zoom', { value: next })
          .catch(function(err) { console.warn('[zoom] set_webview_zoom failed:', err); });
      }
    }

    // Restore the persisted level once the IPC bridge is available. The
    // very first invoke after page load can lose if it races with Tauri's
    // bootstrap, so we defer one tick. Route through applyZoom so the
    // clamp + persist + IPC path stays single-sourced — temporarily reset
    // the in-memory mirror to 1.0 so applyZoom's early-return on equality
    // doesn't short-circuit the very first restore.
    setTimeout(function() {
      if (currentZoom !== 1.0 && window.__TAURI_INTERNALS__) {
        var target = currentZoom;
        currentZoom = 1.0;
        applyZoom(target);
      }
    }, 0);

    function handleZoomKey(e) {
      if (!(e.metaKey || e.ctrlKey)) return false;
      // `e.key` for Cmd+= is '=' on most layouts. Treat '+' the same so
      // Shift+Cmd+= (numpad +) also zooms in.
      if (e.key === '+' || e.key === '=') {
        e.preventDefault(); e.stopPropagation();
        applyZoom(helpers.nextZoomStep(currentZoom, +1));
        return true;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault(); e.stopPropagation();
        applyZoom(helpers.nextZoomStep(currentZoom, -1));
        return true;
      }
      if (e.key === '0') {
        e.preventDefault(); e.stopPropagation();
        applyZoom(1.0);
        return true;
      }
      return false;
    }

    // Trackpad pinch arrives as wheel with synthetic ctrlKey on macOS
    // WebKit. Real Ctrl/Cmd + wheel hits the same branch. Without
    // preventDefault the page also scrolls, which feels wrong.
    function handleZoomWheel(e) {
      if (!(e.ctrlKey || e.metaKey)) return false;
      e.preventDefault();
      applyZoom(helpers.nextZoomFromWheel(currentZoom, e.deltaY));
      return true;
    }

    document.addEventListener('keydown', handleZoomKey, true);
    window.addEventListener('wheel', handleZoomWheel, { passive: false, capture: true });

    // Release-included public entry point for the native View → Zoom menu.
    // Menu accelerators fire NSMenu first (the OS swallows the keydown so the
    // capture-phase listener above is never invoked from a menu accelerator),
    // so menu_event handlers in src-tauri/src/menu.rs eval one of these
    // functions to share the same applyZoom path — clamp + persist + IPC.
    window.__mdDeskZoomMenu = {
      in: function() { applyZoom(helpers.nextZoomStep(currentZoom, +1)); },
      out: function() { applyZoom(helpers.nextZoomStep(currentZoom, -1)); },
      reset: function() { applyZoom(1.0); },
    };

    // @dev-hook-start
    // Exposed in debug builds only (stripped by prepare-frontend.sh in
    // release). Synthetic KeyboardEvent dispatch does NOT reach this
    // module's capture-phase keydown listener in Tauri WKWebView — same
    // limitation noted in keyboard-shortcuts.spec.js — so e2e calls these
    // entry points directly to exercise the real branch + apply path.
    window.__mdDeskZoomInternals = {
      getZoom: function() { return currentZoom; },
      getStorageKey: function() { return STORAGE_KEY; },
      reset: function() {
        currentZoom = 1.0;
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      },
      pressKey: function(key, modifier) {
        // modifier ∈ 'meta' | 'ctrl' | 'none' — explicit so 'none' can
        // exercise the "no modifier → don't intercept" branch.
        var ev = {
          metaKey: modifier === 'meta',
          ctrlKey: modifier === 'ctrl',
          key: key,
          preventDefault: function() {},
          stopPropagation: function() {},
        };
        return handleZoomKey(ev);
      },
      scrollWheel: function(deltaY, modifier) {
        // modifier ∈ 'ctrl' (covers trackpad pinch on macOS WebKit, which
        // synthesizes ctrlKey) | 'meta' | 'none'.
        var ev = {
          ctrlKey: modifier === 'ctrl',
          metaKey: modifier === 'meta',
          deltaY: deltaY,
          preventDefault: function() {},
        };
        return handleZoomWheel(ev);
      },
      // Drain the recorded IPC log. Returns a copy and clears the buffer so
      // each test asserts only on the calls it triggered. Tauri 2 makes
      // `__TAURI_INTERNALS__.invoke` non-writable, so this seam replaces
      // direct stubbing as the regression guard for silent IPC drops.
      takeIpcLog: function() {
        var r = _zoomIpcLog.slice();
        _zoomIpcLog.length = 0;
        return r;
      },
    };
    // @dev-hook-end
  })();

  // ---- Remember last-used view mode and apply it to new tabs ----
  // Upstream Markdown-Viewer hard-codes every newly created tab to
  // 'split' (Markdown-Viewer/script.js: createTab default + every newTab
  // / reset / welcome callsite). Existing tabs keep their own viewMode,
  // so we only intervene on tabs the user has never seen before — tracked
  // by id-set diff against the rendered tab bar.
  (function() {
    var helpers = (typeof window !== 'undefined' && window.__bridgeHelpers) || null;
    if (!helpers || !helpers.pickInitialViewMode) return;

    var STORAGE_KEY = 'markdown-desk-last-view-mode';

    function readSavedMode() {
      try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
    }
    function writeSavedMode(mode) {
      try { localStorage.setItem(STORAGE_KEY, mode); } catch (_) {}
    }
    // Snapshot tab ids straight from the DOM rather than the
    // localStorage('markdownViewerTabs') sidecar. The host writes that
    // key synchronously today (Markdown-Viewer/script.js
    // saveTabsToStorage), so reading either source is correct, but the
    // DOM is what the MutationObserver below is firing on — so the
    // values are guaranteed in-sync with the callback's trigger. If a
    // future host edit deferred the localStorage write (setTimeout 0,
    // requestIdleCallback, …) the previous reader could have returned
    // a stale list and applyLastModeIfNeeded would miss the new tab.
    function readTabIds() {
      var ids = Object.create(null);
      var nodes = document.querySelectorAll('#tab-list .tab-item[data-tab-id]');
      for (var i = 0; i < nodes.length; i++) {
        var id = nodes[i].getAttribute('data-tab-id');
        if (id) ids[id] = 1;
      }
      return ids;
    }

    // Snapshot of tab ids already known to us. Initialized lazily on
    // first DOM ready so the first paint (which restores the active tab
    // with its own saved viewMode) is NOT overridden — last-mode applies
    // only to genuinely new tabs created during the session.
    var knownTabIds = null;

    document.addEventListener('click', function(e) {
      var t = e.target && e.target.closest
        ? e.target.closest('.view-toggle-btn, .mobile-view-mode-btn')
        : null;
      if (!t) return;
      var mode = t.getAttribute('data-view-mode') || t.getAttribute('data-mode');
      if (helpers.VIEW_MODES.indexOf(mode) < 0) return;
      writeSavedMode(mode);
    }, true);

    function consumeAddedTabIds() {
      var cur = readTabIds();
      if (knownTabIds === null) {
        knownTabIds = cur;
        return [];
      }
      var added = [];
      Object.keys(cur).forEach(function(id) {
        if (!knownTabIds[id]) added.push(id);
      });
      knownTabIds = cur;
      return added;
    }

    function applyLastModeIfNeeded() {
      var added = consumeAddedTabIds();
      if (!added.length) return;
      var saved = readSavedMode();
      var target = helpers.pickInitialViewMode(saved, 'split');
      if (target === 'split') return; // submodule default — nothing to do.

      // Only act when the active tab is one of the newly added ones —
      // otherwise switchTab on an existing tab is rehydrating that tab's
      // own preserved viewMode and we must not override it.
      var activeEl = document.querySelector('#tab-list .tab-item.active');
      var activeId = activeEl ? activeEl.getAttribute('data-tab-id') : null;
      if (!activeId || added.indexOf(activeId) < 0) return;

      // Synthesize a click on the matching desktop toggle. We avoid
      // calling setViewMode directly because it lives in the submodule
      // closure; the click path also runs saveCurrentTabState() so the
      // new tab's stored viewMode persists across switches.
      var btn = document.querySelector('.view-toggle-btn[data-view-mode="' + target + '"]');
      if (btn) {
        btn.click();
      } else {
        // 데스크탑 토글이 보이지 않는 분기(예: editor-only mobile, 셀렉터
        // rename 회귀)에서 silent no-op 가 되는 걸 가시화. 콘솔에만 남기고
        // 동작은 그대로(no-op) — 사용자 UX 영향 없음.
        console.warn('[bridge] last-view-mode skipped: .view-toggle-btn[data-view-mode="' + target + '"] not found');
      }
    }

    // Wait for the host to render the initial tab bar before snapshotting.
    document.addEventListener('DOMContentLoaded', function() {
      // Defer one task: initTabs runs on DOMContentLoaded and may render
      // after our handler (listener order isn't guaranteed across files).
      setTimeout(function() {
        knownTabIds = readTabIds();
      }, 0);

      var tabList = document.getElementById('tab-list');
      if (!tabList) return;
      var mo = new MutationObserver(function() {
        applyLastModeIfNeeded();
      });
      mo.observe(tabList, { childList: true, subtree: false });
    });

    // Expose for e2e — stripped in release.
    // @dev-hook-start
    window.__mdDeskViewModeInternals = {
      getSavedMode: readSavedMode,
      setSavedMode: writeSavedMode,
      clearSavedMode: function() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      },
      resetKnownTabs: function() { knownTabIds = readTabIds(); },
      forgetTab: function(id) { if (knownTabIds) delete knownTabIds[id]; },
      applyLastModeIfNeeded: applyLastModeIfNeeded,
    };
    // @dev-hook-end
  })();

  // --- Tab context menu (right-click) ---
  // Close Tab / Close Other Tabs / Close Tabs to the Right / Close Tabs to the Left
  // Reuses the existing per-tab 3-dot Delete action instead of manipulating the
  // closure-scoped `tabs` array in the untouched Markdown-Viewer submodule.
  (function() {
    var MENU_CLASS = 'bridge-tab-context-menu';
    var ITEM_CLASS = 'bridge-tab-context-item';
    var menuEl = null;

    var style = document.createElement('style');
    style.textContent =
      '.' + MENU_CLASS + '{position:fixed;z-index:10000;min-width:220px;padding:4px 0;background:var(--bg-color,#fff);border:1px solid var(--border-color,#ccc);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.18);font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;color:var(--text-color,#333);}' +
      '.' + ITEM_CLASS + '{display:block;width:100%;padding:6px 14px;border:none;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;}' +
      '.' + ITEM_CLASS + ':hover:not(:disabled){background:var(--accent-color,#0969da);color:#fff;}' +
      '.' + ITEM_CLASS + ':disabled{opacity:.4;cursor:default;}';
    document.head.appendChild(style);

    function closeMenu() {
      if (menuEl) {
        menuEl.remove();
        menuEl = null;
      }
    }

    function closeTabsByIds(listEl, ids) {
      // Upstream now appends the action dropdown to document.body (id prefix
      // `desktop-tab-menu-` / `mobile-tab-menu-`) instead of nesting it under
      // [data-tab-id], so a descendant selector on listEl no longer reaches the
      // delete button. Resolve the dropdown by its id and click delete there.
      var prefix = listEl && listEl.id === 'mobile-tab-list' ? 'mobile-tab-menu' : 'desktop-tab-menu';
      ids.forEach(function(id) {
        var dropdown = document.getElementById(prefix + '-' + id);
        var delBtn = dropdown && dropdown.querySelector('.tab-menu-item[data-action="delete"]');
        if (delBtn) delBtn.click();
      });
      // Drop closed tabs from the bridge sidecar map. The startup GC catches
      // any we miss here (e.g. tab closed via host UI we don't observe), but
      // doing it eagerly keeps localStorage compact during long sessions.
      if (window.__bridgeTabPaths) {
        var changed = false;
        ids.forEach(function(id) {
          if (window.__bridgeTabPaths[id]) {
            delete window.__bridgeTabPaths[id];
            changed = true;
          }
        });
        if (changed) bridgeSaveTabPaths(window.__bridgeTabPaths);
      }
    }

    function buildItem(label, ids, listEl) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = ITEM_CLASS;
      btn.textContent = label;
      if (!ids || ids.length === 0) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          closeMenu();
          closeTabsByIds(listEl, ids);
        });
      }
      return btn;
    }

    function showMenu(x, y, targetId, listEl) {
      closeMenu();

      var items = listEl.querySelectorAll('[data-tab-id]');
      var ids = Array.prototype.map.call(items, function(el) {
        return el.getAttribute('data-tab-id');
      });
      var idx = ids.indexOf(targetId);
      if (idx === -1) return;

      var leftIds = ids.slice(0, idx);
      var rightIds = ids.slice(idx + 1);
      var otherIds = ids.filter(function(id) { return id !== targetId; });

      menuEl = document.createElement('div');
      menuEl.className = MENU_CLASS;
      // Hide during measurement so the menu never paints at 0,0 before being
      // moved to the click coordinate near the viewport edge.
      menuEl.style.visibility = 'hidden';
      menuEl.appendChild(buildItem('Close Tab', [targetId], listEl));
      menuEl.appendChild(buildItem('Close Other Tabs', otherIds, listEl));
      menuEl.appendChild(buildItem('Close Tabs to the Right', rightIds, listEl));
      menuEl.appendChild(buildItem('Close Tabs to the Left', leftIds, listEl));
      document.body.appendChild(menuEl);

      // Keep within viewport
      var rect = menuEl.getBoundingClientRect();
      var px = x;
      var py = y;
      if (px + rect.width > window.innerWidth - 8) px = window.innerWidth - rect.width - 8;
      if (py + rect.height > window.innerHeight - 8) py = window.innerHeight - rect.height - 8;
      if (px < 8) px = 8;
      if (py < 8) py = 8;
      menuEl.style.left = px + 'px';
      menuEl.style.top = py + 'px';
      menuEl.style.visibility = 'visible';
    }

    function attach(listId) {
      var listEl = document.getElementById(listId);
      if (!listEl) return;
      listEl.addEventListener('contextmenu', function(e) {
        var tabEl = e.target.closest('.tab-item, .mobile-tab-item');
        if (!tabEl || !listEl.contains(tabEl)) return;
        var id = tabEl.getAttribute('data-tab-id');
        if (!id) return;
        e.preventDefault();
        showMenu(e.clientX, e.clientY, id, listEl);
      });
    }

    document.addEventListener('DOMContentLoaded', function() {
      attach('tab-list');
      attach('mobile-tab-list');
    });

    // Dismiss the menu. Outside clicks are caught on the capture phase of
    // mousedown so the menu closes before any downstream click handler runs.
    document.addEventListener('mousedown', function(e) {
      if (menuEl && !menuEl.contains(e.target)) closeMenu();
    }, true);
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && menuEl) closeMenu();
    });
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
  })();
})();
