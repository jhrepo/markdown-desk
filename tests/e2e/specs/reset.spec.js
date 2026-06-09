describe('Reset 버튼', () => {
  it('Reset 후 markdownViewerGlobalState가 보존된다', async function () {
    // Use the app's theme toggle to save theme via saveGlobalState()
    const toggle = await $('#theme-toggle');
    await toggle.click();
    await browser.pause(500);

    const stateBefore = await browser.execute(() =>
      localStorage.getItem('markdownViewerGlobalState')
    );

    // If globalState wasn't saved by the app, set it manually
    if (!stateBefore) {
      await browser.execute(() => {
        localStorage.setItem('markdownViewerGlobalState', JSON.stringify({ theme: 'dark' }));
      });
    }

    const resetBtn = await $('#tab-reset-btn');
    if (!(await resetBtn.isExisting())) return this.skip();

    await resetBtn.click();
    await browser.pause(2000);

    const stateAfter = await browser.execute(() =>
      localStorage.getItem('markdownViewerGlobalState')
    );

    expect(stateAfter).not.toBeNull();
  });

  it('Reset 후 markdown-desk-default-app-dismissed가 보존된다', async function () {
    await browser.execute(() => {
      localStorage.setItem('markdown-desk-default-app-dismissed', '26.4.2');
    });

    const resetBtn = await $('#tab-reset-btn');
    if (!(await resetBtn.isExisting())) return this.skip();

    await resetBtn.click();
    await browser.pause(2000);

    const dismissed = await browser.execute(() =>
      localStorage.getItem('markdown-desk-default-app-dismissed')
    );

    expect(dismissed).toBe('26.4.2');
  });

  it('Reset 후 다른 localStorage 항목은 제거된다', async function () {
    await browser.execute(() => {
      localStorage.setItem('test-key-should-be-cleared', 'value');
    });

    const resetBtn = await $('#tab-reset-btn');
    if (!(await resetBtn.isExisting())) return this.skip();

    await resetBtn.click();
    await browser.pause(2000);

    const testVal = await browser.execute(() =>
      localStorage.getItem('test-key-should-be-cleared')
    );

    expect(testVal).toBeNull();
  });

  it('Reset 후 탭 세션(markdownViewerTabs)이 초기화된다 — beforeunload flush 가 되살리지 않는다', async function () {
    // Regression guard for Markdown-Viewer 3.7.x (PERF-008): the submodule now
    // flushes its in-memory `tabs` array to markdownViewerTabs on `beforeunload`.
    // bridge.js hardReload() clears localStorage and immediately reloads, so
    // that flush would write the just-cleared tabs straight back — Reset would
    // no longer reset the open documents. bridge.js must suppress the tab-key
    // flush across the reset reload.
    const resetBtn = await $('#tab-reset-btn');
    if (!(await resetBtn.isExisting())) return this.skip();

    // Land a distinctive marker into the active tab AND the in-memory `tabs`
    // array via the app's own save path (input → saveCurrentTabState, 500ms
    // debounce). The marker in `tabs` is exactly what the beforeunload flush
    // would resurrect.
    const marker = 'RESET_TAB_MARKER_' + Date.now();
    await browser.execute((m) => {
      const ed = document.getElementById('markdown-editor');
      ed.value = m;
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    }, marker);

    await browser.waitUntil(
      async () => {
        const tabs = await browser.execute(
          () => localStorage.getItem('markdownViewerTabs') || ''
        );
        return tabs.includes(marker);
      },
      { timeout: 4000, timeoutMsg: 'precondition: marker not persisted to markdownViewerTabs' }
    );

    await resetBtn.click();
    await browser.pause(2500);

    // The reset session must not contain the pre-reset marker.
    const after = await browser.execute(
      () => localStorage.getItem('markdownViewerTabs') || ''
    );
    expect(after.includes(marker)).toBe(false);
  });
});
