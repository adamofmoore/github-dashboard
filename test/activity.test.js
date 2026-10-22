const test = require("node:test");
const assert = require("node:assert/strict");
const { createActivity, belongsIn, localDay, shift, today, CONFIRM_MS, CHECK_ITEMS } = require("../activity.mjs");
const { searchLane } = require("../ratelimit.mjs");

// Issues API shapes as GitHub returned them on 2026-10-22, with the repo renamed.
const REPO = "https://api.github.com/repos/acme/web";
const MERGED_PR = { number: 101, title: "A PR", html_url: "https://github.com/acme/web/pull/101", user: { login: "me" }, assignees: [], created_at: "2026-10-21T04:47:13Z", closed_at: "2026-10-21T05:16:31Z", state: "closed", pull_request: { merged_at: "2026-10-21T05:16:31Z" }, repository_url: REPO };
const CLOSED_ISSUE = { number: 202, title: "An issue", html_url: "https://github.com/acme/web/issues/202", user: { login: "me" }, assignees: [{ login: "me" }], created_at: "2026-10-21T00:06:39Z", closed_at: "2026-10-21T00:38:35Z", state: "closed", pull_request: null, repository_url: REPO };
const MERGED_DAY = localDay(MERGED_PR.pull_request.merged_at), CLOSED_DAY = localDay(CLOSED_ISSUE.closed_at);
const EMPTY = { total_count: 0, incomplete_results: false, items: [] };
const found = (...items) => ({ total_count: items.length, incomplete_results: false, items });

test("belongsIn reads each metric's own field from the issues API shape", () => {
  assert.equal(belongsIn("prsMerged", "me", MERGED_PR, true, MERGED_DAY, MERGED_DAY), true);
  assert.equal(belongsIn("prsMerged", "me", MERGED_PR, true, shift(MERGED_DAY, 1), shift(MERGED_DAY, 1)), false, "other day");
  assert.equal(belongsIn("prsMerged", "someone", MERGED_PR, true, MERGED_DAY, MERGED_DAY), false, "other author");
  assert.equal(belongsIn("prsMerged", "me", { ...MERGED_PR, pull_request: { merged_at: null } }, true, MERGED_DAY, MERGED_DAY), false, "closed unmerged");
  assert.equal(belongsIn("issuesClosed", "me", CLOSED_ISSUE, false, CLOSED_DAY, CLOSED_DAY), true);
  assert.equal(belongsIn("issuesClosed", "me", { ...CLOSED_ISSUE, assignees: [] }, false, CLOSED_DAY, CLOSED_DAY), false, "unassigned");
  assert.equal(belongsIn("issuesClosed", "me", { ...CLOSED_ISSUE, state: "open", closed_at: null }, false, CLOSED_DAY, CLOSED_DAY), false, "reopened");
  assert.equal(belongsIn("issuesClosed", "me", CLOSED_ISSUE, true, CLOSED_DAY, CLOSED_DAY), false, "an issue is not a PR");
  assert.equal(belongsIn("issuesOpened", "me", CLOSED_ISSUE, false, localDay(CLOSED_ISSUE.created_at), localDay(CLOSED_ISSUE.created_at)), true);
  assert.equal(belongsIn("prsOpened", "me", MERGED_PR, true, localDay(MERGED_PR.created_at), localDay(MERGED_PR.created_at)), true);
});

// A dashboard over a fake GitHub: `answer(url)` returns a search reply, an issue, or { status }.
function dashboard(answer) {
  const lane = searchLane({ gapMs: 0 }), cache = { data: {}, fetchedAt: {}, emptyAt: {}, save() {} }, asked = [];
  const reply = (url) => () => { const a = answer(url), status = a.status || 200; return { status, ok: status < 300, headers: new Headers(), text: async () => JSON.stringify(a) }; };
  const c = {
    me: async () => "me",
    async gh(url, init, prio = { background: false }) {
      asked.push(new URL(url).pathname);
      const { res, body } = new URL(url).pathname.startsWith("/search/") ? await lane.request(reply(url), prio) : await (async () => { const res = reply(url)(); return { res, body: await res.text() }; })();
      if (!res.ok) throw Object.assign(new Error(`${res.status}`), { status: res.status });
      return JSON.parse(body);
    },
  };
  const { dailyData } = createActivity({ cacheFor: () => cache, laneFor: () => lane });
  return { c, lane, cache, asked, dailyData };
}
const searchOf = (url) => decodeURIComponent(new URL(url).searchParams.get("q") || "");
const settle = () => new Promise((r) => setImmediate(r));

test("regression: a page request that joins the warm loop's fetch finishes instead of deadlocking", async () => {
  const d = dashboard((url) => (searchOf(url).includes("merged") ? found(MERGED_PR) : EMPTY));
  let endOther;
  const other = d.lane.whileUser(() => new Promise((r) => (endOther = r))); // another page request is running
  const warm = d.dailyData(d.c, MERGED_DAY, MERGED_DAY, true, true); // so the warm loop's searches queue behind it
  await settle();
  const page = d.lane.whileUser(() => d.dailyData(d.c, MERGED_DAY, MERGED_DAY, false)); // and this one needs the same spans
  const outcome = await Promise.race([page.then(() => "finished"), new Promise((r) => setTimeout(() => r("stuck"), 500))]);
  assert.equal(outcome, "finished");
  assert.equal((await page).metrics.prsMerged[MERGED_DAY].length, 1);
  endOther(); await other; await warm;
});

test("an empty answer for a range whose cached item is still there keeps the cache and fails", async () => {
  const d = dashboard((url) => (url.includes("/search/") ? EMPTY : MERGED_PR));
  const k = `prsMerged:${MERGED_DAY}`, before = [{ repo: "acme/web", number: 101, is_pr: true }];
  d.cache.data[k] = before; d.cache.fetchedAt[k] = 1;
  await assert.rejects(d.dailyData(d.c, MERGED_DAY, MERGED_DAY, true, true), /kept answering with no results for prsMerged/);
  assert.equal(d.cache.data[k], before);
  assert.ok(d.asked.includes("/repos/acme/web/issues/101"), "the item was read from the issues API");
});

test("an empty answer is believed when every cached item has really left the range", async () => {
  const d = dashboard((url) => (url.includes("/search/") ? EMPTY : { ...CLOSED_ISSUE, state: "open", closed_at: null }));
  const k = `issuesClosed:${CLOSED_DAY}`;
  d.cache.data[k] = [{ repo: "acme/web", number: 202, is_pr: false }]; d.cache.fetchedAt[k] = 1;
  const r = await d.dailyData(d.c, CLOSED_DAY, CLOSED_DAY, true, true);
  assert.deepEqual(r.metrics.issuesClosed[CLOSED_DAY], []);
  assert.deepEqual(d.cache.data[k], []);
  assert.ok(d.cache.fetchedAt[k] > 1, "settled");
});

test("when more items are cached than are read, an empty answer does not wipe them", async () => {
  // Every sampled item was reopened, but the ones past the sample were never read.
  const d = dashboard((url) => (url.includes("/search/") ? EMPTY : { ...CLOSED_ISSUE, state: "open", closed_at: null }));
  const k = `issuesClosed:${CLOSED_DAY}`, before = Array.from({ length: CHECK_ITEMS + 1 }, (_, i) => ({ repo: "acme/web", number: 300 + i, is_pr: false }));
  d.cache.data[k] = before; d.cache.fetchedAt[k] = 1;
  const r = await d.dailyData(d.c, CLOSED_DAY, CLOSED_DAY, true, true);
  assert.equal(r.metrics.issuesClosed[CLOSED_DAY], before);
  assert.equal(d.cache.data[k], before);
});

test("an empty answer nothing can check settles a past day only when one CONFIRM_MS later agrees", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const day = shift(today(), -3), k = `prsMerged:${day}`;
  let reply = EMPTY;
  const d = dashboard((url) => (searchOf(url).includes("merged") ? reply : found()));
  await d.dailyData(d.c, day, day, false, true);
  assert.equal(d.cache.fetchedAt[k], undefined, "not settled on one burst of empties");
  assert.ok(d.cache.emptyAt[k]);
  t.mock.timers.tick(CONFIRM_MS / 2);
  await d.dailyData(d.c, day, day, false, true);
  assert.equal(d.cache.fetchedAt[k], undefined, "still too close together");
  t.mock.timers.tick(CONFIRM_MS / 2);
  await d.dailyData(d.c, day, day, false, true);
  assert.ok(d.cache.fetchedAt[k], "two answers CONFIRM_MS apart agree, so it settles");
  assert.equal(d.cache.emptyAt[k], undefined);
  // And a day that turns out not to be empty is saved as soon as the real answer comes.
  const day2 = shift(today(), -4), k2 = `prsMerged:${day2}`;
  await d.dailyData(d.c, day2, day2, false, true);
  reply = found({ ...MERGED_PR, pull_request: { merged_at: `${day2}T12:00:00` } });
  await d.dailyData(d.c, day2, day2, false, true);
  assert.equal(d.cache.data[k2].length, 1);
  assert.ok(d.cache.fetchedAt[k2]);
  assert.equal(d.cache.emptyAt[k2], undefined);
});

test("a day already settled empty counts as the earlier answer, so Refresh doesn't unsettle it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const day = shift(today(), -10), k = `prsMerged:${day}`, settledAt = Date.now() - 2 * CONFIRM_MS;
  const d = dashboard(() => EMPTY);
  d.cache.data[k] = []; d.cache.fetchedAt[k] = settledAt;
  await d.dailyData(d.c, day, day, true, true);
  assert.ok(d.cache.fetchedAt[k] > settledAt);
  assert.equal(d.cache.emptyAt[k], undefined);
});
