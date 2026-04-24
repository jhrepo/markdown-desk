describe('키보드 단축키', () => {
  // Cmd+S / Cmd+O coverage lives in Rust-side grep tests
  // (bridge_script_tests) because synthetic `dispatchEvent` doesn't reach
  // bridge.js's keydown listener in the Tauri WebKit runtime — the earlier
  // attempt to spy on `window.__TAURI_INTERNALS__.invoke` failed because
  // that object is defined with non-writable descriptors, and the fallback
  // `document.dispatchEvent(new KeyboardEvent(...))` never reaches the
  // marker listener either (sawKey stays null). The Cmd+R side-effect test
  // below works because hardReload() runs `window.location.reload()`, which
  // is observable via post-reload localStorage state regardless of how
  // precisely the event propagated.

  it('Cmd+R 는 hardReload 를 수행해 ephemeral 키는 지우고 global state 는 유지한다', async () => {
    // This test reloads the page mid-spec. Snapshot the real globalState,
    // add a unique test marker, and restore in finally — keeps
    // theme-dependent specs (theme.spec.js, etc.) clean.
    const preGlobal = await browser.execute(() =>
      localStorage.getItem('markdownViewerGlobalState')
    );

    await browser.execute((originalGlobal) => {
      localStorage.setItem('sc-test-ephemeral', 'should-go');
      const state = originalGlobal ? JSON.parse(originalGlobal) : {};
      state.__scTestMarker = 'keep-me';
      localStorage.setItem('markdownViewerGlobalState', JSON.stringify(state));
    }, preGlobal);

    try {
      await browser.execute(() => {
        const ev = new KeyboardEvent('keydown', {
          key: 'r',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(ev);
      });
      // window.location.reload() kicks in; wait for the page to come back.
      await browser.pause(1500);

      const post = await browser.execute(() => ({
        ephemeral: localStorage.getItem('sc-test-ephemeral'),
        marker: JSON.parse(
          localStorage.getItem('markdownViewerGlobalState') || '{}'
        ).__scTestMarker,
      }));
      expect(post.ephemeral).toBe(null);
      expect(post.marker).toBe('keep-me');
    } finally {
      await browser.execute((originalGlobal) => {
        if (originalGlobal !== null) {
          localStorage.setItem('markdownViewerGlobalState', originalGlobal);
        } else {
          localStorage.removeItem('markdownViewerGlobalState');
        }
        localStorage.removeItem('sc-test-ephemeral');
      }, preGlobal);
    }
  });
});
