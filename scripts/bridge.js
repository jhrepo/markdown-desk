// bridge.js — Tauri ↔ Web app bridge
// Injected into <head> via prepare-frontend.sh (runs before original scripts)
(function() {
  document.addEventListener('DOMContentLoaded', function() {
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
      try {
        var existing = JSON.parse(localStorage.getItem('markdown-desk-watched-paths') || '[]');
      } catch (e) { var existing = []; }
      if (existing.indexOf(oldPath) < 0) existing.push(oldPath);
      localStorage.setItem('markdown-desk-watched-paths', JSON.stringify(existing));
      localStorage.removeItem('markdown-desk-watched-path');
    }
    try {
      var watchedPaths = JSON.parse(localStorage.getItem('markdown-desk-watched-paths') || '[]');
    } catch (e) { var watchedPaths = []; }
    if (watchedPaths.length && window.__TAURI_INTERNALS__) {
      watchedPaths.forEach(function(p) {
        window.__TAURI_INTERNALS__.invoke('restore_watcher', { path: p }).catch(function(e) {
          console.warn('[bridge] Failed to restore watcher:', p, e);
        });
      });
    }

    // Refresh active tab on tab switch (reads latest file from disk)
    var tabList = document.getElementById('tab-list');
    var mobileTabList = document.getElementById('mobile-tab-list');
    function onTabClick() {
      if (!window.__TAURI_INTERNALS__) return;
      setTimeout(function() {
        var activeEl = document.querySelector('#tab-list .tab-item.active .tab-title');
        var title = activeEl ? activeEl.textContent.trim() : '';
        if (title) {
          window.__TAURI_INTERNALS__.invoke('refresh_active_tab', { title: title });
        }
      }, 50);
    }
    if (tabList) { tabList.addEventListener('click', onTabClick); }
    if (mobileTabList) { mobileTabList.addEventListener('click', onTabClick); }

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
        if (mode === MODE_MANUAL) {
          await runUpdateInstall(update, { skipConfirm: false });
        } else {
          var snoozed = localStorage.getItem(UPDATE_SNOOZED_KEY);
          if (snoozed !== update.version) {
            // showUpdateBanner owns the full teardown→set sequence for the
            // title suffix so the set invoke always wins over any nested
            // hide from "replace prior banner" logic.
            showUpdateBanner(update.version);
          }
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

  // Banner styles — injected once, theme-adaptive via existing CSS vars.
  var updateBannerStyle = document.createElement('style');
  updateBannerStyle.textContent =
    '.' + UPDATE_BANNER_CLASS + '{position:fixed;top:0;left:0;right:0;z-index:9998;display:flex;align-items:center;gap:10px;padding:8px 14px;background:var(--accent-color,#0969da);color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;box-shadow:0 2px 6px rgba(0,0,0,.15);}' +
    '.' + UPDATE_BANNER_CLASS + '-msg{flex:1;}' +
    '.' + UPDATE_BANNER_CLASS + ' button{padding:4px 12px;border:1px solid rgba(255,255,255,.55);border-radius:4px;background:transparent;color:#fff;font:inherit;cursor:pointer;}' +
    '.' + UPDATE_BANNER_CLASS + ' button:hover{background:rgba(255,255,255,.18);}' +
    '.' + UPDATE_BANNER_CLASS + '-update{background:#fff;color:var(--accent-color,#0969da);border-color:#fff;font-weight:600;}' +
    '.' + UPDATE_BANNER_CLASS + '-update:hover{background:rgba(255,255,255,.88);}';
  document.head.appendChild(updateBannerStyle);

  function showUpdateBanner(version) {
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

    var laterBtn = document.createElement('button');
    laterBtn.type = 'button';
    laterBtn.className = UPDATE_BANNER_CLASS + '-later';
    laterBtn.textContent = 'Later';
    laterBtn.addEventListener('click', function() {
      try { localStorage.setItem(UPDATE_SNOOZED_KEY, version); } catch (e) {}
      _pendingUpdate = null;
      hideUpdateBanner();
    });

    banner.appendChild(msg);
    banner.appendChild(updateBtn);
    banner.appendChild(laterBtn);
    document.body.insertBefore(banner, document.body.firstChild);
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
    var raw = localStorage.getItem(UPDATE_LAST_CHECK_KEY);
    if (!raw) return true;
    var last = parseInt(raw, 10);
    if (!isFinite(last) || last <= 0) return true;
    return (Date.now() - last) >= UPDATE_CHECK_INTERVAL_MS;
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
    window.location.reload();
  }

  // --- Export overrides: use Tauri native save dialog instead of browser download ---
  if (window.__TAURI_INTERNALS__) {
    function getExportBaseName() {
      var activeEl = document.querySelector('#tab-list .tab-item.active .tab-title');
      var name = activeEl ? activeEl.textContent.trim() : 'document';
      return name.replace(/\.md$/i, '') || 'document';
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
      var target = e.target.closest('.tab-item, .view-mode-btn, .mobile-view-mode-btn');
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
        var activeEl = document.querySelector('#tab-list .tab-item.active .tab-title');
        var title = activeEl ? activeEl.textContent.trim() : '';
        var editor = document.getElementById('markdown-editor');
        if (title && editor) {
          window.__TAURI_INTERNALS__.invoke('save_file', {
            title: title,
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
      // Snapshot-iterate: the tab bar re-renders after each delete, but the
      // remaining data-tab-id nodes still resolve to the new delete buttons.
      ids.forEach(function(id) {
        var sel = '[data-tab-id="' + CSS.escape(id) + '"] .tab-menu-item[data-action="delete"]';
        var delBtn = listEl.querySelector(sel);
        if (delBtn) delBtn.click();
      });
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
