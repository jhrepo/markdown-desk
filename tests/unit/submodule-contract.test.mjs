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
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
