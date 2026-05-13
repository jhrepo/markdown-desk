describe('TOC 플로팅 드로어', () => {
  // Each test should start with the drawer closed and the preview pane
  // visible. The TOC's FAB/drawer state persists across tests in the same
  // worker, and earlier tests leave the drawer open — that makes realign()
  // keep the FAB hidden which then fails isolation assertions in later
  // tests (most visibly the editor-mode hide test).
  beforeEach(async () => {
    await browser.execute(() => {
      // Cancel any lingering hover-intent timer from the prior spec — a
      // late-firing closeTimer would race the next spec's scroll-tracking
      // assertions, marking the drawer closed mid-test.
      if (window.__mdDeskTocInternals) window.__mdDeskTocInternals.cancelTimers();

      const d = document.getElementById('toc-drawer');
      const f = document.getElementById('toc-fab');
      if (d && d.classList.contains('open')) {
        d.classList.remove('open');
        if (f) f.hidden = false;
      }
      // Reset scroll + drop any stale active highlight from prior specs.
      // Without this, "active heading follows scroll" can race a previous
      // spec's drawer-click scroll, leaving offsets stale at the new
      // spec's first scroll event.
      const pane = document.querySelector('.preview-pane');
      if (pane) {
        pane.scrollTop = 0;
        pane.dispatchEvent(new Event('scroll'));
      }
      document.querySelectorAll('.toc-drawer-item.active').forEach(function (el) {
        el.classList.remove('active');
      });
    });
    // Also make sure the view isn't stuck in editor-only mode from a
    // prior test — split keeps the preview pane visible.
    const splitBtn = await $('.view-mode-btn[data-mode="split"]');
    if (await splitBtn.isExisting()) {
      await splitBtn.click();
      await browser.pause(250);
    }
  });

  async function seedPreviewWithHeadings() {
    // Populate the editor with a small document containing three distinct
    // headings and wait for the preview to re-render. We use `input` event
    // because script.js listens on that, not `change`.
    await browser.execute(() => {
      const ta = document.getElementById('markdown-editor');
      ta.value = '# Alpha\n\n본문 A\n\n## Bravo\n\n본문 B\n\n### Charlie\n\n본문 C\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // MutationObserver in toc.js debounces rebuild 80ms; pause long enough
    // for preview + drawer to reflect the new headings.
    await browser.pause(400);
  }

  it('FAB 클릭으로 drawer 열리고 X 버튼으로 닫힌다', async function () {
    const fab = await $('#toc-fab');
    if (!(await fab.isExisting())) return this.skip();

    await fab.click();
    await browser.pause(250);

    const drawerOpen = await browser.execute(() => {
      const d = document.getElementById('toc-drawer');
      return d && d.classList.contains('open');
    });
    expect(drawerOpen).toBe(true);

    // FAB should be hidden while drawer is open
    const fabHidden = await browser.execute(() => document.getElementById('toc-fab').hidden);
    expect(fabHidden).toBe(true);

    const closeBtn = await $('.toc-drawer-close');
    await closeBtn.click();
    await browser.pause(250);

    const closedState = await browser.execute(() => {
      const d = document.getElementById('toc-drawer');
      const f = document.getElementById('toc-fab');
      return { open: d.classList.contains('open'), fabHidden: f.hidden };
    });
    expect(closedState.open).toBe(false);
    expect(closedState.fabHidden).toBe(false);
  });

  it('ESC 키로 drawer 가 닫힌다', async function () {
    const fab = await $('#toc-fab');
    if (!(await fab.isExisting())) return this.skip();

    await fab.click();
    await browser.pause(250);
    await browser.keys('Escape');
    await browser.pause(250);

    const open = await browser.execute(() =>
      document.getElementById('toc-drawer').classList.contains('open')
    );
    expect(open).toBe(false);
  });

  it('헤딩을 포함한 문서의 drawer 에 항목이 문서 순서대로 나열된다', async function () {
    const fab = await $('#toc-fab');
    if (!(await fab.isExisting())) return this.skip();
    await seedPreviewWithHeadings();

    await fab.click();
    await browser.pause(200);

    const items = await browser.execute(() =>
      Array.from(document.querySelectorAll('.toc-drawer-item')).map((a) => a.textContent)
    );
    expect(items).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('drawer 항목 클릭 시 preview 가 해당 헤딩 위치로 스크롤된다', async function () {
    const fab = await $('#toc-fab');
    if (!(await fab.isExisting())) return this.skip();
    await seedPreviewWithHeadings();

    // Pad the document so there's enough space to scroll.
    await browser.execute(() => {
      const ta = document.getElementById('markdown-editor');
      const filler = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n');
      ta.value =
        '# Alpha\n\n' + filler +
        '\n\n## Bravo\n\n' + filler +
        '\n\n### Charlie\n\n' + filler + '\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await browser.pause(500);

    await fab.click();
    await browser.pause(200);

    // Baseline scrollTop at the top
    const before = await browser.execute(() =>
      document.querySelector('.preview-pane').scrollTop
    );
    expect(before).toBe(0);

    // Click "Charlie" — the last (deepest) heading, should scroll the most
    const items = await $$('.toc-drawer-item');
    await items[items.length - 1].click();
    await browser.pause(400);

    const after = await browser.execute(() => {
      const pane = document.querySelector('.preview-pane');
      const h = document.querySelector('#markdown-preview h3');
      return {
        scrollTop: pane.scrollTop,
        // How close is the h3 to the pane top (viewport-relative)?
        delta: h.getBoundingClientRect().top - pane.getBoundingClientRect().top,
      };
    });
    // Should have scrolled noticeably down
    expect(after.scrollTop).toBeGreaterThan(100);
    // Heading should be within a few px of pane top
    expect(Math.abs(after.delta)).toBeLessThan(5);
  });

  it('사용자가 preview 를 스크롤하면 drawer 의 active 헤딩이 따라간다', async function () {
    const fab = await $('#toc-fab');
    if (!(await fab.isExisting())) return this.skip();

    // Large document so each heading sits far enough apart to exercise the
    // scroll→active handler.
    await browser.execute(() => {
      const ta = document.getElementById('markdown-editor');
      const filler = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n\n');
      ta.value =
        '# Alpha\n\n' + filler +
        '\n\n## Bravo\n\n' + filler +
        '\n\n### Charlie\n\n' + filler + '\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Wait until the TOC has rebuilt — we need the drawer rows to match
    // the 3 headings we seeded AND the pane tall enough for Bravo to sit
    // below the fold. Without this the test raced the MutationObserver +
    // recomputeOffsets and found stale offsets (all zero → always Alpha).
    await browser.waitUntil(
      async () => {
        return browser.execute(() => {
          const rows = document.querySelectorAll('.toc-drawer-item');
          const pane = document.querySelector('.preview-pane');
          return rows.length === 3 && pane.scrollHeight > pane.clientHeight + 200;
        });
      },
      { timeout: 3000, timeoutMsg: 'TOC rows or pane height not ready' }
    );

    await fab.click();
    await browser.pause(200);

    // Scroll so Bravo sits at pane top, then wait (via polling, not a
    // fixed pause) for the RAF-coalesced scroll handler to mark it active.
    await browser.execute(() => {
      const pane = document.querySelector('.preview-pane');
      const h2 = document.querySelector('#markdown-preview h2');
      // Add 2px so scrollTop >= offset_bravo (activeHeadingIndex is >=).
      const delta = h2.getBoundingClientRect().top - pane.getBoundingClientRect().top + 2;
      pane.scrollTop = pane.scrollTop + delta;
      pane.dispatchEvent(new Event('scroll'));
    });
    await browser.waitUntil(
      async () => {
        return browser.execute(() => {
          const active = document.querySelector('.toc-drawer-item.active');
          return active && active.textContent === 'Bravo';
        });
      },
      { timeout: 3000, timeoutMsg: 'Active heading did not update to Bravo' }
    );

    // Scroll further so Charlie reaches pane top.
    await browser.execute(() => {
      const pane = document.querySelector('.preview-pane');
      const h3 = document.querySelector('#markdown-preview h3');
      const delta = h3.getBoundingClientRect().top - pane.getBoundingClientRect().top + 2;
      pane.scrollTop = pane.scrollTop + delta;
      pane.dispatchEvent(new Event('scroll'));
    });
    await browser.waitUntil(
      async () => {
        return browser.execute(() => {
          const active = document.querySelector('.toc-drawer-item.active');
          return active && active.textContent === 'Charlie';
        });
      },
      { timeout: 3000, timeoutMsg: 'Active heading did not update to Charlie' }
    );
  });

  it('FAB hover 시 drawer 가 자동으로 펼쳐진다', async function () {
    const fab = await $('#toc-fab');
    if (!(await fab.isExisting())) return this.skip();

    // Dispatch mouseenter directly — WebDriver pointer.move on macOS WKWebView
    // doesn't reliably trip the synthetic hover bridge. Hover-intent timer
    // is 80ms; wait long enough to pass it plus a margin.
    await browser.execute(() => {
      const f = document.getElementById('toc-fab');
      f.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          document.getElementById('toc-drawer').classList.contains('open')
        ),
      { timeout: 1500, timeoutMsg: 'drawer did not open on FAB hover' }
    );

    const fabHidden = await browser.execute(() => document.getElementById('toc-fab').hidden);
    expect(fabHidden).toBe(true);
  });

  it('FAB / drawer 영역을 동시에 벗어나면 drawer 가 다시 닫힌다', async function () {
    const fab = await $('#toc-fab');
    if (!(await fab.isExisting())) return this.skip();

    // Open via hover, then leave both. Close grace is 250ms — poll up to
    // 1.5s so slow CI doesn't race the timer.
    await browser.execute(() => {
      const f = document.getElementById('toc-fab');
      f.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          document.getElementById('toc-drawer').classList.contains('open')
        ),
      { timeout: 1500, timeoutMsg: 'drawer did not open on FAB hover' }
    );

    await browser.execute(() => {
      const f = document.getElementById('toc-fab');
      const d = document.getElementById('toc-drawer');
      f.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
      d.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    });

    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.getElementById('toc-drawer').classList.contains('open')
        ),
      { timeout: 1500, timeoutMsg: 'drawer did not close after leaving both regions' }
    );
  });

  it('editor 모드로 전환하면 FAB 와 drawer 가 모두 숨겨진다', async function () {
    const fab = await $('#toc-fab');
    if (!(await fab.isExisting())) return this.skip();

    // beforeEach already puts us in split mode with drawer closed, so
    // realign() has had time to mark the FAB visible. Wait for that to
    // settle before asserting — the beforeEach click fires a 200ms
    // setTimeout(realign).
    await browser.waitUntil(
      async () =>
        browser.execute(() => !document.getElementById('toc-fab').hidden),
      { timeout: 3000, timeoutMsg: 'FAB did not become visible after split mode' }
    );
    const beforeHidden = await browser.execute(() => ({
      fab: document.getElementById('toc-fab').hidden,
      drawer: document.getElementById('toc-drawer').hidden,
    }));
    expect(beforeHidden.fab).toBe(false);

    const editorBtn = await $('.view-mode-btn[data-mode="editor"]');
    if (!(await editorBtn.isExisting())) return this.skip();
    await editorBtn.click();
    // toc.js polls realign 200ms after view-mode click; poll the DOM
    // instead of a fixed pause so slow CI doesn't race the transition.
    await browser.waitUntil(
      async () => {
        return browser.execute(() => {
          const f = document.getElementById('toc-fab');
          const d = document.getElementById('toc-drawer');
          return f.hidden && d.hidden;
        });
      },
      { timeout: 3000, timeoutMsg: 'FAB/drawer did not hide after editor mode' }
    );

    // Cleanup handled by beforeEach in the next test (restores split mode).
  });
});
