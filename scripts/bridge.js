// bridge.js — Tauri ↔ Web app bridge
// Injected into <head> via prepare-frontend.sh (runs before original scripts)
(function() {
  var THEME_KEY = 'markdown-desk-theme';

  // --- Theme persistence ---
  var savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme) {
    // Apply saved theme immediately (prevents flash)
    document.documentElement.setAttribute('data-theme', savedTheme);

    // Override matchMedia so the original script's prefers-color-scheme check
    // returns the saved preference instead of the system setting
    var originalMatchMedia = window.matchMedia;
    window.matchMedia = function(query) {
      if (query === '(prefers-color-scheme: dark)') {
        return {
          matches: savedTheme === 'dark',
          media: query,
          addEventListener: function() {},
          removeEventListener: function() {}
        };
      }
      return originalMatchMedia.call(window, query);
    };
  }

  document.addEventListener('DOMContentLoaded', function() {
    // Save theme when user clicks the toggle button
    var toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.addEventListener('click', function() {
        setTimeout(function() {
          var theme = document.documentElement.getAttribute('data-theme');
          localStorage.setItem(THEME_KEY, theme);
        }, 0);
      });
    }

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
          svg.style.width = vbW + 'px';
          svg.style.height = vbH + 'px';
          svg.style.maxWidth = '80vw';
          svg.style.maxHeight = '60vh';
          svg.style.aspectRatio = vbW + ' / ' + vbH;
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

  // --- Auto-update check (called on startup and from menu) ---
  // manual=true shows feedback even when no update is available
  window.checkForUpdates = function() { doCheckForUpdates(true); };
  var _updateChecking = false;
  async function doCheckForUpdates(manual) {
    if (_updateChecking) return;
    _updateChecking = true;
    try {
      if (!window.__TAURI__ || !window.__TAURI__.updater) {
        if (manual && window.__TAURI__ && window.__TAURI__.dialog) {
          await window.__TAURI__.dialog.message('Update check is not available.');
        }
        return;
      }
      var update = await window.__TAURI__.updater.check();
      if (update) {
        if (window.__TAURI__.dialog) {
          var confirmed = await window.__TAURI__.dialog.confirm(
            'New version ' + update.version + ' is available. Update now?',
            { title: 'Update Available', kind: 'info' }
          );
          if (confirmed) {
            try {
              await update.downloadAndInstall();
              // Ask user to restart
              if (window.__TAURI__.dialog) {
                var doRestart = await window.__TAURI__.dialog.confirm(
                  'Update installed. Restart now?',
                  { title: 'Update Complete', kind: 'info' }
                );
                if (doRestart && window.__TAURI__.process) {
                  // Try both API names
                  var proc = window.__TAURI__.process;
                  if (typeof proc.relaunch === 'function') {
                    await proc.relaunch();
                  } else if (typeof proc.restart === 'function') {
                    await proc.restart();
                  } else if (typeof proc.exit === 'function') {
                    await proc.exit(0);
                  }
                }
              }
            } catch (dlErr) {
              console.log('[updater] Download failed:', dlErr);
              if (window.__TAURI__ && window.__TAURI__.dialog) {
                await window.__TAURI__.dialog.message(
                  'Update failed: ' + String(dlErr),
                  { title: 'Update Error' }
                );
              }
            }
          }
        }
      } else if (manual) {
        if (window.__TAURI__.dialog) {
          await window.__TAURI__.dialog.message('You are using the latest version.', { title: 'Markdown Desk' });
        }
      }
    } catch (e) {
      console.log('[updater] Check failed:', e);
      if (manual && window.__TAURI__ && window.__TAURI__.dialog) {
        await window.__TAURI__.dialog.message('Failed to check for updates.', { title: 'Error' });
      }
    } finally {
      _updateChecking = false;
    }
  }
  // Auto-check on startup (silent, no feedback if up-to-date)
  setTimeout(function() { doCheckForUpdates(false); }, 3000);

  // --- Hard reload: clear all state except theme ---
  function hardReload() {
    var theme = localStorage.getItem(THEME_KEY);
    localStorage.clear();
    if (theme) {
      localStorage.setItem(THEME_KEY, theme);
    }
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
})();
