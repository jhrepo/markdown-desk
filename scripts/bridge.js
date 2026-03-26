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

    // Restore file watcher on app restart
    var watchedPath = localStorage.getItem('markdown-desk-watched-path');
    if (watchedPath && window.__TAURI_INTERNALS__) {
      window.__TAURI_INTERNALS__.invoke('restore_watcher', { path: watchedPath });
    }

    // Refresh active tab with latest file content on tab switch
    var tabList = document.getElementById('tab-list');
    var mobileTabList = document.getElementById('mobile-tab-list');
    function onTabClick() {
      if (window.__TAURI_INTERNALS__) {
        setTimeout(function() {
          window.__TAURI_INTERNALS__.invoke('refresh_active_tab');
        }, 50);
      }
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
