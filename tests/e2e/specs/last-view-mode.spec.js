// 신규 탭이 사용자의 마지막 viewMode 로 시작하는지 검증.
//
// 원본 Markdown-Viewer 는 createTab 에서 viewMode 기본을 항상 'split' 로
// 하드코딩한다(Markdown-Viewer/script.js:652). bridge.js 는 사용자가 마지막에
// 선택한 viewMode 를 localStorage('markdown-desk-last-view-mode') 에 기록하고,
// 신규 .tab-item 이 mount 되는 순간 해당 모드 토글 버튼을 click 합성으로 호출해
// setViewMode 우회한다. 이 spec 은 다음 회귀를 잡는다:
//   1) viewMode 토글 클릭 시 localStorage 기록
//   2) 새 탭 생성 시 last mode 적용
//   3) 옛 탭으로 switching 할 때는 그 탭의 viewMode 보존 (옵션 A 보장)
//   4) saved 가 'split' 또는 unknown 일 때 아무것도 하지 않음

const STORAGE_KEY = 'markdown-desk-last-view-mode';

async function clearLastMode() {
  await browser.execute((k) => {
    try { localStorage.removeItem(k); } catch (_) {}
    if (window.__mdDeskViewModeInternals) {
      window.__mdDeskViewModeInternals.clearSavedMode();
      window.__mdDeskViewModeInternals.resetKnownTabs();
    }
  }, STORAGE_KEY);
}

async function activeMode() {
  return browser.execute(() => {
    const active = document.querySelector('.view-toggle-btn.is-active');
    return active ? active.getAttribute('data-view-mode') : null;
  });
}

describe('마지막 viewMode 기억', () => {
  before(async () => {
    const exposed = await browser.execute(() => !!window.__mdDeskViewModeInternals);
    expect(exposed).toBe(true);
  });

  beforeEach(clearLastMode);
  after(clearLastMode);

  it('viewMode 토글 클릭은 localStorage 에 모드를 기록한다', async () => {
    const stored = await browser.execute((k) => {
      const btn = document.querySelector('.view-toggle-btn[data-view-mode="editor"]');
      if (btn) btn.click();
      return localStorage.getItem(k);
    }, STORAGE_KEY);
    expect(stored).toBe('editor');
  });

  it('각 모드(editor/split/preview)를 모두 기록한다', async () => {
    const seen = await browser.execute(() => {
      const out = {};
      ['editor', 'split', 'preview'].forEach((m) => {
        const b = document.querySelector('.view-toggle-btn[data-view-mode="' + m + '"]');
        if (b) b.click();
        out[m] = localStorage.getItem('markdown-desk-last-view-mode');
      });
      return out;
    });
    expect(seen.editor).toBe('editor');
    expect(seen.split).toBe('split');
    expect(seen.preview).toBe('preview');
  });

  it("saved === 'split' 이면 신규 탭에 아무 동작도 하지 않는다 (no-op)", async () => {
    // applyLastModeIfNeeded 자체를 호출해도 split 은 early-return.
    // dev-hook 으로 직접 호출하면 click 합성도 없어야 한다.
    const before = await activeMode();
    await browser.execute(() => {
      window.__mdDeskViewModeInternals.setSavedMode('split');
      window.__mdDeskViewModeInternals.applyLastModeIfNeeded();
    });
    const after = await activeMode();
    expect(after).toBe(before);
  });

  it("saved 가 'editor' 면 신규 탭에 editor 모드를 적용한다", async () => {
    // 사전 조건: 사용자가 editor 를 선택했다고 가정.
    await browser.execute(() => window.__mdDeskViewModeInternals.setSavedMode('editor'));

    // 새 탭 생성: 호스트의 New Tab 버튼을 클릭.
    const newTabBtn = await $('.tab-new-btn');
    await expect(newTabBtn).toBeExisting();

    await newTabBtn.click();
    await browser.pause(200); // applyLastModeIfNeeded 는 setTimeout(0) 후 detect

    const mode = await activeMode();
    expect(mode).toBe('editor');
  });

  it("saved 가 'preview' 면 신규 탭에 preview 모드를 적용한다", async () => {
    await browser.execute(() => window.__mdDeskViewModeInternals.setSavedMode('preview'));
    const newTabBtn = await $('.tab-new-btn');
    await expect(newTabBtn).toBeExisting();

    await newTabBtn.click();
    await browser.pause(200);

    const mode = await activeMode();
    expect(mode).toBe('preview');
  });

  it('알려지지 않은 saved 값은 무시되고 split 기본값이 유지된다', async () => {
    await browser.execute(() => {
      window.__mdDeskViewModeInternals.setSavedMode('not-a-real-mode');
    });
    const newTabBtn = await $('.tab-new-btn');
    await expect(newTabBtn).toBeExisting();

    await newTabBtn.click();
    await browser.pause(200);

    const mode = await activeMode();
    expect(mode).toBe('split');
  });

  it('옛 탭으로 돌아가도 그 탭의 viewMode 가 보존된다 (override 하지 않음)', async () => {
    // 시나리오: 탭1 을 active 로 두고 split 으로 명시 초기화 → last = editor,
    // 새 탭(탭N) = editor 로 시작, 탭1 클릭 → 탭1 은 여전히 split.
    // 이전 테스트들이 탭1 의 viewMode 를 preview 등으로 바꿔놨을 수 있으므로
    // baseline 을 고정한다.
    const setup = await browser.execute(() => {
      const tabs = document.querySelectorAll('#tab-list .tab-item');
      if (tabs.length < 1) return null;
      tabs[0].click(); // tab1 을 active 로 전환 (저장된 viewMode 가 일단 복원됨)
      return tabs[0].getAttribute('data-tab-id');
    });
    if (!setup) return this.skip();
    await browser.pause(150);
    // 이제 tab1 이 active 이므로 split 토글 클릭은 tab1.viewMode 를 split 으로 덮어쓴다.
    await browser.execute(() => {
      const splitBtn = document.querySelector('.view-toggle-btn[data-view-mode="split"]');
      if (splitBtn) splitBtn.click();
    });
    await browser.pause(150);
    expect(await activeMode()).toBe('split');

    await browser.execute(() => window.__mdDeskViewModeInternals.setSavedMode('editor'));
    const newTabBtn = await $('.tab-new-btn');
    await expect(newTabBtn).toBeExisting();

    await newTabBtn.click();
    await browser.pause(200);
    expect(await activeMode()).toBe('editor');

    // 탭1 로 복귀.
    await browser.execute((firstId) => {
      const t = document.querySelector('[data-tab-id="' + firstId + '"]');
      if (t) t.click();
    }, setup);
    await browser.pause(200);

    // 탭1 의 viewMode 가 'split' 으로 복원되어야 한다.
    expect(await activeMode()).toBe('split');
  });
});
