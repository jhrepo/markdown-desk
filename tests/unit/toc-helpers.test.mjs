// Unit tests for pure TOC helpers. Run with:
//   node --test tests/unit/toc-helpers.test.mjs
// Helpers are defined in scripts/toc.js which exposes itself as a CommonJS
// module when required from Node.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const toc = require('../../scripts/toc.js');

test('slugify: ASCII heading becomes kebab-case', () => {
  const used = new Set();
  assert.equal(toc.slugify('Hello World', used), 'hello-world');
});

test('slugify: duplicate headings are deduped with numeric suffix', () => {
  const used = new Set();
  assert.equal(toc.slugify('Hello', used), 'hello');
  assert.equal(toc.slugify('Hello', used), 'hello-1');
  assert.equal(toc.slugify('Hello', used), 'hello-2');
});

test('slugify: strips punctuation but keeps unicode letters', () => {
  const used = new Set();
  assert.equal(toc.slugify('코드 예제 #1', used), '코드-예제-1');
});

test('slugify: empty or punctuation-only heading falls back to section-N', () => {
  const used = new Set();
  assert.equal(toc.slugify('!!!', used), 'section');
  assert.equal(toc.slugify('???', used), 'section-1');
});

test('activeHeadingIndex: before the first heading returns -1', () => {
  const offsets = [100, 300, 800];
  assert.equal(toc.activeHeadingIndex(0, offsets), -1);
  assert.equal(toc.activeHeadingIndex(99, offsets), -1);
});

test('activeHeadingIndex: at or past a heading offset activates that heading', () => {
  const offsets = [100, 300, 800];
  assert.equal(toc.activeHeadingIndex(100, offsets), 0);
  assert.equal(toc.activeHeadingIndex(299, offsets), 0);
  assert.equal(toc.activeHeadingIndex(300, offsets), 1);
  assert.equal(toc.activeHeadingIndex(799, offsets), 1);
  assert.equal(toc.activeHeadingIndex(800, offsets), 2);
  assert.equal(toc.activeHeadingIndex(10000, offsets), 2);
});

test('activeHeadingIndex: empty offsets returns -1', () => {
  assert.equal(toc.activeHeadingIndex(500, []), -1);
});

test('computeScrollTarget: element at pane top => no scroll delta', () => {
  // elementTop equals paneTop → target equals currentScrollTop
  assert.equal(toc.computeScrollTarget(200, 200, 0), 0);
  assert.equal(toc.computeScrollTarget(200, 200, 500), 500);
});

test('computeScrollTarget: element below pane top => scroll down by delta', () => {
  // element is 300px below pane top, currently at scroll 100 → target 400
  assert.equal(toc.computeScrollTarget(500, 200, 100), 400);
});

test('computeScrollTarget: element above pane top => scroll up by delta', () => {
  // element is 150px above pane top, currently at scroll 1000 → target 850
  assert.equal(toc.computeScrollTarget(50, 200, 1000), 850);
});

test('computeScrollTarget: clamps to non-negative', () => {
  // Scrolling a tiny bit above pane start; should not return negative
  assert.equal(toc.computeScrollTarget(100, 200, 50), 0);
});

test('computeScrollTarget + activeHeadingIndex: active heading tracks scroll', () => {
  // Simulate pane at viewport y=100 with 3 headings whose viewport tops are
  // 150, 450, 950 (before any scroll inside the pane). Their scroll offsets
  // — where pane.scrollTop would pin them to pane top — are
  //   150 - 100 + 0 = 50
  //   450 - 100 + 0 = 350
  //   950 - 100 + 0 = 850
  const paneTop = 100;
  const scrollTop = 0;
  const headingTops = [150, 450, 950];
  const offsets = headingTops.map((top) =>
    toc.computeScrollTarget(top, paneTop, scrollTop)
  );
  assert.deepEqual(offsets, [50, 350, 850]);
  // Before scroll, the heading at offset 50 is the active one.
  assert.equal(toc.activeHeadingIndex(50, offsets), 0);
  // After scrolling just past heading 1 into heading 2.
  assert.equal(toc.activeHeadingIndex(400, offsets), 1);
});
