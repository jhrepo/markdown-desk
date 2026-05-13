// 데스크탑 헤더의 view-toggle 버튼은 viewer 364cedd 리팩토링에서
// `.view-mode-btn[data-mode]` → `.view-toggle-btn[data-view-mode]`로 마크업이
// 바뀌었다. 셀렉터가 사라지면 isExisting 가드가 silent skip을 만들어 회귀를
//감추므로, 가드 대신 명시적 assert + 정확한 셀렉터를 쓴다.
const VIEW_BTN = (mode) => `.view-toggle-btn[data-view-mode="${mode}"]`;

describe('뷰 모드 전환', () => {
  it('Editor 모드에서 에디터가 표시된다', async () => {
    const editorBtn = await $(VIEW_BTN('editor'));
    await expect(editorBtn).toBeExisting();
    await editorBtn.click();
    await browser.pause(300);

    const editor = await $('#markdown-editor');
    await expect(editor).toBeDisplayed();
  });

  it('Preview 모드에서 프리뷰가 표시된다', async () => {
    const previewBtn = await $(VIEW_BTN('preview'));
    await expect(previewBtn).toBeExisting();
    await previewBtn.click();
    await browser.pause(300);

    const preview = await $('#markdown-preview');
    await expect(preview).toBeDisplayed();
  });

  it('Split 모드에서 에디터와 프리뷰 모두 표시된다', async () => {
    const splitBtn = await $(VIEW_BTN('split'));
    await expect(splitBtn).toBeExisting();
    await splitBtn.click();
    await browser.pause(300);

    const editor = await $('#markdown-editor');
    const preview = await $('#markdown-preview');
    await expect(editor).toBeDisplayed();
    await expect(preview).toBeDisplayed();
  });

  it('Editor/Preview 모드는 페인 inline width를 제거한다', async () => {
    // Story 1.3 (viewer): editor/preview 단독 모드 진입 시 split 모드에서 보존한
    // 페인의 inline width를 비워야 한다. 비우지 않으면 단독 모드에서 컨테이너
    // 가득 채우지 못하고, split 복귀 후에도 비율이 깨질 수 있다.
    await $(VIEW_BTN('split')).then((b) => b.click());
    await browser.pause(200);
    await $(VIEW_BTN('editor')).then((b) => b.click());
    await browser.pause(300);

    const editorPaneInline = await browser.execute(() => {
      const el = document.querySelector('.editor-pane');
      return el && el.style ? el.style.width : null;
    });
    expect(editorPaneInline === '' || editorPaneInline == null).toBe(true);
  });

  it('Editor → Preview → Split 순환 후에도 양 페인이 합리적인 폭으로 복원된다', async () => {
    // 회귀 가드: 탭 간/모드 간 전환에서 한쪽 페인 width가 0 또는 viewport 폭의
    // 90% 이상 같은 극단치로 굳어버리는 회귀(PR #68 계열 + viewer #93 라인번호
    // gutter 추가로 인한 폭 계산 영향)를 잡는다.
    //
    // 시작 시 splitter 위치를 50/50 으로 강제: 이전 spec 또는 사용자 드래그가
    // editor-pane / preview-pane 에 inline width 를 남겼다면 그 값이 split
    // 복귀 시 그대로 살아남아 본 회귀 가드의 합리적-폭 단언을 사실상
    // 우연 통과로 만든다. inline width 만 비워도 submodule 의 split 분기가
    // 다음 클릭에서 기본 분할로 다시 계산한다.
    await browser.execute(() => {
      document.querySelectorAll('.editor-pane, .preview-pane').forEach((p) => {
        if (p && p.style) p.style.width = '';
      });
    });
    await $(VIEW_BTN('split')).then((b) => b.click());
    await browser.pause(200);
    await $(VIEW_BTN('editor')).then((b) => b.click());
    await browser.pause(200);
    await $(VIEW_BTN('preview')).then((b) => b.click());
    await browser.pause(200);
    await $(VIEW_BTN('split')).then((b) => b.click());
    await browser.pause(300);

    const sizes = await browser.execute(() => {
      const e = document.querySelector('.editor-pane');
      const p = document.querySelector('.preview-pane');
      return {
        editorW: e ? e.getBoundingClientRect().width : 0,
        previewW: p ? p.getBoundingClientRect().width : 0,
        viewport: window.innerWidth,
      };
    });

    // 두 페인 모두 의미 있는 폭을 가져야 한다 — 100px 미만이면 사용자가
    // 실제로 입력/스크롤 불가능한 사실상 hidden 상태.
    expect(sizes.editorW).toBeGreaterThan(100);
    expect(sizes.previewW).toBeGreaterThan(100);

    // 한쪽이 viewport의 90% 이상을 차지하면 split이 아니라 사실상 단독 뷰.
    // 두 폭의 합은 viewport와 비슷해야 하고(splitter 두께 제외), 비율 극단치도 금지.
    const total = sizes.editorW + sizes.previewW;
    expect(total).toBeGreaterThan(sizes.viewport * 0.5);
    const smaller = Math.min(sizes.editorW, sizes.previewW);
    expect(smaller / sizes.viewport).toBeGreaterThan(0.1);
  });
});
