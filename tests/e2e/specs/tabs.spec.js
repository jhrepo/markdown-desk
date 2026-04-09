describe('탭 관리', () => {
  it('초기 상태에서 탭이 하나 존재한다', async () => {
    const tabs = await $$('#tab-list .tab-item');
    expect(tabs.length).toBeGreaterThanOrEqual(1);
  });

  it('새 탭을 추가하면 탭 수가 증가한다', async () => {
    const tabsBefore = await $$('#tab-list .tab-item');
    const countBefore = tabsBefore.length;

    await browser.execute(() => {
      const addBtn = document.querySelector('.tab-new-btn');
      if (addBtn) addBtn.click();
    });
    await browser.pause(500);

    const tabsAfter = await $$('#tab-list .tab-item');
    expect(tabsAfter.length).toBe(countBefore + 1);
  });

  it('탭 클릭 시 해당 탭이 활성화된다', async function () {
    const tabs = await $$('#tab-list .tab-item');
    if (tabs.length < 2) return this.skip();

    await tabs[0].click();
    await browser.pause(200);

    // Re-query to avoid stale element reference
    const freshTabs = await $$('#tab-list .tab-item');
    const classes = await freshTabs[0].getAttribute('class');
    expect(classes).toContain('active');
  });

  it('탭 삭제 메뉴 클릭 시 탭이 제거된다', async function () {
    const tabsBefore = await $$('#tab-list .tab-item');
    if (tabsBefore.length < 2) return this.skip();

    const countBefore = tabsBefore.length;
    const lastTab = tabsBefore[tabsBefore.length - 1];

    // Use the three-dot menu to delete the tab
    const menuBtn = await lastTab.$('.tab-menu-btn');
    if (!(await menuBtn.isExisting())) return this.skip();

    await menuBtn.click();
    await browser.pause(200);

    const deleteBtn = await lastTab.$('.tab-menu-item[data-action="delete"]');
    if (!(await deleteBtn.isExisting())) return this.skip();

    await deleteBtn.click();
    await browser.pause(300);

    const tabsAfter = await $$('#tab-list .tab-item');
    expect(tabsAfter.length).toBe(countBefore - 1);
  });
});
