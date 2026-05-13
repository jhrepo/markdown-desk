// Unit tests for pure helpers extracted from scripts/bridge.js.
// Run with: node --test tests/unit/bridge-helpers.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helpers = require('../../scripts/bridge-helpers.js');

// ---------------- shouldRunBackgroundCheck ----------------
// Contract: returns true when enough time has elapsed since the last
// update check. The raw argument is what localStorage would hand back
// (a string or null) — the helper must normalize it without throwing.

test('shouldRunBackgroundCheck: returns true when no prior check exists', () => {
  assert.equal(helpers.shouldRunBackgroundCheck(null, 1_000_000_000_000, 86_400_000), true);
});

test('shouldRunBackgroundCheck: returns true when last check is older than interval', () => {
  const now = 1_000_000_000_000;
  const interval = 86_400_000; // 24h in ms
  const last = String(now - interval - 1);
  assert.equal(helpers.shouldRunBackgroundCheck(last, now, interval), true);
});

test('shouldRunBackgroundCheck: returns false when last check is within interval', () => {
  const now = 1_000_000_000_000;
  const interval = 86_400_000;
  const last = String(now - 3600_000); // 1h ago
  assert.equal(helpers.shouldRunBackgroundCheck(last, now, interval), false);
});

test('shouldRunBackgroundCheck: treats malformed values (non-number) as no-check', () => {
  assert.equal(helpers.shouldRunBackgroundCheck('not-a-number', 1_000_000_000_000, 86_400_000), true);
  assert.equal(helpers.shouldRunBackgroundCheck('', 1_000_000_000_000, 86_400_000), true);
});

test('shouldRunBackgroundCheck: treats zero or negative stored timestamp as no-check', () => {
  // Guards against clock skew / accidental writes of 0.
  assert.equal(helpers.shouldRunBackgroundCheck('0', 1_000_000_000_000, 86_400_000), true);
  assert.equal(helpers.shouldRunBackgroundCheck('-500', 1_000_000_000_000, 86_400_000), true);
});

test('shouldRunBackgroundCheck: exact-boundary elapsed triggers check (>=)', () => {
  const now = 1_000_000_000_000;
  const interval = 86_400_000;
  assert.equal(
    helpers.shouldRunBackgroundCheck(String(now - interval), now, interval),
    true,
    'elapsed === interval should count as due'
  );
});

test('shouldRunBackgroundCheck: future timestamp does not lock out checks', () => {
  // Clock skew (manual time change / NTP sync) can land a future value in
  // localStorage. Without a guard, nowMs - last < 0 < intervalMs always
  // evaluates false and the user never gets update checks again. Treat
  // "last is in the future" as "no valid record, re-check".
  const now = 1_000_000_000_000;
  const interval = 86_400_000;
  assert.equal(helpers.shouldRunBackgroundCheck(String(now + interval), now, interval), true);
  assert.equal(helpers.shouldRunBackgroundCheck(String(now + 1), now, interval), true);
});

// ---------------- getExportBaseName ----------------
// Contract: given the active tab's displayed title (or null when no tab
// is active), return a safe base filename without the .md extension.

test('getExportBaseName: strips .md extension (lowercase)', () => {
  assert.equal(helpers.getExportBaseName('notes.md'), 'notes');
});

test('getExportBaseName: strips .MD extension (uppercase)', () => {
  assert.equal(helpers.getExportBaseName('notes.MD'), 'notes');
});

test('getExportBaseName: preserves non-.md extensions', () => {
  assert.equal(helpers.getExportBaseName('log.txt'), 'log.txt');
});

test('getExportBaseName: returns "document" for null/empty/whitespace', () => {
  assert.equal(helpers.getExportBaseName(null), 'document');
  assert.equal(helpers.getExportBaseName(''), 'document');
  assert.equal(helpers.getExportBaseName('   '), 'document');
});

test('getExportBaseName: trims outer whitespace from the title', () => {
  assert.equal(helpers.getExportBaseName('  report.md  '), 'report');
});

test('getExportBaseName: falls back to "document" when stripping leaves nothing', () => {
  // A file literally named ".md" — stripping leaves empty, must not produce
  // a file whose name is just a dot or empty.
  assert.equal(helpers.getExportBaseName('.md'), 'document');
});

// ---------------- clampZoom ----------------
// Contract: clamp a numeric zoom level to [min, max]. Non-finite / null
// inputs collapse to the default (1.0) so a single bad write to
// localStorage can't strand the user at an unrecoverable zoom level.

test('clampZoom: keeps values inside range untouched', () => {
  assert.equal(helpers.clampZoom(1.0, 0.3, 3.0), 1.0);
  assert.equal(helpers.clampZoom(0.5, 0.3, 3.0), 0.5);
  assert.equal(helpers.clampZoom(2.5, 0.3, 3.0), 2.5);
});

test('clampZoom: clamps below min and above max', () => {
  assert.equal(helpers.clampZoom(0.1, 0.3, 3.0), 0.3);
  assert.equal(helpers.clampZoom(10, 0.3, 3.0), 3.0);
});

test('clampZoom: collapses non-finite / null inputs to 1.0', () => {
  assert.equal(helpers.clampZoom(NaN, 0.3, 3.0), 1.0);
  assert.equal(helpers.clampZoom(Infinity, 0.3, 3.0), 1.0);
  assert.equal(helpers.clampZoom(-Infinity, 0.3, 3.0), 1.0);
  assert.equal(helpers.clampZoom(null, 0.3, 3.0), 1.0);
  assert.equal(helpers.clampZoom(undefined, 0.3, 3.0), 1.0);
});

// ---------------- nextZoomStep ----------------
// Contract: given the current zoom level and a direction (+1 zoom in,
// -1 zoom out), return the next zoom level using a fixed 0.1 step,
// rounded to 2 decimals to avoid float drift on repeated presses.

test('nextZoomStep: +1 increases by 0.1, -1 decreases by 0.1', () => {
  assert.equal(helpers.nextZoomStep(1.0, +1), 1.1);
  assert.equal(helpers.nextZoomStep(1.0, -1), 0.9);
});

test('nextZoomStep: clamps to [0.3, 3.0]', () => {
  assert.equal(helpers.nextZoomStep(3.0, +1), 3.0);
  assert.equal(helpers.nextZoomStep(0.3, -1), 0.3);
});

test('nextZoomStep: avoids float drift over repeated presses', () => {
  // 1.0 + 0.1 + 0.1 + 0.1 raw = 1.3000000000000003 in IEEE 754.
  // The helper rounds to 2 decimals so the user-facing value stays clean
  // and equality checks in tests/UI labels don't break.
  let z = 1.0;
  z = helpers.nextZoomStep(z, +1);
  z = helpers.nextZoomStep(z, +1);
  z = helpers.nextZoomStep(z, +1);
  assert.equal(z, 1.3);
});

test('nextZoomStep: direction 0 returns current (no-op)', () => {
  assert.equal(helpers.nextZoomStep(1.2, 0), 1.2);
});

// ---------------- nextZoomFromWheel ----------------
// Contract: map a wheel event's deltaY into a zoom-level change.
// Same handler is hit by both trackpad pinch (synthetic ctrlKey + small
// deltaY) and mouse wheel + Ctrl/Cmd (real ctrlKey + large deltaY), so
// the helper must produce a sane step for both magnitudes.

test('nextZoomFromWheel: deltaY < 0 zooms in, deltaY > 0 zooms out', () => {
  assert.ok(helpers.nextZoomFromWheel(1.0, -10) > 1.0);
  assert.ok(helpers.nextZoomFromWheel(1.0, +10) < 1.0);
});

test('nextZoomFromWheel: deltaY = 0 returns current zoom unchanged', () => {
  assert.equal(helpers.nextZoomFromWheel(1.2, 0), 1.2);
});

test('nextZoomFromWheel: clamps to [0.3, 3.0] for extreme deltas', () => {
  assert.equal(helpers.nextZoomFromWheel(1.0, -100000), 3.0);
  assert.equal(helpers.nextZoomFromWheel(1.0, +100000), 0.3);
});

test('nextZoomFromWheel: small trackpad delta produces small change', () => {
  // A typical trackpad pinch frame emits deltaY of a few units. The step
  // must be small enough that pinch feels smooth, not jumpy.
  const out = helpers.nextZoomFromWheel(1.0, -3);
  assert.ok(out > 1.0 && out < 1.1, `expected gentle zoom-in, got ${out}`);
});

// ---------------- pickInitialViewMode ----------------
// Contract: choose the view mode a newly created tab should start in.
// Whitelisted to the three Markdown-Viewer modes; anything else falls
// back to the supplied default (and then to 'split' if even the fallback
// is bogus) so a corrupted localStorage value can't strand the user.

test('pickInitialViewMode: returns the saved value when it is a known mode', () => {
  assert.equal(helpers.pickInitialViewMode('editor', 'split'), 'editor');
  assert.equal(helpers.pickInitialViewMode('split', 'split'), 'split');
  assert.equal(helpers.pickInitialViewMode('preview', 'split'), 'preview');
});

test('pickInitialViewMode: falls back when saved is unknown', () => {
  assert.equal(helpers.pickInitialViewMode('foo', 'editor'), 'editor');
  assert.equal(helpers.pickInitialViewMode('', 'preview'), 'preview');
  assert.equal(helpers.pickInitialViewMode(null, 'split'), 'split');
  assert.equal(helpers.pickInitialViewMode(undefined, 'editor'), 'editor');
});

test("pickInitialViewMode: falls back to 'split' when both inputs are unknown", () => {
  assert.equal(helpers.pickInitialViewMode('bogus', 'also-bogus'), 'split');
  assert.equal(helpers.pickInitialViewMode(null, null), 'split');
});

test('pickInitialViewMode: rejects non-string saved values (objects, numbers)', () => {
  // Defensive against localStorage corruption (e.g., JSON written into a
  // key expected to hold a plain string).
  assert.equal(helpers.pickInitialViewMode(123, 'split'), 'split');
  assert.equal(helpers.pickInitialViewMode({}, 'split'), 'split');
  assert.equal(helpers.pickInitialViewMode([], 'split'), 'split');
});

// ---------------- isSafeVersionToken ----------------
// Contract mirrors `is_safe_version_token` in src-tauri/src/commands.rs.
// Both sides validate the updater feed's version token before splicing
// it into the GitHub release URL — JS guards the dev-server / e2e path
// where Tauri isn't around to enforce it, Rust guards the IPC boundary.
// If they drift, a malformed version could escape the markdown-desk repo
// URL space (`releases/tag/v<...>`) on one side but not the other.

test('isSafeVersionToken: accepts CalVer-shaped tokens', () => {
  assert.equal(helpers.isSafeVersionToken('26.5.1'), true);
  assert.equal(helpers.isSafeVersionToken('26.5.10'), true);
  assert.equal(helpers.isSafeVersionToken('1.0.0'), true);
});

test('isSafeVersionToken: rejects non-strings', () => {
  // The token can arrive from a Tauri command (always String) or the JS
  // banner-API (might be misused). Non-strings must fail closed.
  assert.equal(helpers.isSafeVersionToken(null), false);
  assert.equal(helpers.isSafeVersionToken(undefined), false);
  assert.equal(helpers.isSafeVersionToken(26.51), false);
  assert.equal(helpers.isSafeVersionToken({}), false);
});

test('isSafeVersionToken: rejects empty and overlong strings', () => {
  assert.equal(helpers.isSafeVersionToken(''), false);
  // Boundary: 32 chars must pass, 33 must fail — pinned the same way Rust does.
  assert.equal(helpers.isSafeVersionToken('1'.repeat(32)), true);
  assert.equal(helpers.isSafeVersionToken('1'.repeat(33)), false);
});

test('isSafeVersionToken: rejects letters / hyphens / shell metacharacters', () => {
  assert.equal(helpers.isSafeVersionToken('v26.5.1'), false);
  assert.equal(helpers.isSafeVersionToken('26.5.1a'), false);
  assert.equal(helpers.isSafeVersionToken('26.5.1-rc1'), false);
  assert.equal(helpers.isSafeVersionToken('26.5.1;ls'), false);
  assert.equal(helpers.isSafeVersionToken('26.5.1 && rm -rf'), false);
  assert.equal(helpers.isSafeVersionToken('26.5.1`whoami`'), false);
  assert.equal(helpers.isSafeVersionToken('26.5.1$(id)'), false);
  assert.equal(helpers.isSafeVersionToken('26.5.1|cat'), false);
});

test('isSafeVersionToken: rejects path-traversal payloads', () => {
  assert.equal(helpers.isSafeVersionToken('../etc/passwd'), false);
  assert.equal(helpers.isSafeVersionToken('26.5.1/extra'), false);
});

test('isSafeVersionToken: rejects dot-only and partial-dot inputs', () => {
  // These were a gap in the previous `^[0-9.]+$` regex — they're allowed
  // characters but not CalVer-shaped (no digits or empty segments).
  assert.equal(helpers.isSafeVersionToken('.'), false);
  assert.equal(helpers.isSafeVersionToken('..'), false);
  assert.equal(helpers.isSafeVersionToken('...'), false);
  assert.equal(helpers.isSafeVersionToken('.5'), false);
  assert.equal(helpers.isSafeVersionToken('5.'), false);
  assert.equal(helpers.isSafeVersionToken('0..0'), false);
  assert.equal(helpers.isSafeVersionToken('.'.repeat(32)), false);
});

test('isSafeVersionToken: caps segment count at six', () => {
  assert.equal(helpers.isSafeVersionToken('1.2.3.4.5.6'), true);
  assert.equal(helpers.isSafeVersionToken('1.2.3.4.5.6.7'), false);
});

test('isSafeVersionToken: rejects Unicode digit categories', () => {
  // `\d` in the JS regex (with no `u` flag) only matches ASCII 0-9, mirroring
  // Rust's `is_ascii_digit`. A future refactor that adds the `u` flag or
  // switches to `\p{Nd}` would silently widen the accept set to include
  // Arabic-Indic ٠١٢ and fullwidth １２３ — those would splice into the
  // GitHub path and either 404 or obscure the audit trail. Pin the
  // rejection here.
  assert.equal(helpers.isSafeVersionToken('٠.١.٢'), false);
  assert.equal(helpers.isSafeVersionToken('１.２.３'), false);
});

// ---------------- buildReleaseUrl ----------------
// Contract: produce the GitHub release-tag URL for a validated version, or
// return null when the version fails the same whitelist. Centralizing
// the construction makes the regression surface a single function instead
// of every banner-href callsite spreading the format string.

test('buildReleaseUrl: returns the canonical tag URL for a valid version', () => {
  assert.equal(
    helpers.buildReleaseUrl('26.5.1'),
    'https://github.com/jhrepo/markdown-desk/releases/tag/v26.5.1'
  );
});

test('buildReleaseUrl: returns null for any version isSafeVersionToken rejects', () => {
  // Centralized rejection means callers don't have to remember to validate;
  // they can null-check the return value uniformly.
  assert.equal(helpers.buildReleaseUrl(''), null);
  assert.equal(helpers.buildReleaseUrl('.'), null);
  assert.equal(helpers.buildReleaseUrl('v26.5.1'), null);
  assert.equal(helpers.buildReleaseUrl('26.5.1;ls'), null);
  assert.equal(helpers.buildReleaseUrl('../etc/passwd'), null);
  assert.equal(helpers.buildReleaseUrl(null), null);
  assert.equal(helpers.buildReleaseUrl(undefined), null);
});

test('buildReleaseUrl: matches the Rust build_release_url contract', () => {
  // The Rust side asserts the same prefix + version concat. If either side
  // drifts, the link in the banner stops matching the URL the IPC opens.
  const version = '99.1.2';
  assert.equal(
    helpers.buildReleaseUrl(version),
    `https://github.com/jhrepo/markdown-desk/releases/tag/v${version}`
  );
});
