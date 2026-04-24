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
