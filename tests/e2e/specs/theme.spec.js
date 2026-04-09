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
    // 추가 토글 없이 현재 테마가 새로고침 후 유지되는지 확인
    const before = await browser.execute(() =>
      document.documentElement.getAttribute('data-theme')
    );

    await browser.refresh();
    await browser.pause(1000);

    const after = await browser.execute(() =>
      document.documentElement.getAttribute('data-theme')
    );

    expect(after).toBe(before);
  });
});
