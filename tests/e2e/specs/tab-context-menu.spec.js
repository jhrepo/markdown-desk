describe('탭 우클릭 컨텍스트 메뉴', () => {
  const LABELS = [
    'Close Tab',
    'Close Other Tabs',
    'Close Tabs to the Right',
    'Close Tabs to the Left',
  ];

  async function openFilesAsTabs(names) {
    for (const name of names) {
      await browser.execute((n) => {
        const fileInput = document.getElementById('file-input');
        if (!fileInput) return;
        const blob = new Blob([`# ${n}`], { type: 'text/markdown' });
        const file = new File([blob], `${n}.md`, { type: 'text/markdown' });
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      }, name);
      await browser.pause(250);
    }
  }

  async function dispatchContextMenu(tabIdx) {
    await browser.execute((idx) => {
      const tabs = document.querySelectorAll('#tab-list .tab-item');
      const target = tabs[idx];
      if (!target) throw new Error('tab index out of range: ' + idx);
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 10,
        clientY: rect.top + 10,
      }));
    }, tabIdx);
    await browser.pause(100);
  }

  async function clickMenuItem(label) {
    const ok = await browser.execute((l) => {
      const items = document.querySelectorAll('.bridge-tab-context-item');
      for (const it of items) {
        if (it.textContent.trim() === l) {
          if (it.disabled) return false;
          it.click();
          return true;
        }
      }
      return false;
    }, label);
    if (!ok) throw new Error(`menu item "${label}" not clickable`);
    await browser.pause(300);
  }

  async function menuItemDisabled(label) {
    return browser.execute((l) => {
      const items = document.querySelectorAll('.bridge-tab-context-item');
      for (const it of items) {
        if (it.textContent.trim() === l) return it.disabled;
      }
      return null;
    }, label);
  }

  async function menuVisible() {
    return browser.execute(() =>
      !!document.querySelector('.bridge-tab-context-menu')
    );
  }

  async function closeAnyMenu() {
    await browser.execute(() => {
      const m = document.querySelector('.bridge-tab-context-menu');
      if (m) m.remove();
    });
  }

  async function getTabTitles() {
    return browser.execute(() =>
      Array.from(document.querySelectorAll('#tab-list .tab-item .tab-title'))
        .map(el => el.textContent.trim())
    );
  }

  afterEach(async () => {
    await closeAnyMenu();
  });

  it('탭을 우클릭하면 컨텍스트 메뉴가 나타난다', async () => {
    const tabs = await $$('#tab-list .tab-item');
    expect(tabs.length).toBeGreaterThanOrEqual(1);

    await dispatchContextMenu(0);
    const menu = await $('.bridge-tab-context-menu');
    await menu.waitForExist({ timeout: 2000 });
    expect(await menu.isDisplayed()).toBe(true);
  });

  it('메뉴에 네 개 항목이 Xcode/IntelliJ 순서로 표시된다', async () => {
    await dispatchContextMenu(0);
    await $('.bridge-tab-context-menu').waitForExist({ timeout: 2000 });

    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.bridge-tab-context-item'))
        .map(b => b.textContent.trim())
    );
    expect(labels).toEqual(LABELS);
  });

  it('Close Tab 은 우클릭한 탭만 닫는다', async () => {
    const tag = 'ctx-close-' + Date.now();
    await openFilesAsTabs([tag]);

    const before = await getTabTitles();
    const targetIdx = before.indexOf(tag);
    expect(targetIdx).toBeGreaterThan(-1);

    await dispatchContextMenu(targetIdx);
    await $('.bridge-tab-context-menu').waitForExist({ timeout: 2000 });
    await clickMenuItem('Close Tab');

    const after = await getTabTitles();
    expect(after.length).toBe(before.length - 1);
    expect(after).not.toContain(tag);
  });

  it('Close Other Tabs 는 우클릭한 탭만 남긴다', async () => {
    const suffix = Date.now();
    const names = ['ctx-other-a-' + suffix, 'ctx-other-b-' + suffix, 'ctx-other-c-' + suffix];
    await openFilesAsTabs(names);

    const before = await getTabTitles();
    const keep = names[1];
    const keepIdx = before.indexOf(keep);
    expect(keepIdx).toBeGreaterThan(-1);

    await dispatchContextMenu(keepIdx);
    await $('.bridge-tab-context-menu').waitForExist({ timeout: 2000 });
    await clickMenuItem('Close Other Tabs');

    const after = await getTabTitles();
    expect(after.length).toBe(1);
    expect(after[0]).toBe(keep);
  });

  it('Close Tabs to the Right 는 오른쪽 탭만 닫는다', async () => {
    const suffix = Date.now();
    const names = ['ctx-right-l-' + suffix, 'ctx-right-p-' + suffix, 'ctx-right-r1-' + suffix, 'ctx-right-r2-' + suffix];
    await openFilesAsTabs(names);

    const before = await getTabTitles();
    const pivot = names[1];
    const pivotIdx = before.indexOf(pivot);
    expect(pivotIdx).toBeGreaterThan(-1);
    const expectedLen = pivotIdx + 1;

    await dispatchContextMenu(pivotIdx);
    await $('.bridge-tab-context-menu').waitForExist({ timeout: 2000 });
    await clickMenuItem('Close Tabs to the Right');

    const after = await getTabTitles();
    expect(after.length).toBe(expectedLen);
    expect(after[expectedLen - 1]).toBe(pivot);
    // Right-side names should be gone
    expect(after).not.toContain(names[2]);
    expect(after).not.toContain(names[3]);
  });

  it('Close Tabs to the Left 는 왼쪽 탭만 닫는다', async () => {
    const suffix = Date.now();
    const names = ['ctx-left-a-' + suffix, 'ctx-left-b-' + suffix, 'ctx-left-p-' + suffix];
    await openFilesAsTabs(names);

    const before = await getTabTitles();
    const pivot = names[2];
    const pivotIdx = before.indexOf(pivot);
    expect(pivotIdx).toBeGreaterThan(-1);
    const expectedLen = before.length - pivotIdx;

    await dispatchContextMenu(pivotIdx);
    await $('.bridge-tab-context-menu').waitForExist({ timeout: 2000 });
    await clickMenuItem('Close Tabs to the Left');

    const after = await getTabTitles();
    expect(after.length).toBe(expectedLen);
    expect(after[0]).toBe(pivot);
    expect(after).not.toContain(names[0]);
    expect(after).not.toContain(names[1]);
  });

  it('맨 오른쪽 탭의 "Close Tabs to the Right" 는 비활성화된다', async () => {
    const tag = 'ctx-edge-r-' + Date.now();
    await openFilesAsTabs([tag]);

    const titles = await getTabTitles();
    const lastIdx = titles.length - 1;
    expect(titles[lastIdx]).toBe(tag);

    await dispatchContextMenu(lastIdx);
    await $('.bridge-tab-context-menu').waitForExist({ timeout: 2000 });
    expect(await menuItemDisabled('Close Tabs to the Right')).toBe(true);
    expect(await menuItemDisabled('Close Tab')).toBe(false);
    if (titles.length > 1) {
      expect(await menuItemDisabled('Close Tabs to the Left')).toBe(false);
      expect(await menuItemDisabled('Close Other Tabs')).toBe(false);
    }
  });

  it('맨 왼쪽 탭의 "Close Tabs to the Left" 는 비활성화된다', async () => {
    const titles = await getTabTitles();

    await dispatchContextMenu(0);
    await $('.bridge-tab-context-menu').waitForExist({ timeout: 2000 });
    expect(await menuItemDisabled('Close Tabs to the Left')).toBe(true);
    expect(await menuItemDisabled('Close Tab')).toBe(false);
    if (titles.length > 1) {
      expect(await menuItemDisabled('Close Tabs to the Right')).toBe(false);
      expect(await menuItemDisabled('Close Other Tabs')).toBe(false);
    }
  });

  it('Esc 키로 메뉴가 닫힌다', async () => {
    await dispatchContextMenu(0);
    await $('.bridge-tab-context-menu').waitForExist({ timeout: 2000 });
    expect(await menuVisible()).toBe(true);

    await browser.execute(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
    });
    await browser.pause(100);
    expect(await menuVisible()).toBe(false);
  });

  it('메뉴 밖을 클릭하면 메뉴가 닫힌다', async () => {
    await dispatchContextMenu(0);
    await $('.bridge-tab-context-menu').waitForExist({ timeout: 2000 });
    expect(await menuVisible()).toBe(true);

    await browser.execute(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, clientX: 10, clientY: window.innerHeight - 20,
      }));
    });
    await browser.pause(100);
    expect(await menuVisible()).toBe(false);
  });
});
