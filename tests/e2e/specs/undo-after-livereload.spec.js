import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTabSessionWriteFreeze } from '../helpers/session.js';

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
    }, content, file);
    // PERF-008 beforeunload tab-flush would clobber the seed on reload
    // (see helpers/session.js for the mechanism).
    await browser.execute(installTabSessionWriteFreeze);
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
    // so an undo entry exists for the live-reload edit. This pause CANNOT be
    // a waitUntil: the per-tab undo stack is closure-private inside the
    // submodule (no DOM/global reflects the commit), so there is nothing to
    // poll — the fixed margin over the 1000ms timeout is the only handle.
    await browser.pause(1300);

    const undoBtn = await $('[data-md-action="undo"]');
    expect(await undoBtn.isExisting()).toBe(true);

    await browser.execute(() => {
      const b = document.querySelector('[data-md-action="undo"]');
      if (b) b.click();
    });
    // Poll for the undo to land instead of a fixed settle: on a slow runner
    // a fixed pause could read the editor mid-transition and fail with a
    // misleading "behavior changed" diff. Timing out here states precisely
    // that undo never produced the expected pre-reload content.
    await browser.waitUntil(
      async () => {
        const v = await browser.execute(() =>
          document.getElementById('markdown-editor')?.value || '');
        return v.trim() === A.trim();
      },
      {
        timeout: 5000,
        timeoutMsg:
          'undo did not restore the pre-reload content (characterized behavior changed — see file header)',
      }
    );

    const afterUndo = await browser.execute(() =>
      document.getElementById('markdown-editor')?.value || '');

    // KNOWN LIMITATION (see file header): undo reverts to the pre-reload content.
    expect(afterUndo.trim()).toBe(A.trim());
  });
});
