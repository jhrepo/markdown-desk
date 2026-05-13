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
