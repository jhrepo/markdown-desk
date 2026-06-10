import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTabSessionWriteFreeze } from '../helpers/session.js';

describe('키보드 단축키', () => {
  // Synthetic `document.dispatchEvent(new KeyboardEvent('keydown', …))` DOES
  // reach bridge.js's document-level capture listeners in the Tauri WebKit
  // runtime — the Cmd+R, Cmd+T/W and Cmd+S tests below all prove it. (An
  // earlier header here claimed the opposite; the actual historical failure
  // was the OBSERVATION side, not the dispatch: spying on
  // `window.__TAURI_INTERNALS__.invoke` is impossible because that object is
  // defined with non-writable descriptors, and a marker listener added from
  // the test never fired because bridge handlers stopPropagation() in the
  // capture phase before it.) So shortcut e2e here observes SIDE EFFECTS
  // instead of the event itself: post-reload localStorage state (Cmd+R),
  // tab count (Cmd+T/W), and on-disk file content (Cmd+S). Cmd+O remains
  // Rust-grep-only — its side effect is a native open dialog, which
  // webdriver cannot observe or dismiss.

  it('Cmd+R 는 hardReload 를 수행해 ephemeral 키는 지우고 global state 는 유지한다', async () => {
    // This test reloads the page mid-spec. Snapshot the real globalState,
    // add a unique test marker, and restore in finally — keeps
    // theme-dependent specs (theme.spec.js, etc.) clean.
    const preGlobal = await browser.execute(() =>
      localStorage.getItem('markdownViewerGlobalState')
    );

    await browser.execute((originalGlobal) => {
      localStorage.setItem('sc-test-ephemeral', 'should-go');
      const state = originalGlobal ? JSON.parse(originalGlobal) : {};
      state.__scTestMarker = 'keep-me';
      localStorage.setItem('markdownViewerGlobalState', JSON.stringify(state));
    }, preGlobal);

    try {
      await browser.execute(() => {
        const ev = new KeyboardEvent('keydown', {
          key: 'r',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(ev);
      });
      // window.location.reload() kicks in; wait for the page to come back.
      await browser.pause(1500);

      const post = await browser.execute(() => ({
        ephemeral: localStorage.getItem('sc-test-ephemeral'),
        marker: JSON.parse(
          localStorage.getItem('markdownViewerGlobalState') || '{}'
        ).__scTestMarker,
      }));
      expect(post.ephemeral).toBe(null);
      expect(post.marker).toBe('keep-me');
    } finally {
      await browser.execute((originalGlobal) => {
        if (originalGlobal !== null) {
          localStorage.setItem('markdownViewerGlobalState', originalGlobal);
        } else {
          localStorage.removeItem('markdownViewerGlobalState');
        }
        localStorage.removeItem('sc-test-ephemeral');
      }, preGlobal);
    }
  });

  it('Cmd+T 는 새 탭을 열고 Cmd+W 는 그 탭을 닫는다 (Neutralino 게이트 우회 셰임)', async () => {
    // Markdown-Viewer 3.7.3 gates Ctrl/Cmd+T/W behind `typeof Neutralino`
    // (upstream's desktop shell) — dead in the Tauri WebView. bridge.js
    // intercepts Cmd+T/W and re-dispatches the ungated web bindings
    // (Alt+Shift+T/W). This asserts the full path end-to-end via the
    // observable side effect: the tab count. Net tab count is zero after
    // the test (Cmd+W closes the tab Cmd+T opened), so it leaves no state.
    const tabCount = () =>
      browser.execute(
        () => document.querySelectorAll('#tab-list .tab-item').length
      );
    const before = await tabCount();

    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 't',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await browser.waitUntil(async () => (await tabCount()) === before + 1, {
      timeout: 5000,
      timeoutMsg:
        'Cmd+T did not open a new tab — the bridge.js Neutralino-gate shim is broken',
    });

    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'w',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await browser.waitUntil(async () => (await tabCount()) === before, {
      timeout: 5000,
      timeoutMsg:
        'Cmd+W did not close the active tab — the bridge.js Neutralino-gate shim is broken',
    });
  });

  it('Caps Lock 상태(대문자 e.key)에서도 Cmd+T/W 가 동작한다', async () => {
    // With Caps Lock on, keydown reports e.key 'T'/'W' with shiftKey FALSE.
    // The shim's original exact === 't' match silently ignored that, so the
    // shortcuts died only-with-Caps-Lock — the nastiest kind of bug report.
    // Pin the lowercase normalization with uppercase-key synthetic events.
    const tabCount = () =>
      browser.execute(
        () => document.querySelectorAll('#tab-list .tab-item').length
      );
    const before = await tabCount();

    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'T',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await browser.waitUntil(async () => (await tabCount()) === before + 1, {
      timeout: 5000,
      timeoutMsg: 'Cmd+T with Caps Lock (key "T") did not open a new tab',
    });

    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'W',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await browser.waitUntil(async () => (await tabCount()) === before, {
      timeout: 5000,
      timeoutMsg: 'Cmd+W with Caps Lock (key "W") did not close the tab',
    });
  });

  it('Cmd+S 는 활성 탭의 편집 내용을 원본 파일에 저장한다', async () => {
    // Promoted from Rust-grep-only coverage: the side effect (file content
    // on disk) is observable from Node, so the full chain — capture listener
    // → data-path lookup → save_file IPC → fs write — is provable end-to-end.
    // Seeds a real file-bound tab the same way the auto-refresh specs do.
    // NOTE: this seeds+reloads the session, so it must stay the LAST test in
    // this file.
    const dir = mkdtempSync(join(tmpdir(), 'md-desk-cmds-'));
    const raw = join(dir, 'save-target.md');
    writeFileSync(raw, '# before save\n');
    // realpath is load-bearing: macOS tmpdir lives behind a /var → /private/var
    // symlink, and save_file resolves its target by EXACT string match against
    // the watched-set keys, which restore_watcher stores canonicalized. A
    // non-canonical seed silently fails the lookup ("Path not in watched set")
    // and Cmd+S becomes a no-op. Same convention as every other seeding spec.
    const file = realpathSync(raw);

    await browser.execute((path) => {
      const tab = {
        id: 'tab_cmds_' + Math.random().toString(36).slice(2, 8),
        title: 'save-target.md',
        content: '# before save\n',
        scrollPos: 0,
        viewMode: 'split',
        createdAt: Date.now(),
      };
      localStorage.setItem('markdownViewerTabs', JSON.stringify([tab]));
      localStorage.setItem('markdownViewerActiveTab', tab.id);
      localStorage.setItem('markdown-desk-watched-paths', JSON.stringify([path]));
      const m = {};
      m[tab.id] = path;
      localStorage.setItem('bridge-tab-paths', JSON.stringify(m));
    }, file);
    await browser.execute(installTabSessionWriteFreeze);
    await browser.execute(() => window.location.reload());

    // Proceed only once the bridge has stamped data-path on the active tab —
    // that attribute is exactly what the Cmd+S handler reads as save target.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const el = document.querySelector('#tab-list .tab-item.active');
          return !!(el && el.getAttribute('data-path'));
        }),
      { timeout: 8000, timeoutMsg: 'active tab never got data-path after seed+reload' }
    );

    const marker = 'SAVED_BY_CMD_S_' + Date.now();
    await browser.execute((text) => {
      const ed = document.getElementById('markdown-editor');
      ed.value = '# ' + text + '\n';
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 's',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    }, marker);

    await browser.waitUntil(() => readFileSync(file, 'utf8').includes(marker), {
      timeout: 5000,
      timeoutMsg:
        'Cmd+S did not persist the editor content to the original file (save_file chain broken)',
    });

    // Caps Lock shape (key 'S', shiftKey false): the worst member of the
    // exact-match bug family — save silently no-ops while the user believes
    // the file was written. Reuses the seeded tab from above.
    const capsMarker = 'SAVED_BY_CAPS_CMD_S_' + Date.now();
    await browser.execute((text) => {
      const ed = document.getElementById('markdown-editor');
      ed.value = '# ' + text + '\n';
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'S',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    }, capsMarker);

    await browser.waitUntil(() => readFileSync(file, 'utf8').includes(capsMarker), {
      timeout: 5000,
      timeoutMsg:
        'Cmd+S with Caps Lock (key "S") did not save — exact-match key check regressed',
    });
  });
});
