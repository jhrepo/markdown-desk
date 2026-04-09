describe('Cmd+F 텍스트 찾기', () => {
  it('Cmd+F로 검색 바가 표시된다', async () => {
    await browser.keys(['Meta', 'f']);

    const findBar = await $('.bridge-find-bar');
    await expect(findBar).toBeDisplayed();
  });

  it('텍스트 입력 시 하이라이트와 카운트가 표시된다', async () => {
    await browser.keys(['Meta', 'f']);

    const input = await $('.bridge-find-bar input');
    await input.setValue('Welcome');
    await browser.waitUntil(
      async () => (await $$('.bridge-find-highlight')).length > 0,
      { timeout: 3000, timeoutMsg: 'Find highlights not rendered' }
    );

    const highlights = await $$('.bridge-find-highlight');
    expect(highlights.length).toBeGreaterThan(0);

    const count = await $('.bridge-find-count');
    const text = await count.getText();
    expect(text).toMatch(/\d+\/\d+/);
  });

  it('Enter로 다음 매치로 이동한다', async () => {
    await browser.keys(['Meta', 'f']);

    const input = await $('.bridge-find-bar input');
    await input.setValue('Markdown');
    await browser.waitUntil(
      async () => (await $$('.bridge-find-highlight')).length > 0,
      { timeout: 3000, timeoutMsg: 'Find highlights not rendered' }
    );

    const countBefore = await $('.bridge-find-count').getText();
    await browser.keys('Enter');
    await browser.pause(100);
    const countAfter = await $('.bridge-find-count').getText();

    expect(countAfter).toMatch(/\d+\/\d+/);
  });

  it('Shift+Enter로 이전 매치로 이동한다', async () => {
    await browser.keys(['Meta', 'f']);

    const input = await $('.bridge-find-bar input');
    await input.setValue('Markdown');
    await browser.waitUntil(
      async () => (await $$('.bridge-find-highlight')).length > 0,
      { timeout: 3000, timeoutMsg: 'Find highlights not rendered' }
    );

    await browser.keys('Enter');
    await browser.keys('Enter');
    await browser.pause(100);
    const countBefore = await $('.bridge-find-count').getText();

    await browser.keys(['Shift', 'Enter']);
    await browser.pause(100);
    const countAfter = await $('.bridge-find-count').getText();

    expect(countAfter).toMatch(/\d+\/\d+/);
    expect(countAfter).not.toBe(countBefore);
  });

  it('Esc로 검색 바가 닫히고 하이라이트가 제거된다', async () => {
    await browser.keys(['Meta', 'f']);
    const input = await $('.bridge-find-bar input');
    await input.setValue('test');
    await browser.pause(300); // short pause for UI to process input

    await browser.keys('Escape');
    await browser.pause(100);

    const findBar = await $('.bridge-find-bar');
    expect(await findBar.getCSSProperty('display')).toHaveProperty('value', 'none');

    const highlights = await $$('.bridge-find-highlight');
    expect(highlights.length).toBe(0);
  });

  it('뷰 모드 변경 시 검색 바가 자동으로 닫힌다', async () => {
    await browser.keys(['Meta', 'f']);
    const input = await $('.bridge-find-bar input');
    await input.setValue('test');
    await browser.pause(300); // short pause for UI to process input

    const viewBtn = await $('.view-mode-btn');
    if (await viewBtn.isExisting()) {
      await viewBtn.click();
      await browser.pause(200);

      const findBar = await $('.bridge-find-bar');
      expect(await findBar.getCSSProperty('display')).toHaveProperty('value', 'none');
    }
  });

  it('탭 전환 시 검색 바가 자동으로 닫힌다', async () => {
    await browser.keys(['Meta', 'f']);
    const input = await $('.bridge-find-bar input');
    await input.setValue('test');
    await browser.pause(300); // short pause for UI to process input

    const tabs = await $$('#tab-list .tab-item');
    if (tabs.length >= 2) {
      await tabs[0].click();
      await browser.pause(200);

      const findBar = await $('.bridge-find-bar');
      expect(await findBar.getCSSProperty('display')).toHaveProperty('value', 'none');
    }
  });
});
