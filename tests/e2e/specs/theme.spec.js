describe('테마 토글/유지', () => {
  it('테마 토글 클릭 시 data-theme 속성이 변경된다', async () => {
    const before = await browser.execute(() =>
      document.documentElement.getAttribute('data-theme')
    );

    const toggle = await $('#theme-toggle');
    await toggle.click();

    const after = await browser.execute(() =>
      document.documentElement.getAttribute('data-theme')
    );

    expect(before).not.toBe(after);
    expect(['light', 'dark']).toContain(after);
  });

  it('토글 후 localStorage에 테마가 저장된다', async () => {
    const toggle = await $('#theme-toggle');
    await toggle.click();
    await browser.waitUntil(
      async () => {
        const state = await browser.execute(() =>
          JSON.parse(localStorage.getItem('markdownViewerGlobalState') || '{}')
        );
        return !!state.theme;
      },
      { timeout: 3000, timeoutMsg: 'Theme not saved to localStorage' }
    );

    const theme = await browser.execute(() => {
      const state = JSON.parse(localStorage.getItem('markdownViewerGlobalState') || '{}');
      return state.theme;
    });

    const dataTheme = await browser.execute(() =>
      document.documentElement.getAttribute('data-theme')
    );

    expect(theme).toBe(dataTheme);
  });

  it('페이지 새로고침 후 테마가 유지된다', async () => {
    // 이전 테스트에서 토글된 상태가 저장되어 있으므로
    // 추가 토글 없이 현재 테마가 새로고침 후 유지되는지 확인.
    //
    // Drop a sentinel and clear data-theme *before* refresh so the
    // polling loop below can't see stale values from the pre-refresh
    // page. browser.refresh() is async at the WebDriver layer — a
    // fixed `browser.pause(1000)` can fire before the reload actually
    // kicks in (readyState still 'complete', data-theme still set),
    // returning the OLD page's attribute and silently passing — or
    // catch the mid-reload window where the host hasn't restored
    // data-theme yet, silently failing. Same race pattern as
    // auto-refresh-cold-start.spec.js beforeEach.
    const before = await browser.execute(() => {
      const t = document.documentElement.getAttribute('data-theme');
      window.__themeSpecSentinel = true;
      document.documentElement.removeAttribute('data-theme');
      return t;
    });

    await browser.refresh();

    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          document.readyState === 'complete' &&
          !window.__themeSpecSentinel &&
          !!document.documentElement.getAttribute('data-theme')
        ),
      { timeout: 5000, timeoutMsg: 'theme spec refresh did not finish (host did not restore data-theme)' }
    );

    const after = await browser.execute(() =>
      document.documentElement.getAttribute('data-theme')
    );

    expect(after).toBe(before);
  });
});
