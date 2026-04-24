describe('키보드 단축키', () => {
  async function stubInvokeAndDispatch(key) {
    // Replace the Tauri invoke bridge with a spy, dispatch the shortcut as
    // a KeyboardEvent (more reliable than browser.keys() for modifier keys
    // across OS boundaries in WebDriver), then read back what was invoked.
    // The caller is responsible for restoring invoke afterwards.
    return browser.execute((k) => {
      window.__sc_calls = [];
      window.__sc_origInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = function (cmd, args) {
        window.__sc_calls.push({ cmd: cmd, args: args });
        return Promise.resolve();
      };
      const ev = new KeyboardEvent('keydown', {
        key: k,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(ev);
    }, key);
  }

  async function readCallsAndRestore() {
    return browser.execute(() => {
      const calls = window.__sc_calls || [];
      if (window.__sc_origInvoke) {
        window.__TAURI_INTERNALS__.invoke = window.__sc_origInvoke;
        delete window.__sc_origInvoke;
      }
      delete window.__sc_calls;
      return calls;
    });
  }

  it('Cmd+S 는 save_file 을 해당 탭 제목/에디터 내용과 함께 호출한다', async () => {
    // Seed editor content so there's something to save.
    await browser.execute(() => {
      const ta = document.getElementById('markdown-editor');
      ta.value = '# hello shortcut test\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await browser.pause(200);

    await stubInvokeAndDispatch('s');
    await browser.pause(100);
    const calls = await readCallsAndRestore();

    const saveCalls = calls.filter((c) => c.cmd === 'save_file');
    expect(saveCalls.length).toBe(1);
    // title comes from the active tab, content from the editor
    expect(typeof saveCalls[0].args.title).toBe('string');
    expect(saveCalls[0].args.content).toContain('hello shortcut test');
  });

  it('Cmd+O 는 native_open_file 을 호출한다', async () => {
    await stubInvokeAndDispatch('o');
    await browser.pause(100);
    const calls = await readCallsAndRestore();

    expect(calls.some((c) => c.cmd === 'native_open_file')).toBe(true);
  });

  it('Cmd+R 는 hardReload 를 수행해 ephemeral 키는 지우고 global state 는 유지한다', async () => {
    // This test reloads the page mid-spec, so leaking localStorage into
    // subsequent specs is easy. Snapshot the real globalState, add a
    // unique test marker (not a theme), and restore the snapshot in
    // finally — keeps theme-dependent specs (theme.spec.js, etc.) clean.
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
