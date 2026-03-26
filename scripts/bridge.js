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
