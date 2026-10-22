const test = require("node:test");
const assert = require("node:assert/strict");
const { paginateSearch, isGitHubQueryFailure, PAGE_SIZE, MIN_PAGE_SIZE, EMPTY_RETRIES } = require("../live-search.mjs");

const q = "assignee:me is:issue is:open";
const items = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, url: `https://github.com/o/r/issues/${i + 1}` }));
// The exact error GitHub returned for the 71-issue page (server.log, 2026-10-22).
const somethingWentWrong = () => Object.assign(new Error("[...]"), { graphqlErrors: [{ message: "Something went wrong while executing your query on 2026-10-22T15:12:44Z. Please include `C781:286412:14DF31D:1E449A1:6ADA27E9` when reporting this issue." }] });
const silentEmpty = () => ({ issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] });

// A fake GitHub search with offset cursors like the real ones ("cursor:25" in base64).
// `answer(call)` may return an Error to throw, a page to send instead, or nothing for the real page.
function github(all, answer = () => {}) {
  const calls = [];
  const fetchPage = async (after, first) => {
    const call = { after, first, offset: after ? Number(Buffer.from(after, "base64").toString().split(":")[1]) : 0 };
    calls.push(call);
    const override = answer(call, calls.length);
    if (override instanceof Error) throw override;
    if (override) return override;
    const nodes = all.slice(call.offset, call.offset + first), end = call.offset + nodes.length;
    return { issueCount: all.length, pageInfo: { hasNextPage: end < all.length, endCursor: nodes.length ? Buffer.from(`cursor:${end}`).toString("base64") : null }, nodes };
  };
  return { fetchPage, calls };
}

test("asks for small pages and returns every result, in order", async () => {
  const all = items(71), gh = github(all);
  assert.deepEqual(await paginateSearch(gh.fetchPage, { q }), all);
  assert.equal(PAGE_SIZE, 25);
  assert.deepEqual(gh.calls.map((c) => [c.offset, c.first]), [[0, 25], [25, 25], [50, 25]]);
});

test("a page GitHub cannot run is retried at half the size from the same place", async () => {
  // Model the real failure: GitHub rejects any page holding more than 10 of these issues.
  const all = items(30), logged = [];
  const gh = github(all, (c) => (c.first > 10 ? somethingWentWrong() : undefined));
  assert.deepEqual(await paginateSearch(gh.fetchPage, { q, log: (m) => logged.push(m) }), all);
  assert.deepEqual(gh.calls.map((c) => [c.offset, c.first]), [[0, 25], [0, 12], [0, 6], [6, 6], [12, 6], [18, 6], [24, 6]]);
  assert.deepEqual(logged, ["GitHub could not run a page of 25; retrying that page at 12", "GitHub could not run a page of 12; retrying that page at 6"]);
});

test("GitHub failing at every page size throws instead of returning a partial list", async () => {
  const gh = github(items(71), (c) => (c.offset >= 25 ? somethingWentWrong() : undefined));
  await assert.rejects(paginateSearch(gh.fetchPage, { q }), (e) => {
    assert.match(e.message, /^GitHub search "assignee:me is:issue is:open" failed at page size 5: /);
    assert.ok(isGitHubQueryFailure(e.cause));
    return true;
  });
  // 25 at offset 0 succeeds, then 25 -> 12 -> 6 -> 5 at offset 25, and no further.
  assert.deepEqual(gh.calls.map((c) => [c.offset, c.first]), [[0, 25], [25, 25], [25, 12], [25, 6], [25, MIN_PAGE_SIZE]]);
});

test("other errors are not retried and pass through untouched", async () => {
  const forbidden = Object.assign(new Error("forbidden"), { graphqlErrors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
  const revoked = Object.assign(new Error("GitHub rejected the token"), { code: 401 }); // server.mjs answers 401 on e.code
  for (const err of [forbidden, revoked, new Error("502 Bad Gateway: <html>")]) {
    const gh = github(items(10), () => err);
    await assert.rejects(paginateSearch(gh.fetchPage, { q }), (e) => e === err);
    assert.equal(gh.calls.length, 1);
  }
});

test("a silent empty page after GitHub said there was more is asked again", async () => {
  const all = items(60), logged = [], gh = github(all, (c, n) => (c.offset === 25 && n === 2 ? silentEmpty() : undefined));
  assert.deepEqual(await paginateSearch(gh.fetchPage, { q, log: (m) => logged.push(m) }), all);
  assert.deepEqual(gh.calls.map((c) => c.offset), [0, 25, 25, 50]);
  assert.deepEqual(logged, ["GitHub returned 1 empty page at result 26 before this one; asking again recovered it"]);
});

test("a later page that stays empty is an error, never a short list", async () => {
  const gh = github(items(60), (c) => (c.offset === 25 ? silentEmpty() : undefined));
  await assert.rejects(paginateSearch(gh.fetchPage, { q }), /returned an empty page 3 times after 25 of 60 results/);
  assert.equal(gh.calls.length, 1 + EMPTY_RETRIES + 1);
});

test("an empty first page is asked again before it is believed", async () => {
  const all = items(3), flaky = github(all, (c, n) => (n === 1 ? silentEmpty() : undefined));
  assert.deepEqual(await paginateSearch(flaky.fetchPage, { q }), all);
  assert.equal(flaky.calls.length, 2);

  // A list that really is empty costs two extra calls per poll and is not logged.
  const none = github([]), logged = [];
  assert.deepEqual(await paginateSearch(none.fetchPage, { q, log: (m) => logged.push(m) }), []);
  assert.equal(none.calls.length, 1 + EMPTY_RETRIES);
  assert.deepEqual(logged, []);
});

test("results that do not add up to issueCount are an error", async () => {
  // Order shifted between pages: page two repeats an item from page one.
  const all = items(30), gh = github(all, (c) => (c.offset === 25 ? { issueCount: 30, pageInfo: { hasNextPage: false, endCursor: "x" }, nodes: all.slice(24, 29) } : undefined));
  await assert.rejects(paginateSearch(gh.fetchPage, { q }), /returned 29 distinct results but reported 30/);
});

test("nodes the token cannot see count toward issueCount but are left out", async () => {
  const all = [...items(4), null], gh = github(all);
  assert.deepEqual(await paginateSearch(gh.fetchPage, { q }), items(4));
});

test("only GitHub's own query failures count as retryable", () => {
  assert.equal(isGitHubQueryFailure(somethingWentWrong()), true);
  assert.equal(isGitHubQueryFailure(Object.assign(new Error(), { graphqlErrors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })), false);
  assert.equal(isGitHubQueryFailure(new Error("Something went wrong while executing your query")), false);
  assert.equal(isGitHubQueryFailure(undefined), false);
});
