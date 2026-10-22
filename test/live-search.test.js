const test = require("node:test");
const assert = require("node:assert/strict");
const { paginateSearch, createLiveSearch, graphqlError, isGitHubQueryFailure, PAGE_SIZE, MIN_PAGE_SIZE, EMPTY_RETRIES, RESULT_LIMIT } = require("../live-search.mjs");

const q = "assignee:me is:issue is:open";
const items = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, url: `https://github.com/o/r/issues/${i + 1}` }));
// The exact error GitHub returned for the 71-issue page (server.log, 2026-10-22), thrown
// the way client.graphql in server.mjs throws it.
const wentWrong = { message: "Something went wrong while executing your query on 2026-10-22T15:12:44Z. Please include `C781:286412:14DF31D:1E449A1:6ADA27E9` when reporting this issue." };
const somethingWentWrong = () => graphqlError([wentWrong]);
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

test("a list that exactly fills its pages ends without an extra call", async () => {
  // GitHub answers hasNextPage: false on an exactly full last page (probe: 5 issues after cursor 66 of 71).
  for (const n of [PAGE_SIZE, 2 * PAGE_SIZE]) {
    const all = items(n), gh = github(all);
    assert.deepEqual(await paginateSearch(gh.fetchPage, { q }), all);
    assert.equal(gh.calls.length, n / PAGE_SIZE);
  }
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
  const forbidden = graphqlError([{ type: "FORBIDDEN", message: "Resource not accessible by integration" }]);
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

test("a cursor that does not move is an error, not a loop", async () => {
  const stuck = { issueCount: 50, pageInfo: { hasNextPage: true, endCursor: "same" }, nodes: items(25) };
  const gh = github(items(50), (c) => (c.after === "same" ? { ...stuck, nodes: items(50).slice(25) } : stuck));
  await assert.rejects(paginateSearch(gh.fetchPage, { q }), /did not advance past cursor same/);
  assert.equal(gh.calls.length, 2);
});

test("past GitHub's 1000-result cap the cut is logged", async () => {
  const all = items(RESULT_LIMIT + 1), logged = [], gh = github(all);
  assert.deepEqual(await paginateSearch(gh.fetchPage, { q, log: (m) => logged.push(m) }), all.slice(0, RESULT_LIMIT));
  assert.equal(gh.calls.length, RESULT_LIMIT / PAGE_SIZE);
  assert.deepEqual(logged, ["GitHub reports 1001 results but search stops at 1000; the rest are not shown"]);
});

test("a list that had results is believed empty only when a second fetch agrees", async () => {
  const search = createLiveSearch();
  let list = items(3), flake = false;
  const gh = github([], () => (flake ? silentEmpty() : { issueCount: list.length, pageInfo: { hasNextPage: false, endCursor: list.length ? "c" : null }, nodes: list }));
  assert.equal((await search("k", gh.fetchPage, { q })).length, 3);

  // GitHub answers empty on every retry of this fetch: an error, so the page keeps its last list.
  flake = true;
  await assert.rejects(search("k", gh.fetchPage, { q }), (e) => e.doubtedEmpty && /found nothing 3 times, but found 3 last time/.test(e.message));
  // The next fetch has the results again.
  flake = false;
  assert.equal((await search("k", gh.fetchPage, { q })).length, 3);

  // The list really empties: one fetch is doubted, the next one is believed.
  list = [];
  await assert.rejects(search("k", gh.fetchPage, { q }), (e) => e.doubtedEmpty);
  assert.deepEqual(await search("k", gh.fetchPage, { q }), []);
  assert.deepEqual(await search("k", gh.fetchPage, { q }), []);
});

test("a list never seen with results is believed empty at once, and other errors keep the memory", async () => {
  const search = createLiveSearch();
  assert.deepEqual(await search("empty", github([]).fetchPage, { q }), []);

  await search("k", github(items(2)).fetchPage, { q });
  await assert.rejects(search("k", github([], () => new Error("502 Bad Gateway")).fetchPage, { q }), /502/);
  await assert.rejects(search("k", github([]).fetchPage, { q }), (e) => e.doubtedEmpty);
});

test("only GitHub's own query failures count as retryable", () => {
  assert.equal(isGitHubQueryFailure(somethingWentWrong()), true);
  assert.equal(isGitHubQueryFailure(graphqlError([{ type: "RATE_LIMITED", message: "API rate limit exceeded" }])), false);
  // A smaller page would not fix the FORBIDDEN half, so the pair is not retried.
  assert.equal(isGitHubQueryFailure(graphqlError([wentWrong, { type: "FORBIDDEN", message: "Resource not accessible by integration" }])), false);
  assert.equal(isGitHubQueryFailure(graphqlError([])), false);
  assert.equal(isGitHubQueryFailure(new Error("Something went wrong while executing your query")), false);
  assert.equal(isGitHubQueryFailure(undefined), false);
  // Gateway timeouts, as client.gh throws them (server.log had twelve 502/504s on 2026-10-22).
  assert.equal(isGitHubQueryFailure(Object.assign(new Error("502 : <html>"), { status: 502 })), true);
  assert.equal(isGitHubQueryFailure(Object.assign(new Error("504 : <!DOCTYPE html>"), { status: 504 })), true);
  assert.equal(isGitHubQueryFailure(Object.assign(new Error("500 Internal Server Error"), { status: 500 })), false);
  assert.equal(isGitHubQueryFailure(Object.assign(new Error("403 Forbidden"), { status: 403 })), false);
});

test("a gateway timeout on a page is retried at half the size, like a query GitHub could not run", async () => {
  const all = items(30);
  const gh = github(all, (c, n) => (n === 1 ? Object.assign(new Error("504 Gateway Timeout"), { status: 504 }) : undefined));
  assert.deepEqual(await paginateSearch(gh.fetchPage, { q }), all);
  assert.deepEqual(gh.calls.map((c) => [c.offset, c.first]), [[0, 25], [0, 12], [12, 12], [24, 12]]);
});

test("a list that changes while paging is fetched again instead of missing the new result", async () => {
  // 30 results; after the first page a new issue lands at the front, so page 2 reports 31
  // and repeats the boundary item. The old code deduped down to 30 and dropped the new one.
  const before = items(30), after = [{ number: 99, url: "https://github.com/o/r/issues/99" }, ...before];
  let changed = false;
  const gh = github(before, (c) => {
    if (!changed && c.offset > 0) { changed = true; return github(after).fetchPage(Buffer.from(`cursor:${c.offset}`).toString("base64"), c.first); }
    if (changed) return github(after).fetchPage(c.after, c.first);
  });
  const got = await paginateSearch(gh.fetchPage, { q });
  assert.equal(got.length, 31);
  assert.ok(got.some((n) => n.number === 99));
});

test("a list that keeps changing while paging fails rather than returning a guess", async () => {
  let n = 30;
  const fetchPage = async (after, first) => { n++; const all = items(n), offset = after ? Number(Buffer.from(after, "base64").toString().split(":")[1]) : 0;
    const nodes = all.slice(offset, offset + first); return { issueCount: n, pageInfo: { hasNextPage: offset + nodes.length < n, endCursor: Buffer.from(`cursor:${offset + nodes.length}`).toString("base64") }, nodes }; };
  await assert.rejects(paginateSearch(fetchPage, { q }), /kept changing while paging/);
});

test("overlapping fetches of the same list share one, so they cannot finish out of order", async () => {
  const search = createLiveSearch();
  let calls = 0, release;
  const gate = new Promise((r) => (release = r));
  const fetchPage = async (after, first) => { calls++; await gate; return github(items(3)).fetchPage(after, first); };
  const a = search("k", fetchPage, { q }), b = search("k", fetchPage, { q });
  release();
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
  // Once it finishes, the next fetch is a fresh one.
  await search("k", fetchPage, { q });
  assert.equal(calls, 2);
});

test("separate live searches never share a fetch, so one token cannot be handed another's results", async () => {
  // server.mjs keeps one createLiveSearch() per client (per token); the same query on two
  // of them must reach each token's own fetchPage.
  const broad = createLiveSearch(), narrow = createLiveSearch();
  let release; const gate = new Promise((r) => (release = r));
  const calls = { broad: 0, narrow: 0 };
  const fetcher = (who, n) => async (after, first) => { calls[who]++; await gate; return github(items(n)).fetchPage(after, first); };
  const a = broad("same query", fetcher("broad", 5), { q }), b = narrow("same query", fetcher("narrow", 2), { q });
  release();
  assert.equal((await a).length, 5);
  assert.equal((await b).length, 2);
  assert.deepEqual(calls, { broad: 1, narrow: 1 });
});
