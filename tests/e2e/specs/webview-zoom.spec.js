// WebView 줌 회귀 가드.
//
// Tauri WKWebView는 브라우저 기본 줌(Cmd+/-/0, 트랙패드 핀치, Ctrl+휠)을
// 비활성화한 채로 동작한다. bridge.js의 capture-phase keydown/wheel 핸들러가
// 입력을 가로채 core:webview:set-webview-zoom 으로 우회한다. 이 spec은
// 입력 → 핸들러 분기 → applyZoom → localStorage 영속화까지의 회귀를 잡는다.
//
// 검증 한계: WebKit이 실제로 화면을 확대했는지(setPageZoom 결과)는 e2e로
// 관찰 불가 — 그건 수동 QA 영역. 그리고 keyboard-shortcuts.spec.js 주석에
// 명시된 것처럼 synthetic KeyboardEvent dispatch는 bridge listener에
// 도달하지 않으므로, 핸들러 분기를 dev-hook(window.__mdDeskZoomInternals)을
// 통해 직접 실행한다.

const STORAGE_KEY = 'markdown-desk-webview-zoom';

async function resetZoom() {
  await browser.execute((key) => {
    if (window.__mdDeskZoomInternals) window.__mdDeskZoomInternals.reset();
    try { localStorage.removeItem(key); } catch (_) {}
  }, STORAGE_KEY);
}

describe('WebView 줌', () => {
  before(async () => {
    // dev-hook이 없으면 release 빌드라는 뜻 — e2e는 debug에서만 의미가 있다.
    const exposed = await browser.execute(() => !!window.__mdDeskZoomInternals);
    expect(exposed).toBe(true);
  });

  beforeEach(resetZoom);
  after(resetZoom);

  it('Cmd+= 는 줌을 +0.1 올리고 localStorage에 저장한다', async () => {
    const result = await browser.execute(() => {
      const handled = window.__mdDeskZoomInternals.pressKey('=', 'meta');
      return {
        handled,
        zoom: window.__mdDeskZoomInternals.getZoom(),
        stored: localStorage.getItem('markdown-desk-webview-zoom'),
      };
    });
    expect(result.handled).toBe(true);
    expect(result.zoom).toBe(1.1);
    expect(result.stored).toBe('1.1');
  });

  it('Cmd++ 도 동일하게 줌 인 한다 (numpad/Shift+= 호환)', async () => {
    const zoom = await browser.execute(() => {
      window.__mdDeskZoomInternals.pressKey('+', 'meta');
      return window.__mdDeskZoomInternals.getZoom();
    });
    expect(zoom).toBe(1.1);
  });

  it('Cmd+- 는 줌을 -0.1 내린다', async () => {
    const zoom = await browser.execute(() => {
      window.__mdDeskZoomInternals.pressKey('-', 'meta');
      return window.__mdDeskZoomInternals.getZoom();
    });
    expect(zoom).toBe(0.9);
  });

  it('Cmd+0 은 1.0 으로 리셋한다', async () => {
    const result = await browser.execute(() => {
      window.__mdDeskZoomInternals.pressKey('=', 'meta');
      window.__mdDeskZoomInternals.pressKey('=', 'meta');
      const before = window.__mdDeskZoomInternals.getZoom();
      window.__mdDeskZoomInternals.pressKey('0', 'meta');
      return { before, after: window.__mdDeskZoomInternals.getZoom() };
    });
    expect(result.before).toBe(1.2);
    expect(result.after).toBe(1.0);
  });

  it('Ctrl 수정자(Windows/Linux 호환)도 같은 분기를 탄다', async () => {
    const zoom = await browser.execute(() => {
      window.__mdDeskZoomInternals.pressKey('=', 'ctrl');
      return window.__mdDeskZoomInternals.getZoom();
    });
    expect(zoom).toBe(1.1);
  });

  it('수정자 없는 키는 가로채지 않는다 (false 리턴 → 다른 핸들러로 전파)', async () => {
    const handled = await browser.execute(() => {
      // `metaKey:false, ctrlKey:false` 시 분기 안 됨.
      return window.__mdDeskZoomInternals.pressKey('=', 'none');
    });
    expect(handled).toBe(false);
  });

  it('Cmd+= 를 ZOOM_MAX(3.0) 이상으로 눌러도 클램프된다', async () => {
    const zoom = await browser.execute(() => {
      // 0.1 step × 40 = 시작 1.0 + 4.0 ≫ 3.0, 클램프 검증
      for (let i = 0; i < 40; i++) window.__mdDeskZoomInternals.pressKey('=', 'meta');
      return window.__mdDeskZoomInternals.getZoom();
    });
    expect(zoom).toBe(3.0);
  });

  it('Cmd+- 를 ZOOM_MIN(0.3) 이하로 눌러도 클램프된다', async () => {
    const zoom = await browser.execute(() => {
      for (let i = 0; i < 40; i++) window.__mdDeskZoomInternals.pressKey('-', 'meta');
      return window.__mdDeskZoomInternals.getZoom();
    });
    expect(zoom).toBe(0.3);
  });

  // ---- 휠 (마우스 휠 + Ctrl/Cmd, 트랙패드 핀치는 WebKit이 wheel+ctrlKey로 합성) ----

  it('wheel + ctrlKey(트랙패드 핀치 등가) deltaY<0 은 줌 인', async () => {
    const result = await browser.execute(() => {
      const handled = window.__mdDeskZoomInternals.scrollWheel(-50, 'ctrl');
      return {
        handled,
        zoom: window.__mdDeskZoomInternals.getZoom(),
      };
    });
    expect(result.handled).toBe(true);
    expect(result.zoom).toBeGreaterThan(1.0);
    expect(result.zoom).toBeLessThanOrEqual(3.0);
  });

  it('wheel + metaKey(Cmd+휠 보너스 분기) 도 동일하게 동작한다', async () => {
    const zoom = await browser.execute(() => {
      window.__mdDeskZoomInternals.scrollWheel(-50, 'meta');
      return window.__mdDeskZoomInternals.getZoom();
    });
    expect(zoom).toBeGreaterThan(1.0);
  });

  it('수정자 없는 wheel 은 가로채지 않는다 (스크롤이 페이지로 전파되도록)', async () => {
    const handled = await browser.execute(() => {
      return window.__mdDeskZoomInternals.scrollWheel(-50, 'none');
    });
    expect(handled).toBe(false);
  });

  it('wheel 줌 변경도 localStorage 에 영속화된다', async () => {
    const stored = await browser.execute(() => {
      window.__mdDeskZoomInternals.scrollWheel(-50, 'ctrl');
      return localStorage.getItem('markdown-desk-webview-zoom');
    });
    expect(stored).not.toBe(null);
    expect(parseFloat(stored)).toBeGreaterThan(1.0);
  });
});
