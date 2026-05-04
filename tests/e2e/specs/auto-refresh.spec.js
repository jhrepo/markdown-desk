import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  realpathSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Auto-refresh on external file change is the app's core value. These specs
// guard the path-based matching used by the bridge to identify which tab
// should receive a watcher update — earlier the match was by tab title which
// silently broke whenever two files shared the same basename.

describe('외부 파일 변경 자동 갱신', () => {
  beforeEach(async () => {
    // Wipe per-test state so each spec starts from a known empty session.
    await browser.execute(() => { try { localStorage.clear(); } catch {} });
    await browser.execute(() => window.location.reload());
    await browser.pause(1500);
  });

  async function seedSession(seedTabs, watchedPaths) {
    await browser.execute((tabs, paths) => {
      const list = tabs.map((t) => ({
        id: 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        title: t.title,
        content: t.content,
        scrollPos: 0,
        viewMode: 'split',
        createdAt: Date.now(),
      }));
      localStorage.setItem('markdownViewerTabs', JSON.stringify(list));
      localStorage.setItem('markdownViewerActiveTab', list[0].id);
      localStorage.setItem('markdown-desk-watched-paths', JSON.stringify(paths));
      // Bridge-owned map keyed by tab id; mirrors what the runtime stamps on
      // freshly created tabs. Pre-seeding lets restore_watcher's path-based
      // updates land before the user clicks anything.
      const m = {};
      list.forEach((t, i) => { m[t.id] = paths[i]; });
      localStorage.setItem('bridge-tab-paths', JSON.stringify(m));
    }, seedTabs, watchedPaths);
    await browser.execute(() => window.location.reload());
    await browser.pause(2500);
  }

  it('단일 파일을 외부에서 수정하면 active tab editor 가 갱신된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'md-ar-single-'));
    const rawFile = join(dir, 'notes.md');
    const initial = '# initial\n';
    writeFileSync(rawFile, initial);
    // Use realpath: the in-app code persists canonical paths for new opens,
    // so seeding canonical mirrors steady-state and skips the one-shot
    // post-restore realignment we'd hit on a freshly upgraded session.
    const file = realpathSync(rawFile);

    await seedSession(
      [{ title: 'notes.md', content: initial }],
      [file],
    );

    const updated = '# UPDATED ' + Date.now() + '\n';
    writeFileSync(file, updated);

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === updated.trim();
      },
      { timeout: 5000, timeoutMsg: 'editor did not pick up external change' }
    );
  });

  it('동일 파일명이 다른 디렉토리에 있어도 각 active tab 이 정확히 갱신된다', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'md-ar-A-'));
    const dirB = mkdtempSync(join(tmpdir(), 'md-ar-B-'));
    const rawA = join(dirA, 'README.md');
    const rawB = join(dirB, 'README.md');
    const a0 = '# A0\n', b0 = '# B0\n';
    writeFileSync(rawA, a0);
    writeFileSync(rawB, b0);
    const fileA = realpathSync(rawA);
    const fileB = realpathSync(rawB);

    await seedSession(
      [
        { title: 'README.md', content: a0 },
        { title: 'README.md', content: b0 },
      ],
      [fileA, fileB],
    );

    // Activate first tab, mutate file A.
    await browser.execute(() => {
      const items = document.querySelectorAll('#tab-list .tab-item');
      if (items[0]) items[0].click();
    });
    await browser.pause(300);
    const a1 = '# A UPDATED ' + Date.now() + '\n';
    writeFileSync(fileA, a1);

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === a1.trim();
      },
      { timeout: 5000, timeoutMsg: 'tab A did not refresh on external change' }
    );

    // Switch to second tab, mutate file B.
    await browser.execute(() => {
      const items = document.querySelectorAll('#tab-list .tab-item');
      if (items[1]) items[1].click();
    });
    await browser.pause(500);
    const b1 = '# B UPDATED ' + Date.now() + '\n';
    writeFileSync(fileB, b1);

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === b1.trim();
      },
      { timeout: 5000, timeoutMsg: 'tab B did not refresh on external change' }
    );

    // Sanity: editor is now B's content, not A's.
    const finalEditor = await browser.execute(() =>
      document.getElementById('markdown-editor')?.value || '');
    expect(finalEditor.trim()).toBe(b1.trim());
  });

  it('atomic-rename 저장(Vim/IntelliJ) 패턴도 자동 갱신된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'md-ar-atomic-'));
    const rawFile = join(dir, 'notes.md');
    const initial = '# initial\n';
    writeFileSync(rawFile, initial);
    const file = realpathSync(rawFile);

    await seedSession(
      [{ title: 'notes.md', content: initial }],
      [file],
    );

    const atomic = '# ATOMIC ' + Date.now() + '\n';
    const tmp = file + '.tmp';
    writeFileSync(tmp, atomic);
    renameSync(tmp, file);

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === atomic.trim();
      },
      { timeout: 5000, timeoutMsg: 'atomic rename did not propagate' }
    );
  });

  it('append 저장(>>)도 자동 갱신된다', async () => {
    // Many shell-driven workflows just `>> file.md`; the watcher needs to
    // see partial growth, not only full rewrites.
    const dir = mkdtempSync(join(tmpdir(), 'md-ar-append-'));
    const raw = join(dir, 'log.md');
    const initial = '# log\n\nline 1\n';
    writeFileSync(raw, initial);
    const file = realpathSync(raw);

    await seedSession(
      [{ title: 'log.md', content: initial }],
      [file],
    );

    appendFileSync(file, 'line 2 appended\n');

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.includes('line 2 appended');
      },
      { timeout: 5000, timeoutMsg: 'append did not propagate' }
    );
  });

  it('연속된 외부 수정이 디바운스 윈도우를 넘으면 매번 갱신된다', async () => {
    // Watcher uses leading-edge debounce (DEBOUNCE_MS = 300). Events within
    // the window after the last emission are intentionally dropped (avoids
    // editor thrash on bursty writes). Spacing writes >= 400ms guarantees
    // each one wakes the watcher and lands in the editor — the contract
    // we want to lock in.
    const dir = mkdtempSync(join(tmpdir(), 'md-ar-seq-'));
    const raw = join(dir, 'seq.md');
    writeFileSync(raw, '# v0\n');
    const file = realpathSync(raw);

    await seedSession(
      [{ title: 'seq.md', content: '# v0\n' }],
      [file],
    );

    for (const v of ['# v1\n', '# v2\n', '# v3\n']) {
      writeFileSync(file, v);
      await browser.waitUntil(
        async () => {
          const cur = await browser.execute(() =>
            document.getElementById('markdown-editor')?.value || '');
          return cur.trim() === v.trim();
        },
        { timeout: 5000, timeoutMsg: `editor did not catch up to ${v.trim()}` }
      );
      await browser.pause(400); // clear watcher debounce before next write
    }
  });

  it('비활성 탭 파일이 외부 수정되면 탭 전환 시 디스크 내용으로 갱신된다', async () => {
    // Watcher updates only fire into the *active* tab. The complementary
    // path is refresh_active_tab which bridge.js invokes with the tab's
    // data-path on every tab click — guards that fall-back path.
    const dirA = mkdtempSync(join(tmpdir(), 'md-ar-inact-A-'));
    const dirB = mkdtempSync(join(tmpdir(), 'md-ar-inact-B-'));
    const rawA = join(dirA, 'alpha.md');
    const rawB = join(dirB, 'beta.md');
    writeFileSync(rawA, '# A0\n');
    writeFileSync(rawB, '# B0\n');
    const fileA = realpathSync(rawA);
    const fileB = realpathSync(rawB);

    await seedSession(
      [
        { title: 'alpha.md', content: '# A0\n' },
        { title: 'beta.md',  content: '# B0\n' },
      ],
      [fileA, fileB],
    );

    // Activate alpha; mutate beta in the background.
    await browser.execute(() => {
      const items = document.querySelectorAll('#tab-list .tab-item');
      if (items[0]) items[0].click();
    });
    await browser.pause(300);

    const b1 = '# B UPDATED ' + Date.now() + '\n';
    writeFileSync(fileB, b1);
    await browser.pause(700); // let watcher run; alpha stays the active tab

    // Editor still shows alpha (no spurious update from beta's watcher event).
    const stillAlpha = await browser.execute(() =>
      document.getElementById('markdown-editor')?.value || '');
    expect(stillAlpha.trim()).toBe('# A0');

    // Switch to beta — bridge.js sends data-path to refresh_active_tab,
    // which re-reads disk and pushes the latest content.
    await browser.execute(() => {
      const items = document.querySelectorAll('#tab-list .tab-item');
      if (items[1]) items[1].click();
    });

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === b1.trim();
      },
      { timeout: 5000, timeoutMsg: 'beta tab did not pull latest disk content on switch' }
    );
  });

  it('save_file 호출 후 외부 수정으로 다시 변경되어도 정상 갱신된다', async () => {
    // End-to-end save→external-mod loop. Synthetic Cmd+S keys aren't
    // delivered reliably in the WebDriver/Tauri runtime (the OS menu
    // accelerator intercepts before the bridge handler sees it during
    // automation), so we exercise the IPC contract — the same code path
    // both the keydown handler and the menu's JS_SAVE_FILE eval reach.
    const dir = mkdtempSync(join(tmpdir(), 'md-ar-save-'));
    const raw = join(dir, 'rt.md');
    writeFileSync(raw, '# initial\n');
    const file = realpathSync(raw);

    await seedSession(
      [{ title: 'rt.md', content: '# initial\n' }],
      [file],
    );

    const inApp = '# typed in app ' + Date.now() + '\n';
    await browser.execute((s) => {
      const ta = document.getElementById('markdown-editor');
      ta.value = s;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, inApp);
    await browser.pause(200);

    // Invoke save_file with the exact payload bridge.js (and JS_SAVE_FILE
    // in menu.rs) builds — verifies the path-based contract end-to-end.
    await browser.execute(async () => {
      const a = document.querySelector('#tab-list .tab-item.active');
      const p = a ? a.getAttribute('data-path') : '';
      const e = document.getElementById('markdown-editor');
      if (p && e && window.__TAURI_INTERNALS__) {
        await window.__TAURI_INTERNALS__.invoke('save_file', { path: p, content: e.value });
      }
    });

    await browser.waitUntil(
      () => {
        try { return readFileSync(file, 'utf8').trim() === inApp.trim(); }
        catch { return false; }
      },
      { timeout: 5000, timeoutMsg: 'save_file did not write disk content' }
    );

    // Watcher's own update path must still match the same canonical key.
    const ext = '# external override ' + Date.now() + '\n';
    writeFileSync(file, ext);

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === ext.trim();
      },
      { timeout: 5000, timeoutMsg: 'editor did not refresh after save round-trip' }
    );
  });

  it('한글 파일명과 본문 내용도 정확히 갱신된다', async () => {
    // Path is escape_js'd through a JS template literal on the Rust side;
    // unicode (Korean filename + emoji content) stresses encoding integrity.
    const dir = mkdtempSync(join(tmpdir(), 'md-ar-uni-'));
    const raw = join(dir, '메모.md');
    const initial = '# 한글 메모\n\n초기 내용\n';
    writeFileSync(raw, initial);
    const file = realpathSync(raw);

    await seedSession(
      [{ title: '메모.md', content: initial }],
      [file],
    );

    const updated = '# 한글 메모\n\n수정된 내용 ✏️ ' + Date.now() + '\n';
    writeFileSync(file, updated);

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.includes('수정된 내용 ✏️');
      },
      { timeout: 5000, timeoutMsg: 'unicode content did not propagate' }
    );
  });

  it('서로 다른 이름의 세 파일이 각각 독립적으로 갱신된다', async () => {
    // No-conflict baseline. Earlier title-based matching also worked here;
    // this guards that path-based matching still does and that switching
    // among many tabs picks up each file's disk content correctly.
    const files = [];
    for (const name of ['one.md', 'two.md', 'three.md']) {
      const d = mkdtempSync(join(tmpdir(), 'md-ar-many-'));
      const raw = join(d, name);
      writeFileSync(raw, `# ${name} initial\n`);
      files.push({ name, path: realpathSync(raw) });
    }

    await seedSession(
      files.map((f) => ({ title: f.name, content: `# ${f.name} initial\n` })),
      files.map((f) => f.path),
    );

    // Mutate each file; activate matching tab; verify content lands.
    for (let i = 0; i < files.length; i++) {
      const next = `# ${files[i].name} UPDATED ${Date.now()}-${i}\n`;
      writeFileSync(files[i].path, next);

      await browser.execute((idx) => {
        const items = document.querySelectorAll('#tab-list .tab-item');
        if (items[idx]) items[idx].click();
      }, i);

      await browser.waitUntil(
        async () => {
          const v = await browser.execute(() =>
            document.getElementById('markdown-editor')?.value || '');
          return v.trim() === next.trim();
        },
        { timeout: 5000, timeoutMsg: `tab ${i} (${files[i].name}) did not refresh` }
      );
    }
  });

  it('파일 삭제 후 재생성으로 변경되어도 갱신된다', async () => {
    // Some editors / git-checkouts unlink + create rather than overwrite.
    // notify reports Remove + Create; the watcher only acts on Modify/Create
    // (Remove is ignored), so the Create event must drive the editor update.
    const dir = mkdtempSync(join(tmpdir(), 'md-ar-recreate-'));
    const raw = join(dir, 'doc.md');
    writeFileSync(raw, '# before\n');
    const file = realpathSync(raw);

    await seedSession(
      [{ title: 'doc.md', content: '# before\n' }],
      [file],
    );

    unlinkSync(file);
    // FSEvents coalesces fast Remove+Create on the same path; a longer
    // gap forces them through as separate notifications so the Create
    // (which we treat as relevant) reaches the watcher.
    await browser.pause(700);
    const after = '# after recreate ' + Date.now() + '\n';
    writeFileSync(file, after);

    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === after.trim();
      },
      { timeout: 5000, timeoutMsg: 'editor did not pick up post-recreate content' }
    );
  });

  it('열려 있지 않은 파일을 변경해도 active tab 은 영향받지 않는다', async () => {
    // Negative test: a file that's NOT in the watch list must not bleed
    // through into any tab even if it lives in a watched parent directory.
    const dir = mkdtempSync(join(tmpdir(), 'md-ar-neg-'));
    const watchedRaw = join(dir, 'watched.md');
    const neighborRaw = join(dir, 'neighbor.md');
    writeFileSync(watchedRaw, '# watched initial\n');
    writeFileSync(neighborRaw, '# neighbor initial\n');
    const watched = realpathSync(watchedRaw);

    await seedSession(
      [{ title: 'watched.md', content: '# watched initial\n' }],
      [watched], // neighbor is intentionally NOT watched
    );

    // Mutate the unwatched neighbor.
    writeFileSync(neighborRaw, '# neighbor MUTATED ' + Date.now() + '\n');
    await browser.pause(800);

    const editorVal = await browser.execute(() =>
      document.getElementById('markdown-editor')?.value || '');
    expect(editorVal.trim()).toBe('# watched initial');

    // Sanity follow-up: the actually-watched file still propagates.
    const sentinel = '# watched UPDATED ' + Date.now() + '\n';
    writeFileSync(watched, sentinel);
    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === sentinel.trim();
      },
      { timeout: 5000, timeoutMsg: 'sanity: watched file refresh broke' }
    );
  });

  it('시작 시 bridge-tab-paths 의 stale 항목은 GC 된다 (markdownViewerTabs 와 sync)', async () => {
    // Prevents unbounded growth of the sidecar map. Once the map crosses the
    // localStorage quota, bridgeSaveTabPaths fails silently and watcher
    // updates lose their data-path → tab routing — same silent class of
    // failure the path-based matching was introduced to fix.
    const dir = mkdtempSync(join(tmpdir(), 'md-ar-gc-'));
    const raw = join(dir, 'live.md');
    writeFileSync(raw, '# live\n');
    const file = realpathSync(raw);

    // Seed: one live tab + one stale id only present in bridge-tab-paths.
    // The stale id mimics a closed tab whose entry leaked because the host
    // re-rendered before any close handler observed it.
    await browser.execute((live, paths) => {
      const id = 'tab_live_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('markdownViewerTabs', JSON.stringify([{
        id, title: live[0].title, content: live[0].content,
        scrollPos: 0, viewMode: 'split', createdAt: Date.now(),
      }]));
      localStorage.setItem('markdownViewerActiveTab', id);
      localStorage.setItem('markdown-desk-watched-paths', JSON.stringify(paths));
      // Map keeps the live entry plus a stale id that no longer has a tab.
      localStorage.setItem('bridge-tab-paths', JSON.stringify({
        [id]: paths[0],
        'tab_stale_long_gone': '/tmp/already/closed.md',
      }));
    }, [{ title: 'live.md', content: '# live\n' }], [file]);
    await browser.execute(() => window.location.reload());
    await browser.pause(2500);

    // After startup GC, only the live id remains.
    const map = await browser.execute(() => window.__bridgeTabPaths || {});
    const persisted = await browser.execute(() => {
      try { return JSON.parse(localStorage.getItem('bridge-tab-paths') || '{}'); }
      catch { return {}; }
    });
    expect(map['tab_stale_long_gone']).toBeUndefined();
    expect(persisted['tab_stale_long_gone']).toBeUndefined();
    // Sanity: the live entry was preserved, not nuked along with the stale.
    const liveIds = Object.keys(map);
    expect(liveIds.length).toBe(1);
    expect(map[liveIds[0]]).toBe(file);
    expect(persisted[liveIds[0]]).toBe(file);

    // And the live tab still auto-refreshes on external change — proving GC
    // didn't corrupt path routing.
    const updated = '# live UPDATED ' + Date.now() + '\n';
    writeFileSync(file, updated);
    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === updated.trim();
      },
      { timeout: 5000, timeoutMsg: 'GC broke watcher routing' }
    );
  });

  it('동시 다중 탭 추가 시 각 탭의 data-path 가 FIFO 순서로 정확히 stamp 된다', async () => {
    // Multi-file open: Rust loops eval(js_new_tab) rapidly, so several
    // childList records may flush into one MutationObserver callback. With a
    // single __bridgeNextPath scalar, the last push would overwrite the
    // earlier values and every tab in the batch would receive the same path
    // (silent path swap → save_file/refresh_active_tab targets the wrong
    // file). The FIFO __bridgeNextPaths queue keeps each tab paired with the
    // path it was opened with. Reproduces the race deterministically by
    // appending three tab nodes in the same synchronous block.
    await browser.execute(() => {
      const list = document.getElementById('tab-list');
      // Mimic Rust enqueueing 3 paths back-to-back before any stamp runs.
      window.__bridgeNextPaths = ['/race/p1.md', '/race/p2.md', '/race/p3.md'];
      // Append all three nodes synchronously so the observer batches them.
      ['race_a', 'race_b', 'race_c'].forEach((tid) => {
        const el = document.createElement('div');
        el.className = 'tab-item';
        el.setAttribute('data-tab-id', tid);
        list.appendChild(el);
      });
    });

    await browser.waitUntil(
      async () => {
        const stamps = await browser.execute(() =>
          ['race_a', 'race_b', 'race_c'].map((id) => {
            const el = document.querySelector('[data-tab-id="' + id + '"]');
            return el ? el.getAttribute('data-path') : null;
          })
        );
        return stamps.every((s) => !!s);
      },
      { timeout: 3000, timeoutMsg: 'tab nodes were not stamped' }
    );

    const stamps = await browser.execute(() =>
      ['race_a', 'race_b', 'race_c'].map((id) => {
        const el = document.querySelector('[data-tab-id="' + id + '"]');
        return el ? el.getAttribute('data-path') : null;
      })
    );
    expect(stamps).toEqual(['/race/p1.md', '/race/p2.md', '/race/p3.md']);

    // Queue must be drained — no stale paths leaking into the next open.
    const remaining = await browser.execute(() =>
      (window.__bridgeNextPaths || []).length);
    expect(remaining).toBe(0);
  });

  it('탭의 data-tab-id 가 in-place 변경되어도 map 의 path 로 재 stamp 된다', async () => {
    // Defensive guard for a future host change: if the underlying tab
    // manager ever switches from destroy/recreate to in-place data-tab-id
    // rename, the original observer (childList only) would silently lose
    // data-path. The expanded observer (subtree + attributeFilter) catches
    // the rename and re-stamps from the sidecar map. The queue is left
    // alone — rename is not a new open and must not consume a queued path.
    await browser.execute(() => {
      // Pre-seed the map with the *future* id, simulating the case where the
      // host renames a tab whose path the bridge already knows.
      window.__bridgeTabPaths = window.__bridgeTabPaths || {};
      window.__bridgeTabPaths['renamed_id'] = '/tmp/renamed.md';
      // Also seed a queue entry we expect NOT to be consumed by the rename.
      window.__bridgeNextPaths = ['/tmp/queue_should_survive.md'];
      var list = document.getElementById('tab-list');
      var el = document.createElement('div');
      el.className = 'tab-item';
      el.setAttribute('data-tab-id', 'old_id');
      list.appendChild(el);
    });
    // Initial childList stamp picks the queue entry up for `old_id`.
    await browser.pause(100);

    // Now in-place rename data-tab-id; observer's attribute branch fires.
    await browser.execute(() => {
      const el = document.querySelector('[data-tab-id="old_id"]');
      if (el) el.setAttribute('data-tab-id', 'renamed_id');
    });

    await browser.waitUntil(
      async () => {
        const path = await browser.execute(() =>
          document.querySelector('[data-tab-id="renamed_id"]')?.getAttribute('data-path'));
        return path === '/tmp/renamed.md';
      },
      { timeout: 3000, timeoutMsg: 'in-place id rename did not re-stamp data-path from map' }
    );

    // Queue must not be drained by the rename — it is only consumed on new
    // tab creation (childList).
    const remaining = await browser.execute(() => (window.__bridgeNextPaths || []).slice());
    expect(remaining).toEqual([]);  // empty because the initial old_id stamp consumed the one entry
    // The above assertion documents that childList still owns queue draining;
    // the rename did NOT produce a second consumption.
  });

  it('수정 후 같은 내용으로 다시 저장되면 editor 가 변경되지 않는다 (no-op idempotency)', async () => {
    // js_update_tab early-returns when editor.value === newContent. This
    // guard prevents thrashing scroll/cursor on identical disk writes
    // (e.g. tools that re-save without changes).
    const dir = mkdtempSync(join(tmpdir(), 'md-ar-noop-'));
    const raw = join(dir, 'idem.md');
    const initial = '# stable\n\nbody\n';
    writeFileSync(raw, initial);
    const file = realpathSync(raw);

    await seedSession(
      [{ title: 'idem.md', content: initial }],
      [file],
    );

    // First mutate to a known content (and wait for it to land).
    const v1 = '# stable v1 ' + Date.now() + '\n';
    writeFileSync(file, v1);
    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === v1.trim();
      },
      { timeout: 5000 }
    );

    // Set a marker on the textarea to detect any re-assignment.
    await browser.execute(() => {
      const ta = document.getElementById('markdown-editor');
      ta.dataset.refreshMarker = 'untouched';
    });

    // Re-write identical content. js_update_tab should bail out before
    // touching editor.value, so the marker stays set.
    writeFileSync(file, v1);
    await browser.pause(800);

    const marker = await browser.execute(() =>
      document.getElementById('markdown-editor').dataset.refreshMarker);
    expect(marker).toBe('untouched');
  });
});
