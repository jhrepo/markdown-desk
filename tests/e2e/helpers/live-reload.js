// Shared live-reload e2e helper.
//
// Apply an external file mutation and wait for live-reload to land it in
// #markdown-editor, re-applying the mutation if the watcher missed it. Two
// timing windows can swallow a single one-shot write so the editor never
// updates and a plain write + waitUntil would just time out:
//
//   1. Watcher startup — a watch that was just added (restore_watcher →
//      add_file → rebuild) has a brief FSEvents stream-startup window during
//      which the first write can be lost before the stream is active.
//   2. Debounce coalescing — a preceding write to the same file (e.g. save_file
//      writing the editor's content to disk) fires its own watcher event and
//      records the per-path debounce timestamp; an external write landing
//      within DEBOUNCE_MS (300) of it is coalesced away.
//
// Re-touching the file until the editor reflects the content is robust to both
// without a fixed settle that a slow/loaded CI could still outrun. Production is
// unaffected: nobody edits a file externally within a few hundred ms of opening
// or saving it, and the next real change is always caught.
//
// `mutate` may be sync or async (it is awaited). `browser` is the wdio global,
// available at call time inside specs and the modules they import.
export async function applyExternalEditUntilReflected(
  mutate,
  expectedContent,
  { attempts = 6, perAttempt = 1500 } = {}
) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    await mutate();
    try {
      await browser.waitUntil(
        async () => {
          const v = await browser.execute(
            () => document.getElementById('markdown-editor')?.value || ''
          );
          return v.trim() === expectedContent.trim();
        },
        { timeout: perAttempt }
      );
      return; // landed
    } catch (e) {
      lastErr = e; // missed/coalesced — re-apply
    }
  }
  throw (
    lastErr ||
    new Error('applyExternalEditUntilReflected: editor never reflected the edit')
  );
}
