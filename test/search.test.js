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
  const first = await firstPage(s.page, null, "prsMerged");
  assert.equal(first.total_count, 0);
  assert.equal(first.unconfirmed, true, "the caller is told nothing could check it");
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
  const first = await firstPage(s.page, async () => false, "issuesClosed");
  assert.equal(first.total_count, 0);
  assert.equal(first.unconfirmed, undefined, "checked against the items, so settled");
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
  pages[1].push(results(657, 100, 0)); // asked again to see whether the results shrank
  const s = search(pages);
  const first = await s.page(1);
  const items = await restPages(s.page, first, "prsOpened");
  assert.equal(items.length, 657);
  assert.deepEqual(new Set(items.map((i) => i.id)).size, 657);
  assert.deepEqual(s.asked, [1, 2, 3, 4, 1, 4, 5, 6, 7]);
});

test("a page that stays empty fails the whole fetch, so nothing partial is saved", async () => {
  const s = search({ 1: Array(EMPTY_TRIES + 1).fill(results(250)), 2: Array(EMPTY_TRIES).fill(EMPTY) });
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

test("an empty later page is the real end when a fresh first page shows the results shrank", async () => {
  // 101 results when paging started; one was reassigned before page 2 was read.
  const s = search({ 1: [results(101), results(100)], 2: [EMPTY] });
  const items = await restPages(s.page, await s.page(1), "issuesClosed");
  assert.equal(items.length, 100);
  assert.deepEqual(s.asked, [1, 2, 1]);
});

test("regression: when results shrink mid-paging, the pages already read are dropped and paging restarts", async () => {
  // Copilot's case: 250 results, page 3 comes back empty, and a fresh first page says 120.
  // Keeping pages 1-2 would save 200 items, some no longer matching.
  const s = search({ 1: [results(250, 100, 0), results(120, 100, 1000)], 2: [results(250, 100, 100), results(120, 20, 1100)], 3: [EMPTY] });
  const items = await restPages(s.page, await s.page(1), "issuesClosed");
  assert.equal(items.length, 120);
  assert.ok(items.every((i) => i.id >= 1000), "only items from the fresh pages");
  assert.deepEqual(s.asked, [1, 2, 3, 1, 2]);
});

test("a false empty first page during the shrink check does not end paging early", async () => {
  const s = search({ 1: [results(250), EMPTY, results(250)], 2: [EMPTY, results(250, 100, 100)], 3: [results(250, 50, 200)] });
  const items = await restPages(s.page, await s.page(1), "x");
  assert.equal(items.length, 250);
});

test("a reply GitHub flags incomplete is asked again, and fails if it stays incomplete", async () => {
  const partial = { ...results(40, 12), incomplete_results: true };
  let s = search({ 1: [partial, results(40)] });
  assert.equal((await firstPage(s.page, null, "x")).items.length, 40);
  s = search({ 1: Array(EMPTY_TRIES).fill(partial) });
  await assert.rejects(firstPage(s.page, null, "prsOpened"), /timed out on page 1/);
  s = search({ 1: [results(150)], 2: [{ ...results(150, 20, 100), incomplete_results: true }, results(150, 50, 100)] });
  assert.equal((await restPages(s.page, await s.page(1), "x")).length, 150);
});

test("regression: a later page reporting fewer results restarts paging, though it isn't empty", async () => {
  // Copilot's case: page 1 said 150; page 2 came back with 20 items and a total of 120,
  // after some first-page issues were unassigned. Joining them would keep the removed
  // ones and miss those that shifted onto page 1.
  const s = search({ 1: [results(150, 100, 0), results(120, 100, 1000)], 2: [results(120, 20, 100), results(120, 20, 1100)] });
  const items = await restPages(s.page, await s.page(1), "issuesClosed");
  assert.equal(items.length, 120);
  assert.ok(items.every((i) => i.id >= 1000), "only items from the fresh pages");
  assert.deepEqual(s.asked, [1, 2, 1, 2]);
});

test("a later page whose total wobbles is kept when a fresh first page still agrees", async () => {
  const s = search({ 1: [results(150), results(150)], 2: [results(149, 50, 100)] });
  const items = await restPages(s.page, await s.page(1), "x");
  assert.equal(items.length, 150);
  assert.deepEqual(s.asked, [1, 2, 1]);
});
