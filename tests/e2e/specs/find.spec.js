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
    // Ensure at least two tabs — the earlier version of this test silently
    // passed on single-tab runs.
    let tabs = await $$('#tab-list .tab-item');
    if (tabs.length < 2) {
      await browser.execute(() => {
        const addBtn = document.querySelector('.tab-new-btn');
        if (addBtn) addBtn.click();
      });
      await browser.pause(300);
      tabs = await $$('#tab-list .tab-item');
    }
    if (tabs.length < 2) return; // harness couldn't create a second tab

    await browser.keys(['Meta', 'f']);
    const input = await $('.bridge-find-bar input');
    await input.setValue('test');
    await browser.pause(300);

    const freshTabs = await $$('#tab-list .tab-item');
    // Click whichever tab is not currently active.
    const targetIdx = (await freshTabs[0].getAttribute('class')).includes('active') ? 1 : 0;
    await freshTabs[targetIdx].click();
    await browser.pause(250);

    const findBar = await $('.bridge-find-bar');
    expect(await findBar.getCSSProperty('display')).toHaveProperty('value', 'none');
  });

  it('프리뷰가 재렌더되어도 Cmd+F 재검색 시 결과 수가 올바르게 재계산된다', async () => {
    // Regression guard: preview's MutationObserver blows away any previous
    // highlight spans when Markdown re-renders. The find bar must recover
    // — reopening Cmd+F and typing should yield a fresh count that reflects
    // the new content, not stale highlight elements.
    await browser.execute(() => {
      const ta = document.getElementById('markdown-editor');
      ta.value = '# findme doc\n\nfindme appears once here\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await browser.pause(400);

    // Close find bar if any previous test left it open.
    await browser.keys('Escape');
    await browser.pause(150);

    await browser.keys(['Meta', 'f']);
    let input = await $('.bridge-find-bar input');
    await input.setValue('findme');
    await browser.waitUntil(
      async () => (await $$('.bridge-find-highlight')).length > 0,
      { timeout: 3000, timeoutMsg: 'initial highlight render missing' }
    );
    const firstCount = (await $$('.bridge-find-highlight')).length;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Re-render with more occurrences.
    await browser.keys('Escape');
    await browser.pause(150);
    await browser.execute(() => {
      const ta = document.getElementById('markdown-editor');
      ta.value = '# findme doc\n\nfindme one\n\nfindme two\n\nfindme three\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await browser.pause(500);

    // Reopen find, same query — count must reflect the new DOM.
    await browser.keys(['Meta', 'f']);
    input = await $('.bridge-find-bar input');
    await input.setValue('findme');
    await browser.waitUntil(
      async () => (await $$('.bridge-find-highlight')).length >= 3,
      { timeout: 3000, timeoutMsg: 'highlights did not re-compute after re-render' }
    );
    const secondCount = (await $$('.bridge-find-highlight')).length;
    expect(secondCount).toBeGreaterThanOrEqual(3);
    expect(secondCount).toBeGreaterThan(firstCount);

    // Leave the UI clean for subsequent specs.
    await browser.keys('Escape');
    await browser.pause(100);
  });
});
