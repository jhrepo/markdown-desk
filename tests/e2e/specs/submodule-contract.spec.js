// Behavioral contract between Markdown Desk and the Markdown-Viewer submodule.
//
// The static counterpart (tests/unit/submodule-contract.test.mjs) pins that
// the submodule's anchors EXIST. This spec pins that they still BEHAVE the way
// our overrides assume — most importantly the live-reload render mechanism.
//
// Live reload works like this: the Rust watcher sets #markdown-editor.value and
// dispatches an `input` event (commands.rs js_update_tab). The submodule's own
// input handler (debouncedRender → renderMarkdown) is what actually repaints
// #markdown-preview. We never call renderMarkdown directly — it's closure-
// private inside the submodule's DOMContentLoaded wrapper. So if a submodule
// bump ever stops re-rendering on `input`, the editor text would update but the
// visible preview would freeze, and EVERY live-reload path silently breaks with
// no error. This spec is the canary for that.
//
// These tests touch no files and start no watcher, so they're order-independent
// and don't pollute the shared WatcherState (unlike the auto-refresh specs).

const REQUIRED_ELEMENTS = [
  { id: 'markdown-editor', tag: 'TEXTAREA', why: 'live-reload sink (js_update_tab sets .value)' },
  { id: 'markdown-preview', why: 'preview render target (bridge.js + toc.js)' },
  { id: 'file-input', tag: 'INPUT', why: 'open-file trigger (js_new_tab dispatches change)' },
  { id: 'tab-list', why: 'tab routing container (watcher active-tab match)' },
  { id: 'mobile-tab-list', why: 'mobile tab-switch refresh listener' },
];

describe('서브모듈 동작 계약 (live-reload 메커니즘 + DOM)', () => {
  beforeEach(async () => {
    // window.location.reload() is async at the WebDriver layer: the first poll
    // can fire before the reload tears down the old page (readyState still
    // 'complete', elements still mounted), so a naive waitUntil returns
    // immediately and the test body races the unfinished reload — reading a
    // torn-down DOM. Invalidate bridge.js's __bridgeTabPaths BEFORE reloading
    // and gate on it being re-installed AFTER, so we only proceed on the fresh
    // page. (Same guard auto-refresh-cold-start.spec.js documents.)
    await browser.execute(() => {
      try { localStorage.clear(); } catch {}
      try { delete window.__bridgeTabPaths; } catch {}
      window.location.reload();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          document.readyState === 'complete' &&
          !!window.__bridgeTabPaths &&
          !!document.getElementById('markdown-editor') &&
          !!document.getElementById('markdown-preview') &&
          document.querySelectorAll('#tab-list .tab-item').length >= 1
        ),
      { timeout: 8000, timeoutMsg: 'app did not boot (editor/preview/tab missing)' }
    );
  });

  it('우리 오버라이드가 의존하는 핵심 element 가 런타임에 모두 존재한다', async () => {
    const report = await browser.execute((required) => {
      return required.map((spec) => {
        const el = document.getElementById(spec.id);
        return { id: spec.id, present: !!el, tag: el ? el.tagName : null, why: spec.why };
      });
    }, REQUIRED_ELEMENTS);

    // Collect every breakage into one array so a submodule regression fails
    // with the full list of what broke (and why), not just the first element.
    // expect-webdriverio's toBe ignores a 2nd "message" arg, so we surface the
    // detail through the asserted value instead.
    const failures = [];
    for (const r of report) {
      if (!r.present) failures.push(`#${r.id} MISSING — breaks: ${r.why}`);
    }
    for (const spec of REQUIRED_ELEMENTS.filter((s) => s.tag)) {
      const r = report.find((x) => x.id === spec.id);
      if (r && r.present && r.tag !== spec.tag) {
        failures.push(`#${spec.id} WRONG TAG: got <${r.tag}>, want <${spec.tag}> — breaks: ${spec.why}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('editor 의 input 이벤트가 preview 재렌더를 트리거한다 (라이브 리로드의 심장)', async () => {
    // This is the EXACT path the watcher uses: set value, dispatch input,
    // expect the submodule to repaint #markdown-preview. If this regresses,
    // every live-reload scenario freezes the preview while the editor updates.
    const marker = 'CONTRACT_HEADING_' + Date.now();
    await browser.execute((text) => {
      const ed = document.getElementById('markdown-editor');
      ed.value = '# ' + text + '\n\nbody paragraph.\n';
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    }, marker);

    await browser.waitUntil(
      async () => {
        const html = await browser.execute(() =>
          document.getElementById('markdown-preview')?.innerHTML || '');
        return html.includes(marker);
      },
      { timeout: 5000, timeoutMsg: 'preview did not re-render after input event — live-reload mechanism is broken' }
    );

    // It must render the markdown to HTML, not just dump raw text: the heading
    // has to become a real <h1> the preview/TOC can work with.
    const renderedAsHeading = await browser.execute((text) => {
      const pv = document.getElementById('markdown-preview');
      if (!pv) return false;
      return Array.from(pv.querySelectorAll('h1')).some((h) => h.textContent.includes(text));
    }, marker);
    // (toc.js + preview rely on real <h1>, not styled raw text)
    expect(renderedAsHeading).toBe(true);
  });

  it('연속 input 이 preview 를 최신 내용으로 수렴시킨다 (디바운스 후 최종값)', async () => {
    // The watcher can fire several updates in a row (bursty external writes).
    // The submodule's debounced render must converge on the LAST value, not
    // get stuck on an intermediate one.
    const last = 'CONVERGE_' + Date.now();
    await browser.execute((finalText) => {
      const ed = document.getElementById('markdown-editor');
      ['# step one\n', '# step two\n', '# ' + finalText + '\n'].forEach((v) => {
        ed.value = v;
        ed.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }, last);

    await browser.waitUntil(
      async () => {
        const txt = await browser.execute(() =>
          document.getElementById('markdown-preview')?.textContent || '');
        return txt.includes(last) && !txt.includes('step one') && !txt.includes('step two');
      },
      { timeout: 5000, timeoutMsg: 'preview did not converge on the final input value' }
    );
  });

  it('렌더된 preview 가 toc.js 가 읽는 h1~h4 노드를 만든다', async () => {
    // toc.js extracts the drawer entries via
    // preview.querySelectorAll('h1, h2, h3, h4'). If the submodule's renderer
    // stops emitting real heading elements (e.g. switches to styled divs),
    // the TOC silently empties.
    await browser.execute(() => {
      const ed = document.getElementById('markdown-editor');
      ed.value = '# H1\n## H2\n### H3\n#### H4\n##### H5\n';
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await browser.waitUntil(
      async () => {
        const counts = await browser.execute(() => {
          const pv = document.getElementById('markdown-preview');
          if (!pv) return null;
          return {
            h1: pv.querySelectorAll('h1').length,
            h2: pv.querySelectorAll('h2').length,
            h3: pv.querySelectorAll('h3').length,
            h4: pv.querySelectorAll('h4').length,
          };
        });
        return counts && counts.h1 >= 1 && counts.h2 >= 1 && counts.h3 >= 1 && counts.h4 >= 1;
      },
      { timeout: 5000, timeoutMsg: 'preview did not emit h1-h4 heading nodes for the TOC' }
    );
  });

  it('활성 탭이 watcher/bridge 가 쓰는 선택자로 도달 가능하다', async () => {
    // The watcher's js_update_tab and bridge.js refreshActiveFromDisk both
    // locate the live tab via exactly `#tab-list .tab-item.active`. Pin that
    // the boot state produces a single active tab reachable by that selector.
    const shape = await browser.execute(() => {
      const all = document.querySelectorAll('#tab-list .tab-item');
      const active = document.querySelectorAll('#tab-list .tab-item.active');
      const activeEl = active[0] || null;
      return {
        total: all.length,
        activeCount: active.length,
        hasTitle: activeEl ? !!activeEl.querySelector('.tab-title') : false,
        // data-path may be empty on the Welcome tab — only assert the attribute
        // is reachable, not that it's populated.
        canReadDataPath: activeEl ? activeEl.getAttribute('data-path') !== undefined : false,
      };
    });
    expect(shape.total).toBeGreaterThanOrEqual(1);
    expect(shape.activeCount).toBe(1);
    expect(shape.hasTitle).toBe(true);
  });
});
