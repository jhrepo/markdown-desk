describe('뷰 모드 전환', () => {
  it('Editor 모드에서 에디터가 표시된다', async function () {
    const editorBtn = await $('.view-mode-btn[data-mode="editor"]');
    if (!(await editorBtn.isExisting())) return this.skip();
    await editorBtn.click();
    await browser.pause(300);

    const editor = await $('#markdown-editor');
    await expect(editor).toBeDisplayed();
  });

  it('Preview 모드에서 프리뷰가 표시된다', async function () {
    const previewBtn = await $('.view-mode-btn[data-mode="preview"]');
    if (!(await previewBtn.isExisting())) return this.skip();
    await previewBtn.click();
    await browser.pause(300);

    const preview = await $('#markdown-preview');
    await expect(preview).toBeDisplayed();
  });

  it('Split 모드에서 에디터와 프리뷰 모두 표시된다', async function () {
    const splitBtn = await $('.view-mode-btn[data-mode="split"]');
    if (!(await splitBtn.isExisting())) return this.skip();
    await splitBtn.click();
    await browser.pause(300);

    const editor = await $('#markdown-editor');
    const preview = await $('#markdown-preview');
    await expect(editor).toBeDisplayed();
    await expect(preview).toBeDisplayed();
  });
});
