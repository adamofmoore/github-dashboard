const test = require("node:test");
const assert = require("node:assert/strict");
const { firstPage, restPages, EMPTY_TRIES } = require("../search.mjs");

// GitHub's false empty answer, as sent on 2026-10-22: 200 OK, nothing found, nothing flagged.
const EMPTY = { total_count: 0, incomplete_results: false, items: [] };
const results = (total, n = Math.min(total, 100), from = 0) => ({ total_count: total, incomplete_results: false, items: Array.from({ length: n }, (_, i) => ({ id: from + i })) });

// A fake search that answers each page from a script of replies, in order.
function search(script) {
  const asked = [];
  const left = Object.fromEntries(Object.entries(script).map(([p, replies]) => [p, [...replies]]));
  return { asked, page: async (p) => { asked.push(p); const r = left[p].shift(); if (!r) throw new Error(`unscripted ask for page ${p}`); return r; } };
}

test("regression: a false empty first page is asked again when nothing is known", async () => {
  // issuesClosed for 09-22..10-22 came back 0 on one ask and 549 on the next.
  const s = search({ 1: [EMPTY, results(549)] });
  const first = await firstPage(s.page, null, "issuesClosed");
  assert.equal(first.total_count, 549);
  assert.deepEqual(s.asked, [1, 1]);
});

test("with nothing known, two empty answers in a row are believed", async () => {
  const s = search({ 1: [EMPTY, EMPTY] });
  assert.equal((await firstPage(s.page, null, "prsMerged")).total_count, 0);
  assert.deepEqual(s.asked, [1, 1]);
});

test("an empty answer is retried while a known item is still in the range", async () => {
  const s = search({ 1: [EMPTY, EMPTY, results(26)] });
  let checks = 0;
  const first = await firstPage(s.page, async () => (checks++, true), "prsMerged");
  assert.equal(first.total_count, 26);
  assert.equal(checks, 1, "the item is read once, not once per retry");
  assert.equal(s.asked.length, 3);
});

test("search that keeps answering empty while a known item is still in range fails, rather than wiping the range", async () => {
  const s = search({ 1: Array(EMPTY_TRIES).fill(EMPTY) });
  await assert.rejects(firstPage(s.page, async () => true, "issuesClosed 2026-09-22..2026-10-22"), /GitHub search kept answering with no results for issuesClosed 2026-09-22\.\.2026-10-22/);
  assert.equal(s.asked.length, EMPTY_TRIES);
});

test("an empty answer is believed at once when the known item really left the range", async () => {
  const s = search({ 1: [EMPTY] });
  assert.equal((await firstPage(s.page, async () => false, "issuesClosed")).total_count, 0);
  assert.deepEqual(s.asked, [1], "no extra searches spent");
});

test("when the known items cannot all be read, an empty answer needs a second one to agree", async () => {
  // Five sampled items left the range but a sixth was never read, or one sits behind SSO.
  let s = search({ 1: [EMPTY, results(4)] });
  assert.equal((await firstPage(s.page, async () => null, "issuesClosed")).total_count, 4);
  s = search({ 1: [EMPTY, EMPTY] });
  assert.equal((await firstPage(s.page, async () => null, "issuesClosed")).total_count, 0);
  assert.deepEqual(s.asked, [1, 1]);
});

test("a first page with results is taken as is", async () => {
  const s = search({ 1: [results(3)] });
  let checked = false;
  assert.equal((await firstPage(s.page, async () => (checked = true), "x")).total_count, 3);
  assert.equal(checked, false);
});

test("regression: an empty page in the middle is asked again instead of dropped", async () => {
  // prsOpened for the month: 657 results over 7 pages, and one page came back empty,
  // which used to save 559.
  const pages = { 1: [results(657, 100, 0)] };
  for (let p = 2; p <= 7; p++) pages[p] = [results(657, p === 7 ? 57 : 100, (p - 1) * 100)];
  pages[4].unshift(EMPTY);
  const s = search(pages);
  const first = await s.page(1);
  const items = await restPages(s.page, first, "prsOpened");
  assert.equal(items.length, 657);
  assert.deepEqual(new Set(items.map((i) => i.id)).size, 657);
  assert.deepEqual(s.asked, [1, 2, 3, 4, 4, 5, 6, 7]);
});

test("a page that stays empty fails the whole fetch, so nothing partial is saved", async () => {
  const s = search({ 1: [results(250)], 2: Array(EMPTY_TRIES).fill(EMPTY) });
  const first = await s.page(1);
  await assert.rejects(restPages(s.page, first, "prsMerged"), /page 2 of 3/);
});

test("pages stop at GitHub's 1000-result cap", async () => {
  const pages = { 1: [results(1500)] };
  for (let p = 2; p <= 10; p++) pages[p] = [results(1500, 100, (p - 1) * 100)];
  const s = search(pages);
  const items = await restPages(s.page, await s.page(1), "x");
  assert.equal(items.length, 1000);
  assert.equal(s.asked.at(-1), 10);
});
