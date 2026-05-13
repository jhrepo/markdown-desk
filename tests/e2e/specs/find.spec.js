describe('Cmd+F 텍스트 찾기', () => {
  // Earlier runs (and prod) rely on the default upstream README containing
  // "Welcome" and "Markdown". Across cumulative e2e runs localStorage can
  // end up holding custom content from earlier specs — explicitly seed a
  // known document here so every find test searches against the same
  // baseline, regardless of leftover state.
  before(async () => {
    await browser.keys('Escape'); // close any find bar from a prior spec
    await browser.execute(() => {
      const ta = document.getElementById('markdown-editor');
      if (!ta) return;
      ta.value =
        '# Welcome\n\n' +
        'Welcome to Markdown Desk. This document is used by the find spec to ' +
        'exercise search. Welcome, Welcome, Markdown, Markdown — the word ' +
        'counts here are fixed so Enter/Shift+Enter navigation has multiple ' +
        'matches to jump between.\n\n' +
        '## More Markdown\n\nMarkdown and Welcome appear many times.\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Let the preview re-render before the first Cmd+F fires.
    await browser.pause(500);
  });

  it('Cmd+F로 검색 바가 표시된다', async () => {
    await browser.keys(['Meta', 'f']);

    const findBar = await $('.bridge-find-bar');
    await expect(findBar).toBeDisplayed();
  });

  it('Cmd+F 우선권: 서브모듈의 자체 Find/Replace 모달은 노출되지 않는다', async () => {
    // viewer 364cedd가 자체 Find/Replace 모달(`#find-replace-modal`)과
    // markdownEditor.keydown('f') 핸들러를 추가했다. bridge.js가 document
    // 레벨의 capture-phase Cmd+F 리스너에서 preventDefault + stopPropagation
    // 하므로 서브모듈 모달은 절대 열리면 안 된다 — 만약 capture 우선권이
    // 깨지면 사용자가 두 개의 Find UI를 동시에 보게 된다.
    await browser.keys('Escape');
    await browser.pause(100);

    await browser.keys(['Meta', 'f']);
    await browser.pause(200);

    const bridgeBar = await $('.bridge-find-bar');
    await expect(bridgeBar).toBeDisplayed();

    const upstreamModal = await $('#find-replace-modal');
    if (await upstreamModal.isExisting()) {
      // 모달 자체는 정적 마크업으로 DOM에 존재할 수 있지만, 화면에는 보이면 안 됨.
      const display = await upstreamModal.getCSSProperty('display');
      expect(display.value).toBe('none');
    }

    await browser.keys('Escape');
    await browser.pause(100);
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

    // 데스크탑 헤더의 view-toggle 버튼. 364cedd에서 `.view-mode-btn`이 사라지면서
    // 이전 `isExisting` 가드가 silent skip을 만들고 있었음. 정확한 셀렉터로 고정.
    const viewBtn = await $('.view-toggle-btn[data-view-mode="editor"]');
    await expect(viewBtn).toBeExisting();
    await viewBtn.click();
    await browser.pause(200);

    const findBar = await $('.bridge-find-bar');
    expect(await findBar.getCSSProperty('display')).toHaveProperty('value', 'none');
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
    // Fail loudly instead of silently passing — if `.tab-new-btn` ever
    // stops working (selector drift, host disabling), the original
    // `return` swallowed the whole test as a pass with zero assertions.
    expect(tabs.length).toBeGreaterThanOrEqual(2);

    await browser.keys(['Meta', 'f']);
    const input = await $('.bridge-find-bar input');
    await input.setValue('test');
    await browser.pause(300);

    const freshTabs = await $$('#tab-list .tab-item');
    // Click whichever tab is not currently active. substring 비교(`.includes`)
    // 는 'is-active' / 'deactivated' 같은 변형도 truthy 라 false positive 가
    // 난다. 토큰 단위 일치로 한정.
    const firstClass = (await freshTabs[0].getAttribute('class')) || '';
    const targetIdx = firstClass.split(/\s+/).includes('active') ? 1 : 0;
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
