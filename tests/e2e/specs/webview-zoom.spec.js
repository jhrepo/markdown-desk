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
  before(async function () {
    // dev-hook 이 없으면 release 빌드 — prepare-frontend.sh 의 strip 결과.
    // 이 spec 은 dev-hook 으로만 핸들러 분기를 호출하므로 release smoke
    // 에서는 통째로 의미가 없다. hard fail 대신 skip 하여 release smoke
    // 의 false-negative 를 막는다.
    const exposed = await browser.execute(() => !!window.__mdDeskZoomInternals);
    if (!exposed) this.skip();
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
    // 결정적 단언: 1.0 + (50 * 0.01) = 1.5. round2 적용 후도 1.5 정확.
    // 이전 toBeGreaterThan(1.0) 은 step 이 갑자기 0.0001 로 바뀌어도
    // 통과하므로 회귀 가드로 약했음.
    const result = await browser.execute(() => {
      const handled = window.__mdDeskZoomInternals.scrollWheel(-50, 'ctrl');
      return {
        handled,
        zoom: window.__mdDeskZoomInternals.getZoom(),
      };
    });
    expect(result.handled).toBe(true);
    expect(result.zoom).toBe(1.5);
  });

  it('wheel + metaKey(Cmd+휠 보너스 분기) 도 동일하게 동작한다', async () => {
    const zoom = await browser.execute(() => {
      window.__mdDeskZoomInternals.scrollWheel(-50, 'meta');
      return window.__mdDeskZoomInternals.getZoom();
    });
    expect(zoom).toBe(1.5);
  });

  it('wheel + ctrlKey deltaY 큰 양수는 ZOOM_MIN(0.3) 에 클램프된다', async () => {
    // zoom-in 클램프 케이스는 키보드 측에서 다루지만 휠 분기는
    // nextZoomFromWheel 의 별도 경로를 탄다. 클램프 경계를 잃지 않도록
    // 휠 쪽도 명시적으로 가드.
    const result = await browser.execute(() => {
      window.__mdDeskZoomInternals.scrollWheel(+10000, 'ctrl');
      return {
        zoom: window.__mdDeskZoomInternals.getZoom(),
        stored: localStorage.getItem('markdown-desk-webview-zoom'),
      };
    });
    expect(result.zoom).toBe(0.3);
    expect(result.stored).toBe('0.3');
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
    expect(stored).toBe('1.5');
  });

  // IPC drop 회귀 가드. dev-hook 의 currentZoom 변수와 localStorage 는
  // applyZoom 내부에서 모두 갱신되므로, plugin:webview|set_webview_zoom
  // IPC 호출이 silent drop 돼도 위 테스트들은 그대로 통과한다.
  // 실제 화면 줌은 그 IPC 만이 적용하므로, invoke 자체를 capture 해
  // 호출 인자까지 가드한다.
  it('zoom 적용 시 plugin:webview|set_webview_zoom IPC 가 정확한 value 로 호출된다', async () => {
    // Tauri 2 freezes `__TAURI_INTERNALS__.invoke` as
    // `writable:false, configurable:false` and `__TAURI_INTERNALS__`
    // itself non-writable on `window`, so the spec cannot replace the
    // IPC with a JS stub. The bridge.js IIFE records every
    // `set_webview_zoom` invoke into a dev-hook-only buffer alongside
    // the real call; we drain that buffer here and assert on the
    // recorded entries. Stripped at release build time so production
    // never allocates the recorder.
    const captured = await browser.execute(() => {
      window.__mdDeskZoomInternals.takeIpcLog(); // clear any leftover from prior tests
      window.__mdDeskZoomInternals.pressKey('=', 'meta');
      return window.__mdDeskZoomInternals.takeIpcLog();
    });
    const zoomCalls = captured.filter(
      (c) => c.name === 'plugin:webview|set_webview_zoom'
    );
    expect(zoomCalls.length).toBe(1);
    expect(zoomCalls[0].args).toEqual({ value: 1.1 });
    // Cross-spec hygiene: applyZoom updated currentZoom even though the
    // real OS IPC fired too; reset so any later spec asserting on the
    // baseline isn't off by 0.1.
    await browser.execute(() => {
      window.__mdDeskZoomInternals.reset();
    });
  });

  // The previous capture test only exercises the key-press branch. Wheel
  // events route through a separate handler in bridge.js (a window-level
  // 'wheel' listener with passive:false + ctrl/meta gate). A regression
  // that drops the invoke on the wheel branch while keeping it on the
  // key branch would slip past the keyboard-only assertion. Capture
  // the IPC on a wheel-driven zoom too and pin the value.
  it('wheel zoom 도 plugin:webview|set_webview_zoom IPC 를 호출한다', async () => {
    const captured = await browser.execute(() => {
      // Reset to a known baseline so the wheel delta lands on a
      // deterministic step (1.0 + 0.5 = 1.5), independent of the prior
      // test's ending zoom level.
      window.__mdDeskZoomInternals.reset();
      window.__mdDeskZoomInternals.takeIpcLog(); // clear leftover entries from reset / prior tests
      // scrollWheel(-50, 'ctrl') → currentZoom + (-(-50) * 0.01) = 1.5
      window.__mdDeskZoomInternals.scrollWheel(-50, 'ctrl');
      return window.__mdDeskZoomInternals.takeIpcLog();
    });
    const zoomCalls = captured.filter(
      (c) => c.name === 'plugin:webview|set_webview_zoom'
    );
    expect(zoomCalls.length).toBe(1);
    expect(zoomCalls[0].args).toEqual({ value: 1.5 });
    // Reset for any future spec ordering.
    await browser.execute(() => {
      window.__mdDeskZoomInternals.reset();
    });
  });
});
