describe('Mermaid 다이어그램', () => {
  before(async () => {
    await browser.execute(() => {
      const editor = document.getElementById('markdown-editor');
      if (editor) {
        editor.value = '```mermaid\ngraph TD;\n  A-->B;\n  A-->C;\n  B-->D;\n```';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await browser.waitUntil(
      async () => (await $('#markdown-preview svg')).isExisting(),
      { timeout: 5000, timeoutMsg: 'Mermaid SVG not rendered' }
    );
  });

  it('Mermaid 코드 블록이 SVG로 렌더링된다', async () => {
    const svg = await $('#markdown-preview svg');
    await expect(svg).toBeExisting();
  });

  it('줌 버튼 클릭 시 모달이 열린다', async function () {
    const zoomBtn = await $('.mermaid-zoom-btn');
    if (!(await zoomBtn.isExisting())) return this.skip();

    await zoomBtn.click();
    await browser.pause(500);

    const modal = await $('#mermaid-zoom-modal');
    const classes = await modal.getAttribute('class');
    expect(classes).toContain('active');
  });

  it('모달 닫기 후 active 클래스가 제거된다', async function () {
    const modal = await $('#mermaid-zoom-modal');
    if (!(await modal.isExisting())) return this.skip();

    await browser.keys('Escape');
    await browser.pause(300);

    const classes = await modal.getAttribute('class') || '';
    expect(classes).not.toContain('active');
  });

  it('Mermaid 모달 열린 상태에서 Cmd+F가 동작하지 않는다', async function () {
    const zoomBtn = await $('.mermaid-zoom-btn');
    if (!(await zoomBtn.isExisting())) return this.skip();

    await zoomBtn.click();
    await browser.pause(500);

    await browser.keys(['Meta', 'f']);
    await browser.pause(300);

    const findBar = await $('.bridge-find-bar');
    const display = await findBar.getCSSProperty('display');
    expect(display.value).toBe('none');

    await browser.keys('Escape');
    await browser.pause(300);
  });
});
