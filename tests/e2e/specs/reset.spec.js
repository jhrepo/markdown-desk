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
});
