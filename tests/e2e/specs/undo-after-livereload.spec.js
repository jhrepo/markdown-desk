import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CHARACTERIZATION / TRIPWIRE — undo after a live reload.
//
// Markdown-Viewer 3.7.x added a custom per-tab undo/redo history
// (handleKeystrokeHistory + per-tab undoStack). Our live-reload sink
// (commands.rs js_update_tab) sets editor.value and dispatches a synthetic
// `input` event — which is REQUIRED to drive the submodule's debouncedRender so
// the preview updates. But that same `input` event also feeds the history:
// handleKeystrokeHistory captures the pre-reload value into pendingState and
// commits it after ~1s, so pressing Undo after an external edit reverts the
// editor to the STALE pre-reload content.
//
// We cannot suppress this from the bridge: the history's `lastPushedValue`
// baseline is private to the submodule's closure, and we still need the `input`
// event for rendering. So this spec PINS the current (suboptimal) behavior
// rather than asserting a fix:
//   - if a future submodule bump changes undo so it no longer clobbers the
//     live-reloaded content, this test fails → revisit (likely delete it and
//     drop the known-limitation note), AND
//   - it documents, executably, the exact UX a user hits today.
// See the submodule impact analysis (undo/redo history pollution) for context.

describe('라이브 리로드 후 undo (알려진 한계 — tripwire)', () => {
  beforeEach(async () => {
    await browser.execute(() => { try { localStorage.clear(); } catch {} });
    await browser.execute(() => window.location.reload());
    await browser.pause(1500);
  });

  async function seedSingle(file, content) {
    await browser.execute((c, path) => {
      const id = 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('markdownViewerTabs', JSON.stringify([{
        id, title: 'u.md', content: c, scrollPos: 0, viewMode: 'split', createdAt: Date.now(),
      }]));
      localStorage.setItem('markdownViewerActiveTab', id);
      localStorage.setItem('markdown-desk-watched-paths', JSON.stringify([path]));
      localStorage.setItem('bridge-tab-paths', JSON.stringify({ [id]: path }));
      // PERF-008 beforeunload tab-flush would clobber the seed on reload.
      const origSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'markdownViewerTabs' || k === 'markdownViewerActiveTab') return;
        return origSet.call(this, k, v);
      };
    }, content, file);
    await browser.execute(() => window.location.reload());
    await browser.pause(2500);
  }

  it('Undo 가 라이브 리로드된 내용을 리로드 전 내용으로 되돌린다 (현재 동작 고정)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'md-undo-'));
    const raw = join(dir, 'u.md');
    const A = '# AAA original content\n';
    writeFileSync(raw, A);
    const file = realpathSync(raw);

    await seedSingle(file, A);

    const B = '# BBB live-reloaded from disk ' + Date.now() + '\n';
    writeFileSync(file, B);
    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === B.trim();
      },
      { timeout: 5000, timeoutMsg: 'precondition: live reload did not land B' }
    );

    // Let the custom-history typing timeout (~1000ms) commit the pending state
    // so an undo entry exists for the live-reload edit.
    await browser.pause(1300);

    const undoBtn = await $('[data-md-action="undo"]');
    expect(await undoBtn.isExisting()).toBe(true);

    await browser.execute(() => {
      const b = document.querySelector('[data-md-action="undo"]');
      if (b) b.click();
    });
    await browser.pause(400);

    const afterUndo = await browser.execute(() =>
      document.getElementById('markdown-editor')?.value || '');

    // KNOWN LIMITATION (see file header): undo reverts to the pre-reload content.
    expect(afterUndo.trim()).toBe(A.trim());
  });
});
