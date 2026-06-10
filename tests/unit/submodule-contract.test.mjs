// Static contract guard between Markdown Desk and the Markdown-Viewer
// submodule. Run with: node --test tests/unit/submodule-contract.test.mjs
//
// WHY THIS EXISTS
// ---------------
// The app never modifies the submodule. Every custom behavior (live reload,
// tab routing, zoom, mermaid, reset, export) is layered on top via
// scripts/bridge.js, scripts/toc.js and the Rust-side eval() injections in
// src-tauri/src/commands.rs. All of those reach into the submodule's DOM by
// element id / localStorage key. If a submodule bump renames or removes one of
// those anchors, our overrides become silent no-ops — the editor stops
// auto-refreshing, tabs stop routing, etc., with no error anywhere.
//
// This test pins every submodule anchor our code depends on so that a breaking
// submodule update fails the FAST unit gate (node --test) with a precise
// message naming the consumer, instead of surfacing later as a flaky/confusing
// e2e failure or a user bug report. When you intentionally follow a submodule
// rename, update both the consumer AND the expectation here in the same commit.
//
// Scope: this is a STRUCTURAL contract (the anchor exists, with the right tag
// type). The BEHAVIORAL contract (input event re-renders the preview, tab
// switch re-renders, etc.) lives in tests/e2e/specs/submodule-contract.spec.js
// because it needs the running WebView.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SUBMODULE_DIR = resolve(REPO_ROOT, 'Markdown-Viewer');
const INDEX_HTML = resolve(SUBMODULE_DIR, 'index.html');
const SCRIPT_JS = resolve(SUBMODULE_DIR, 'script.js');
const COMMANDS_RS = resolve(REPO_ROOT, 'src-tauri', 'src', 'commands.rs');
const PREPARE_FRONTEND = resolve(REPO_ROOT, 'scripts', 'prepare-frontend.sh');

// Fail loudly (not silently skip) if the submodule isn't checked out: the
// build needs it too, so an uninitialized submodule must break CI here.
function readSubmoduleFile(path, label) {
  assert.ok(
    existsSync(path),
    `Markdown-Viewer submodule file missing: ${path}\n` +
      `Run \`git submodule update --init\` — ${label} is required for both ` +
      `the build and this contract test.`
  );
  return readFileSync(path, 'utf8');
}

// Return the opening tag (e.g. `<textarea id="markdown-editor" ...>`) that
// declares the given id, or null if no element carries it. Matches id="x"
// and id='x' with a word boundary so `markdown-editor` doesn't match
// `markdown-editor-foo`.
function findOpeningTagById(html, id) {
  const re = new RegExp(
    `<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=(["'])${escapeRe(id)}\\2[^>]*>`,
  );
  const m = html.match(re);
  if (!m) return null;
  return { tag: m[1].toLowerCase(), raw: m[0] };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------- Element-id contract (index.html) ----------------
// Each entry: the submodule element id our code reaches for, plus the
// consumer that breaks if it disappears. Keep this list in lockstep with
// `grep -roE "getElementById\\('[^']+'\\)" scripts src-tauri/src/commands.rs`.

const REQUIRED_IDS = [
  {
    id: 'markdown-editor',
    tag: 'textarea',
    consumer:
      "commands.rs js_update_tab/js_new_tab set .value here (the live-reload " +
      'sink); bridge.js reads it on every refresh',
  },
  {
    id: 'markdown-preview',
    consumer:
      'bridge.js (scroll/zoom) + toc.js (heading extraction) target the ' +
      'rendered preview here',
  },
  {
    id: 'file-input',
    tag: 'input',
    type: 'file',
    consumer:
      'commands.rs js_new_tab dispatches a synthetic `change` here to open ' +
      'files; the whole open-file path depends on it',
  },
  {
    id: 'tab-list',
    consumer:
      'bridge.js MutationObserver stamps data-path here and the watcher ' +
      'routes updates via `#tab-list .tab-item.active`',
  },
  {
    id: 'mobile-tab-list',
    consumer: 'bridge.js attaches the tab-switch refresh listener here',
  },
  {
    id: 'tab-reset-btn',
    consumer: 'bridge.js wires the reset-confirm flow to this button',
  },
  {
    id: 'mobile-tab-reset-btn',
    consumer: 'bridge.js wires the mobile reset-confirm flow to this button',
  },
  {
    id: 'mermaid-zoom-modal',
    consumer: 'bridge.js fixes WKWebView SVG sizing inside this modal',
  },
  {
    id: 'mermaid-modal-diagram',
    consumer: 'bridge.js observes/repairs the zoomed diagram inside this node',
  },
];

test('index.html exposes every element id our overrides depend on', () => {
  const html = readSubmoduleFile(INDEX_HTML, 'index.html');
  for (const spec of REQUIRED_IDS) {
    const found = findOpeningTagById(html, spec.id);
    assert.ok(
      found,
      `Submodule no longer exposes #${spec.id}.\n  Consumer: ${spec.consumer}\n` +
        `  Fix: update the consumer to the submodule's new id AND this list.`
    );
    if (spec.tag) {
      assert.equal(
        found.tag,
        spec.tag,
        `#${spec.id} changed element type: expected <${spec.tag}>, got <${found.tag}>.\n` +
          `  Consumer: ${spec.consumer}`
      );
    }
    if (spec.type) {
      assert.match(
        found.raw,
        new RegExp(`\\btype=(["'])${escapeRe(spec.type)}\\1`),
        `#${spec.id} is no longer type="${spec.type}".\n  Consumer: ${spec.consumer}`
      );
    }
  }
});

// The dead-anchor canary. commands.rs historically referenced #preview (which
// the submodule does NOT define — the real id is #markdown-preview), so the
// preview-pane scroll-to-top after open/live-reload was a silent no-op. If a
// future submodule ever DOES introduce a bare #preview, this assertion flips
// and forces us to reconcile commands.rs (which would then start targeting an
// unexpected element). Documents the drift instead of leaving it implicit.
test('index.html does NOT define a bare #preview (commands.rs drift canary)', () => {
  const html = readSubmoduleFile(INDEX_HTML, 'index.html');
  assert.equal(
    findOpeningTagById(html, 'preview'),
    null,
    'Submodule introduced a bare #preview element. commands.rs js_update_tab/' +
      'js_new_tab reference getElementById("preview") — reconcile them (they ' +
      'were meant to target #markdown-preview).'
  );
});

// ---------------- cross-language contract (commands.rs → submodule) ----------------
// The Rust side injects JS into the WebView (eval) that reaches submodule
// elements by id — e.g. js_new_tab dispatches `change` on #file-input and
// js_update_tab writes #markdown-editor. Those ids are string literals on the
// Rust side, invisible to any JS tooling, so a submodule rename would leave
// them dangling with the `if (el)` guards swallowing the failure silently.
// This test extracts every getElementById('…') id referenced in commands.rs
// and asserts the submodule still defines it. (Regression origin: commands.rs
// referenced a bare #preview that the submodule never had, so the preview
// scroll-to-top after open/live-reload was permanently dead — see the canary
// above.)

function extractGetElementByIds(source) {
  const ids = new Set();
  const re = /getElementById\(['"]([^'"]+)['"]\)/g;
  let m;
  while ((m = re.exec(source)) !== null) ids.add(m[1]);
  return [...ids];
}

test('every getElementById id injected by commands.rs exists in the submodule', () => {
  const rs = readFileSync(COMMANDS_RS, 'utf8');
  const html = readSubmoduleFile(INDEX_HTML, 'index.html');
  const ids = extractGetElementByIds(rs);
  // Sanity: the extraction actually found the ids we know commands.rs injects.
  assert.ok(
    ids.includes('markdown-editor') && ids.includes('file-input'),
    `extraction sanity failed — commands.rs getElementById ids parsed: ${JSON.stringify(ids)}`
  );
  const missing = ids.filter((id) => findOpeningTagById(html, id) === null);
  assert.deepEqual(
    missing,
    [],
    `commands.rs injects getElementById for id(s) the submodule does not define: ` +
      `${JSON.stringify(missing)}.\n  Each is a dangling reference whose \`if (el)\` ` +
      `guard fails silently. Reconcile commands.rs with the submodule's real ids.`
  );
});

// ---------------- localStorage-key contract (script.js) ----------------
// seedSession() in the e2e suite and the restore-on-restart path both write/
// read keys the submodule owns. If the submodule renames these, our seeding
// and tab restoration silently target dead keys.

const REQUIRED_LS_KEYS = [
  {
    key: 'markdownViewerTabs',
    consumer:
      'e2e seedSession + bridge GC read/write the tab array here; the whole ' +
      'tab session lives under this key',
  },
  {
    key: 'markdownViewerActiveTab',
    consumer: 'e2e seedSession marks the active tab id here',
  },
];

test('script.js still owns the localStorage keys our seed/restore depend on', () => {
  const js = readSubmoduleFile(SCRIPT_JS, 'script.js');
  for (const spec of REQUIRED_LS_KEYS) {
    assert.ok(
      js.includes(`'${spec.key}'`) || js.includes(`"${spec.key}"`),
      `Submodule no longer uses localStorage key "${spec.key}".\n` +
        `  Consumer: ${spec.consumer}\n` +
        `  Fix: update the consumer (and e2e seedSession) to the new key.`
    );
  }
});

// ---------------- runtime-class contract (script.js) ----------------
// bridge.js and the watcher select tabs via `.tab-item`, `.tab-item.active`
// and `.tab-title`, and read `data-tab-id`. These class/attr names are
// produced by the submodule's renderTabBar at runtime (not present in static
// index.html), so we pin them against script.js source. A rename here would
// break tab routing and the live-reload active-tab match.

const REQUIRED_TAB_TOKENS = [
  { token: "'tab-item'", consumer: 'bridge.js/watcher select `#tab-list .tab-item`' },
  { token: "'tab-title'", consumer: 'bridge.js reads the active tab title from `.tab-title`' },
  { token: 'data-tab-id', consumer: 'bridge.js keys the sidecar path map by data-tab-id' },
];

test('script.js still renders the tab class/attr tokens bridge.js selects on', () => {
  const js = readSubmoduleFile(SCRIPT_JS, 'script.js');
  for (const spec of REQUIRED_TAB_TOKENS) {
    assert.ok(
      js.includes(spec.token),
      `Submodule renderTabBar no longer emits ${spec.token}.\n` +
        `  Consumer: ${spec.consumer}`
    );
  }
  // The active-tab marker the watcher's `#tab-list .tab-item.active` match and
  // bridge.js's refreshActiveFromDisk both hinge on.
  assert.match(
    js,
    /'tab-item'\s*\+\s*\([^)]*\?\s*' active'/,
    "Submodule no longer appends ' active' to the active tab's className. " +
      'bridge.js refreshActiveFromDisk and the watcher select `.tab-item.active`.'
  );
});

// ---------------- build-asset contract (prepare-frontend.sh) ----------------
// Our build copies only a fixed set of submodule files into dist/
// (scripts/prepare-frontend.sh: index.html, script.js, styles.css, assets/).
// When a submodule bump makes script.js load a NEW sibling .js at runtime —
// a Web Worker (`new Worker`), a worker URL builder (`new URL("x.js", …)`), or
// `importScripts(...)` — that file is a hard runtime dependency: if it isn't in
// the copy list it 404s in the WebView. The preview pipeline's worker
// (preview-worker.js, added in the 3.7.x render re-engineering) degrades
// silently this way — large-doc rendering falls back to the main thread after
// the worker errors out, with console noise and a first-render stall.
//
// This is intentionally scoped to Worker/URL/importScripts loads, NOT every
// asset: <link rel="manifest"> and navigator.serviceWorker.register('sw.js')
// are PWA niceties that are inert/guarded in a Tauri shell, so we deliberately
// do not bundle them (a 404 there is harmless). A Worker is different — it is
// load-bearing for rendering — so it must be copied.

function extractWorkerJsAssets(source) {
  const assets = new Set();
  const patterns = [
    /new\s+Worker\(\s*['"]([^'"]+\.js)['"]/g, // direct literal Worker URL
    /new\s+URL\(\s*['"]([^'"]+\.js)['"]/g,     // worker URL builder (getPreviewWorkerUrl)
    /importScripts\(\s*['"]([^'"]+\.js)['"]/g, // inside-worker style loads
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      const ref = m[1];
      // Sibling files only: skip absolute/CDN URLs (https://…) and nested
      // paths — prepare-frontend.sh copies into dist/ root next to script.js,
      // so only same-dir bare filenames are in scope.
      if (ref.includes('://') || ref.includes('/')) continue;
      assets.add(ref);
    }
  }
  return [...assets];
}

// True if prepare-frontend.sh copies `$SUBMODULE_DIR/<file>` into the frontend
// dir (matches both `cp` and `cp -r`, single file or glob-free explicit copy).
function prepareFrontendCopies(sh, file) {
  const re = new RegExp(`cp\\b[^\\n]*\\$SUBMODULE_DIR/${escapeRe(file)}\\b`);
  return re.test(sh);
}

test('prepare-frontend.sh bundles every worker .js the submodule loads at runtime', () => {
  const js = readSubmoduleFile(SCRIPT_JS, 'script.js');
  const sh = readSubmoduleFile(PREPARE_FRONTEND, 'prepare-frontend.sh');
  const workerAssets = extractWorkerJsAssets(js);

  // Sanity / regex-rot guard: this submodule version is known to load
  // preview-worker.js via getPreviewWorkerUrl (`new URL("preview-worker.js")`).
  // If this fails, either the worker was renamed/removed upstream (update the
  // copy list AND this expectation in the same commit) or the extractor regex
  // rotted and is silently finding nothing.
  assert.ok(
    workerAssets.includes('preview-worker.js'),
    `Expected script.js to load preview-worker.js as a Worker, but the ` +
      `extractor found: ${JSON.stringify(workerAssets)}.\n` +
      `  If upstream renamed/removed the preview worker, update ` +
      `scripts/prepare-frontend.sh and this test together.`
  );

  const notCopied = workerAssets.filter((f) => !prepareFrontendCopies(sh, f));
  assert.deepEqual(
    notCopied,
    [],
    `script.js loads worker file(s) that scripts/prepare-frontend.sh does not ` +
      `copy into dist/: ${JSON.stringify(notCopied)}.\n` +
      `  These 404 in the WebView; the preview pipeline then errors out and ` +
      `falls back to main-thread rendering (console noise + first-render stall ` +
      `on large docs). Fix: add \`cp "$SUBMODULE_DIR/<file>" "$FRONTEND_DIR/"\` ` +
      `to prepare-frontend.sh.`
  );
});

// ---------------- inline-handler/CSP contract (prepare-frontend.sh → dist) ----------------
// Tauri injects our CSP via response headers and appends hash sources for its
// own init scripts. Per the CSP spec, hash/nonce sources invalidate
// 'unsafe-inline', so EVERY inline event handler attribute in dist/index.html
// is blocked in the WebView (script-src-attr violation) — silently.
// Markdown-Viewer 3.7.3 loads the bootstrap-icons CSS exclusively through one:
//   <link rel="preload" as="style" onload="this.onload=null;this.rel='stylesheet'">
// (its plain <link> twin sits inside <noscript>, which never applies in the
// JS-enabled WebView). The onload never fires, rel stays "preload", the icon
// font never loads, and every toolbar/UI glyph renders as a missing-glyph box
// while the rest of the app keeps working. prepare-frontend.sh must rewrite
// preload+onload style links into plain stylesheet links at build time.
// These tests run the REAL script and assert on the REAL dist output, so a
// submodule bump that changes the link's attribute order (defeating the
// rewrite) fails here — not in production. (Regression origin: v26.6.1.)

let distIndexCache = null;
function distIndexHtml() {
  if (distIndexCache === null) {
    // Run the real script into a throwaway directory, NOT the repo's dist/.
    // A default run here would rebuild dist/ in RELEASE mode (TAURI_ENV_DEBUG
    // unset → dev-hooks stripped); a later raw `cargo build` would then embed
    // that hookless frontend and the dev-hook-dependent e2e specs
    // (webview-zoom, update-banner) would silently self-skip while the gate
    // stays green. The override also keeps this test parallel-safe against
    // a concurrent `tauri build`'s own prepare-frontend run.
    const outDir = mkdtempSync(join(tmpdir(), 'md-desk-dist-'));
    execFileSync('bash', [PREPARE_FRONTEND], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      env: { ...process.env, MD_DESK_FRONTEND_DIR: outDir },
    });
    distIndexCache = readFileSync(resolve(outDir, 'index.html'), 'utf8');
  }
  return distIndexCache;
}

test('dist/index.html carries no inline event handlers (the WebView CSP blocks them all)', () => {
  const offenders = [...distIndexHtml().matchAll(/<[^>]*\son[a-z]+\s*=[^>]*>/gi)].map(
    (m) => m[0].slice(0, 160)
  );
  assert.deepEqual(
    offenders,
    [],
    `dist/index.html still contains inline event handler attribute(s); the ` +
      `WebView CSP silently blocks every one of them (script-src-attr). ` +
      `Extend the rewrite in scripts/prepare-frontend.sh to cover these tags.`
  );
});

test('dist/index.html loads bootstrap-icons via a plain stylesheet link (not preload+onload)', () => {
  // Strip <noscript> twins first — they never apply in the JS-enabled WebView,
  // so a stylesheet link found only there is still a broken icon font.
  const html = distIndexHtml().replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
  const links = [...html.matchAll(/<link\b[^>]*bootstrap-icons[^>]*>/gi)].map((m) => m[0]);
  assert.ok(
    links.length >= 1,
    'bootstrap-icons <link> disappeared from dist/index.html entirely — the ' +
      'prepare-frontend.sh rewrite must transform the link, never drop it.'
  );
  // A link still carrying onload= is NOT a live stylesheet, even though its
  // handler body contains the literal `this.rel='stylesheet'` — exclude those
  // before matching, or the broken preload link false-passes this test.
  const live = links.filter((l) => !/\bonload\s*=/.test(l));
  assert.ok(
    live.some((l) => /\srel=(["'])stylesheet\1/.test(l)),
    `bootstrap-icons is not loaded as a live stylesheet in dist/index.html.\n` +
      `  Found: ${JSON.stringify(links)}\n` +
      `  The preload+onload upgrade path is CSP-dead in the WebView; ` +
      `prepare-frontend.sh must rewrite it to rel="stylesheet".`
  );
});

// ---------------- desktop-shortcut contract (script.js ⇄ bridge.js shim) ----------------
// 3.7.3 gates its Ctrl/Cmd+T (new tab) and Ctrl/Cmd+W (close tab) bindings
// behind `typeof Neutralino !== 'undefined'` — upstream's own Neutralino
// desktop shell. The Tauri WebView has no Neutralino global, so those gated
// bindings are permanently dead here; bridge.js compensates by intercepting
// Cmd+T/W and re-dispatching the WEB bindings (Alt+Shift+T/W) the submodule
// handles unconditionally. This pins both halves of that assumption:
//  - the gate still exists (if upstream un-gates Cmd+T/W, the bridge shim
//    becomes redundant double-handling — remove it together with this pin);
//  - the Alt+Shift web bindings still exist (if upstream renames them, the
//    shim re-dispatches into the void and the shortcuts die silently again).

test('script.js still gates Cmd+T/W behind Neutralino and keeps the Alt+Shift web bindings', () => {
  const js = readSubmoduleFile(SCRIPT_JS, 'script.js');
  assert.match(
    js,
    /const isDesktop = typeof Neutralino !== 'undefined'/,
    'Submodule no longer gates desktop shortcuts behind Neutralino. ' +
      'If upstream un-gated Cmd+T/W, the bridge.js Cmd+T/W shim now ' +
      'double-handles them — remove the shim and this pin together.'
  );
  for (const key of ['t', 'w']) {
    assert.ok(
      js.includes(`e.altKey && e.shiftKey && e.key.toLowerCase() === "${key}"`),
      `Submodule dropped/renamed the Alt+Shift+${key.toUpperCase()} web binding ` +
        `that bridge.js's Cmd+${key.toUpperCase()} shim re-dispatches to — ` +
        `the shortcut is silently dead again. Update the shim and this pin.`
    );
  }
});

// ---------------- sanitization contract (script.js render paths) ----------------
// The WebView CSP allows 'unsafe-inline'/'unsafe-eval' for the submodule's own
// machinery, so DOMPurify in the preview render path is the ONLY XSS defense
// between untrusted markdown and the DOM. 3.7.x split rendering across a Web
// Worker (preview-worker.js, which does NOT sanitize) and the main thread —
// the worker's HTML is only safe because the main thread re-sanitizes every
// block before insertion. A submodule bump that drops or bypasses that
// re-sanitization would be invisible to every other test here (DOM anchors
// unchanged, rendering still works) while silently removing the defense line.

test('script.js sanitizes BOTH render paths through DOMPurify before DOM insertion', () => {
  const js = readSubmoduleFile(SCRIPT_JS, 'script.js');
  // The sanitizer itself: DOMPurify-backed and hard-failing when absent
  // (a silent fallback to raw HTML would be the worst possible behavior).
  const decl = js.match(/function sanitizePreviewHtml\s*\(/);
  assert.ok(
    decl,
    'Submodule dropped/renamed sanitizePreviewHtml — re-audit the render ' +
      'paths for a new sanitization entry point before accepting the bump.'
  );
  // Scope the next two assertions to THIS function's body: script.js throws
  // the same "DOMPurify is not defined" message from another function too,
  // so a whole-file match could be satisfied by code that isn't the
  // sanitizer at all.
  const bodyStart = js.indexOf('{', decl.index);
  let depth = 0;
  let bodyEnd = bodyStart;
  for (let i = bodyStart; i < js.length; i += 1) {
    if (js[i] === '{') depth += 1;
    else if (js[i] === '}' && (depth -= 1) === 0) {
      bodyEnd = i;
      break;
    }
  }
  const body = js.slice(bodyStart, bodyEnd + 1);
  assert.ok(
    body.includes('DOMPurify.sanitize(html, PREVIEW_SANITIZE_OPTIONS)'),
    'sanitizePreviewHtml no longer routes through DOMPurify with the preview ' +
      'options — the only XSS defense line moved or weakened.'
  );
  assert.ok(
    body.includes('DOMPurify is not defined'),
    'sanitizePreviewHtml no longer hard-fails when DOMPurify is missing — ' +
      'a silent raw-HTML fallback would disable the defense line unnoticed.'
  );
  // Worker path: blocks rendered off-thread MUST be re-sanitized on the main
  // thread before insertion (preview-worker.js itself has no DOMPurify).
  assert.ok(
    js.includes('sanitizePreviewHtml(block.html'),
    'Worker-rendered preview blocks are no longer re-sanitized on the main ' +
      'thread before DOM insertion — worker output reaches the DOM raw.'
  );
  // Main-thread path: the synchronous fallback renderer sanitizes too.
  // The needle must include the assignment: a bare `sanitizePreviewHtml(html)`
  // also matches the DECLARATION `function sanitizePreviewHtml(html) {`,
  // which made this assertion vacuous — it would pass forever even with the
  // call site gone.
  assert.ok(
    js.includes('const sanitizedHtml = sanitizePreviewHtml('),
    'Main-thread render path no longer sanitizes the marked output before ' +
      'committing it to the preview.'
  );
});
