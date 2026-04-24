describe('TOC 플로팅 드로어', () => {
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
    await browser.pause(600);

    await fab.click();
    await browser.pause(200);

    // Programmatically scroll to where "Bravo" is at pane top. We compute
    // the exact offset the same way toc.js does so the test locks in both
    // the scroll math *and* the active-highlight handler together.
    await browser.execute(() => {
      const pane = document.querySelector('.preview-pane');
      const h2 = document.querySelector('#markdown-preview h2');
      const delta = h2.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      pane.scrollTop = pane.scrollTop + delta;
      pane.dispatchEvent(new Event('scroll'));
    });
    await browser.pause(200);

    const activeAfterBravo = await browser.execute(() => {
      const active = document.querySelector('.toc-drawer-item.active');
      return active ? active.textContent : null;
    });
    expect(activeAfterBravo).toBe('Bravo');

    // Scroll further so Charlie reaches pane top.
    await browser.execute(() => {
      const pane = document.querySelector('.preview-pane');
      const h3 = document.querySelector('#markdown-preview h3');
      const delta = h3.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      pane.scrollTop = pane.scrollTop + delta;
      pane.dispatchEvent(new Event('scroll'));
    });
    await browser.pause(200);

    const activeAfterCharlie = await browser.execute(() => {
      const active = document.querySelector('.toc-drawer-item.active');
      return active ? active.textContent : null;
    });
    expect(activeAfterCharlie).toBe('Charlie');
  });

  it('editor 모드로 전환하면 FAB 와 drawer 가 모두 숨겨진다', async function () {
    const fab = await $('#toc-fab');
    if (!(await fab.isExisting())) return this.skip();

    // Start from split/preview so realign() marks both visible.
    const splitBtn = await $('.view-mode-btn[data-mode="split"]');
    if (await splitBtn.isExisting()) {
      await splitBtn.click();
      await browser.pause(300);
    }

    const beforeHidden = await browser.execute(() => ({
      fab: document.getElementById('toc-fab').hidden,
      drawer: document.getElementById('toc-drawer').hidden,
    }));
    expect(beforeHidden.fab).toBe(false);

    const editorBtn = await $('.view-mode-btn[data-mode="editor"]');
    if (!(await editorBtn.isExisting())) return this.skip();
    await editorBtn.click();
    // toc.js polls realign 200ms after view-mode click.
    await browser.pause(400);

    const afterHidden = await browser.execute(() => ({
      fab: document.getElementById('toc-fab').hidden,
      drawer: document.getElementById('toc-drawer').hidden,
    }));
    expect(afterHidden.fab).toBe(true);
    expect(afterHidden.drawer).toBe(true);

    // Restore split so subsequent specs aren't affected.
    if (await splitBtn.isExisting()) {
      await splitBtn.click();
      await browser.pause(300);
    }
  });
});
