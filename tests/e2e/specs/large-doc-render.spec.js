import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTabSessionWriteFreeze } from '../helpers/session.js';

// Large-document live reload + preview-worker pipeline (Markdown-Viewer 3.7.x).
//
// The submodule re-engineered preview rendering to offload large docs onto a
// Web Worker (preview-worker.js): for content >= PREVIEW_WORKER_THRESHOLD
// (50_000 chars) that is "segmented-safe", script.js renders in the worker and
// commits the result as `<section class="preview-render-block">` chunks. Our
// build copies that worker into dist/ via scripts/prepare-frontend.sh; if it
// were missing the worker 404s, errors out, and the pipeline silently falls
// back to main-thread rendering (no segments, console noise, first-render
// stall). These specs guard BOTH halves:
//   - the durable user guarantee: a large doc edited on disk re-renders, and
//   - the worker actually engaging (proves preview-worker.js is bundled + runs).
//
// marked/highlight.js are CDN-loaded (cdnjs) in this submodule, so the whole
// app — and the worker's importScripts — need network. The existing render/
// find/toc e2e specs already assume connectivity.

const WORKER_THRESHOLD = 50_000; // PREVIEW_WORKER_THRESHOLD in script.js

// Build a segmented-safe Markdown blob >= minLen chars. "Segmented-safe" means
// it avoids every construct script.js's isSegmentedPreviewSafe() bails on:
// no YAML frontmatter, no `[ref]: url` link defs, no `[^fn]` footnotes, no
// `: ` definition lists, no raw HTML tags. Plain ATX headings + prose only,
// so the worker path is actually taken.
function buildLargeMarkdown(minLen, sentinel) {
  const para =
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ' +
    'tempor incididunt ut labore et dolore magna aliqua ut enim ad minim ' +
    'veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea ' +
    'commodo consequat duis aute irure dolor in reprehenderit in voluptate.';
  let out = '# ' + sentinel + '\n\nLead paragraph for the document.\n\n';
  let i = 0;
  while (out.length < minLen) {
    i += 1;
    out += `## Section ${i} of the large document\n\n${para}\n\n${para}\n\n`;
  }
  return out;
}

describe('대용량 문서 라이브 리로드 + preview-worker 파이프라인', () => {
  beforeEach(async () => {
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
      const m = {};
      list.forEach((t, i) => { m[t.id] = paths[i]; });
      localStorage.setItem('bridge-tab-paths', JSON.stringify(m));
    }, seedTabs, watchedPaths);
    // Keep the seed from being clobbered by the submodule's beforeunload
    // flush on the reload below (see helpers/session.js for the mechanism).
    await browser.execute(installTabSessionWriteFreeze);
    await browser.execute(() => window.location.reload());
    await browser.pause(2500);
  }

  it('대용량(≥50KB) 문서를 외부에서 수정하면 editor 와 preview 가 새 내용으로 갱신된다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'md-large-'));
    const raw = join(dir, 'big.md');
    const initial = '# initial small doc\n\nbody\n';
    writeFileSync(raw, initial);
    const file = realpathSync(raw);

    await seedSession([{ title: 'big.md', content: initial }], [file]);

    const sentinel = 'LARGE SENTINEL ' + Date.now();
    const big = buildLargeMarkdown(WORKER_THRESHOLD + 10_000, sentinel);
    expect(big.length).toBeGreaterThan(WORKER_THRESHOLD);
    writeFileSync(file, big);

    // Editor picks up the full disk content (live-reload sink).
    await browser.waitUntil(
      async () => {
        const len = await browser.execute(() =>
          (document.getElementById('markdown-editor')?.value || '').length);
        return len >= WORKER_THRESHOLD;
      },
      { timeout: 10000, timeoutMsg: 'editor did not receive the large document' }
    );

    // Preview re-renders with the new content (worker OR main-thread fallback)
    // and does not get stuck in the skeleton/busy state.
    await browser.waitUntil(
      async () => {
        const ok = await browser.execute((s) => {
          const p = document.getElementById('markdown-preview');
          if (!p) return false;
          const busy = p.getAttribute('aria-busy') === 'true';
          const skeleton = p.querySelector('.preview-skeleton, [class*="skeleton"]');
          return !busy && !skeleton && (p.textContent || '').includes(s);
        }, sentinel);
        return ok;
      },
      { timeout: 15000, timeoutMsg: 'preview did not re-render the large document' }
    );
  });

  it('대용량(≥50KB) 문서는 preview-worker 세그먼트 경로(.preview-render-block)로 렌더된다', async () => {
    // Proves preview-worker.js is bundled (prepare-frontend.sh) AND runs in the
    // Tauri WebView. The segmented `.preview-render-block` markup is produced
    // ONLY by the worker path (buildSegmentedPreviewHtml); the main-thread
    // fallback emits plain HTML. Without the bundled worker this assertion can
    // never go true → it is the runtime counterpart of the static T1 contract.
    const dir = mkdtempSync(join(tmpdir(), 'md-large-seg-'));
    const raw = join(dir, 'seg.md');
    const initial = '# initial small doc\n\nbody\n';
    writeFileSync(raw, initial);
    const file = realpathSync(raw);

    await seedSession([{ title: 'seg.md', content: initial }], [file]);

    const sentinel = 'SEGMENT SENTINEL ' + Date.now();
    const big = buildLargeMarkdown(WORKER_THRESHOLD + 20_000, sentinel);
    writeFileSync(file, big);

    await browser.waitUntil(
      async () => {
        const count = await browser.execute(() => {
          const p = document.getElementById('markdown-preview');
          return p ? p.querySelectorAll('.preview-render-block').length : 0;
        });
        return count >= 1;
      },
      {
        timeout: 15000,
        timeoutMsg:
          'preview has no .preview-render-block — worker path did not engage ' +
          '(preview-worker.js missing from dist/, or it failed to load in the ' +
          'WebView and fell back to main-thread rendering)',
      }
    );

    // Sanity: the worker-rendered content is the NEW disk content, not stale.
    const hasSentinel = await browser.execute((s) =>
      (document.getElementById('markdown-preview')?.textContent || '').includes(s),
      sentinel);
    expect(hasSentinel).toBe(true);
  });
});
