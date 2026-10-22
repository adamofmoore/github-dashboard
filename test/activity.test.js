const test = require("node:test");
const assert = require("node:assert/strict");
const { createActivity, belongsIn, localDay, shift, today, startOfDay, CONFIRM_MS, CHECK_ITEMS } = require("../activity.mjs");
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
      if (!new URL(url).pathname.startsWith("/search/") && answer(url).code === 429) throw Object.assign(new Error("GitHub API is rate-limited"), { code: 429 }); // as the API gate fails
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

test("an empty answer for a range whose cached item is still there keeps the cache, and says so", async () => {
  const d = dashboard((url) => (url.includes("/search/") ? EMPTY : MERGED_PR));
  const k = `prsMerged:${MERGED_DAY}`, before = [{ repo: "acme/web", number: 101, is_pr: true }];
  d.cache.data[k] = before; d.cache.fetchedAt[k] = 1;
  const r = await d.dailyData(d.c, MERGED_DAY, MERGED_DAY, true, true);
  assert.deepEqual(r.stale, [`prsMerged ${MERGED_DAY}..${MERGED_DAY}`]);
  assert.equal(r.metrics.prsMerged[MERGED_DAY], before, "shows the saved items");
  assert.equal(d.cache.data[k], before);
  assert.equal(d.cache.fetchedAt[k], undefined, "not fresh, so it is asked again next time");
  assert.deepEqual(r.metrics.issuesClosed[MERGED_DAY], [], "the other metrics still refreshed");
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
  assert.deepEqual(r.pending, [k], "and says these saved counts await confirmation");
  assert.deepEqual(r.stale, [], "which is not the same as search provably answering wrong");
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

test("regression: a settled day whose forced refresh fails is asked again on the next normal load", async () => {
  // Copilot's case: the earlier stale-range test stamped fetchedAt = 1, already stale, so it missed this.
  const d = dashboard((url) => (url.includes("/search/") ? EMPTY : MERGED_PR));
  const k = `prsMerged:${MERGED_DAY}`, before = [{ repo: "acme/web", number: 101, is_pr: true }];
  d.cache.data[k] = before; d.cache.fetchedAt[k] = Date.now(); // fetched long after that day ended
  assert.equal((await d.dailyData(d.c, MERGED_DAY, MERGED_DAY, true, true)).stale.length, 1);
  assert.equal(d.cache.fetchedAt[k], undefined, "no longer fresh");
  assert.equal(d.cache.data[k], before, "but the saved items stay");
  const asked = d.asked.length;
  const again = await d.dailyData(d.c, MERGED_DAY, MERGED_DAY, false, true);
  assert.ok(d.asked.slice(asked).some((p) => p.startsWith("/search/")), "the normal load asked search again");
  assert.equal(again.stale.length, 1, "and still reports the range as stale");
});

test("regression: an unconfirmed empty on a settled day is confirmed by a normal load CONFIRM_MS later", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const d = dashboard((url) => (url.includes("/search/") ? EMPTY : { ...CLOSED_ISSUE, state: "open", closed_at: null }));
  const k = `issuesClosed:${CLOSED_DAY}`, before = Array.from({ length: CHECK_ITEMS + 1 }, (_, i) => ({ repo: "acme/web", number: 400 + i, is_pr: false }));
  d.cache.data[k] = before; d.cache.fetchedAt[k] = Date.now();
  await d.dailyData(d.c, CLOSED_DAY, CLOSED_DAY, true, true); // forced refresh: unverifiable empty
  assert.equal(d.cache.data[k], before);
  assert.equal(d.cache.fetchedAt[k], undefined, "held, and no longer fresh");
  t.mock.timers.tick(CONFIRM_MS);
  await d.dailyData(d.c, CLOSED_DAY, CLOSED_DAY, false, true); // a normal load, ten minutes on
  assert.deepEqual(d.cache.data[k], [], "the second empty answer, far enough apart, settles it");
  assert.ok(d.cache.fetchedAt[k]);
});

test("regression: an empty answer disproved by a readable item does not count toward a later confirmation", async (t) => {
  // Copilot's sequence: unverifiable empty at T+0, the item becomes readable and proves the
  // range non-empty at T+5min, then it is unreadable again at T+10min. The T+0 empty must
  // not combine with the T+10 one to erase the saved item.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let itemReply = { status: 403 };
  const d = dashboard((url) => (url.includes("/search/") ? EMPTY : itemReply));
  const k = `prsMerged:${MERGED_DAY}`, before = [{ repo: "acme/web", number: 101, is_pr: true }];
  d.cache.data[k] = before; d.cache.fetchedAt[k] = Date.now();
  await d.dailyData(d.c, MERGED_DAY, MERGED_DAY, true, true); // T+0: unreadable, so unverifiable; held
  assert.ok(d.cache.emptyAt[k]);
  t.mock.timers.tick(CONFIRM_MS / 2); itemReply = MERGED_PR;
  const mid = await d.dailyData(d.c, MERGED_DAY, MERGED_DAY, false, true); // T+5: the item is still there
  assert.equal(mid.stale.length, 1);
  assert.equal(d.cache.emptyAt[k], undefined, "the pending empty was disproved");
  t.mock.timers.tick(CONFIRM_MS / 2); itemReply = { status: 403 };
  await d.dailyData(d.c, MERGED_DAY, MERGED_DAY, false, true); // T+10: unreadable again
  assert.equal(d.cache.data[k], before, "saved item kept: a new confirmation window started");
  assert.equal(d.cache.fetchedAt[k], undefined);
});

test("regression: a range too big for one search splits even when GitHub times out on it", async () => {
  // Copilot's case: the oversized parent reply is incomplete every time, the children are fine.
  const d = dashboard((url) => {
    const q = searchOf(url), [from, to] = (q.match(/:(\d{4}-\d{2}-\d{2})T.*\.\.(\d{4}-\d{2}-\d{2})T/) || []).slice(1);
    if (from !== to) return { total_count: 1500, incomplete_results: true, items: [] };
    return q.includes("merged") && from === MERGED_DAY ? found(MERGED_PR) : EMPTY;
  });
  const r = await d.dailyData(d.c, shift(MERGED_DAY, -1), MERGED_DAY, true, true);
  assert.deepEqual(r.stale, []);
  assert.equal(r.metrics.prsMerged[MERGED_DAY].length, 1);
});

test("regression: two callers sharing a fetch apply its result once, so a confirmation sticks", async () => {
  // Copilot's case: the warm loop and a page request await the same fetch; the second used to
  // re-apply it, see the fresh stamp the first had just written, and unsettle the day again.
  const day = shift(today(), -3), k = `prsMerged:${day}`;
  const d = dashboard(() => EMPTY);
  d.cache.data[k] = []; d.cache.emptyAt[k] = Date.now() - CONFIRM_MS - 1; // an empty seen over ten minutes ago
  await Promise.all([d.dailyData(d.c, day, day, false, true), d.dailyData(d.c, day, day, false)]);
  assert.equal(d.asked.filter((p) => p.startsWith("/search/")).length, 8, "one shared fetch: 4 metrics, 2 asks each");
  assert.ok(d.cache.fetchedAt[k], "confirmed and settled");
  assert.equal(d.cache.emptyAt[k], undefined);
});

test("regression: a range's invalidation is saved even when a later metric fails the request", async () => {
  // Copilot's case: issuesClosed comes back unreliable, then prsOpened errors, so
  // dailyData throws; the cleared fresh stamp must reach disk before that.
  const d = dashboard((url) => {
    if (!url.includes("/search/")) return CLOSED_ISSUE;
    const q = searchOf(url);
    return q.includes("is:pr") && q.includes("created:") ? { status: 500 } : EMPTY;
  });
  const k = `issuesClosed:${CLOSED_DAY}`, saved = [];
  d.cache.data[k] = [{ repo: "acme/web", number: 202, is_pr: false }]; d.cache.fetchedAt[k] = Date.now();
  d.cache.save = () => saved.push(JSON.parse(JSON.stringify(d.cache.fetchedAt)));
  await assert.rejects(d.dailyData(d.c, CLOSED_DAY, CLOSED_DAY, true, true));
  assert.ok(saved.length, "the cache was saved");
  assert.equal(saved[saved.length - 1][k], undefined, "with the stamp already cleared");
});

test("regression: an empty seen before a day ended can't confirm the finished day", async (t) => {
  // Copilot's case: yesterday was cached empty at noon, and today's answers are empty but
  // unverifiable. Noon says nothing about yesterday evening, so a new window starts.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const day = shift(today(), -1), noon = startOfDay(day).getTime() + 12 * 3600e3;
  for (const [field, data] of [["fetchedAt", []], ["emptyAt", [{ repo: "acme/web", number: 101, is_pr: true }]]]) {
    const d = dashboard((url) => (url.includes("/search/") ? EMPTY : { status: 403 }));
    const k = `prsMerged:${day}`;
    d.cache.data[k] = data; d.cache[field][k] = noon;
    await d.dailyData(d.c, day, day, true, true);
    assert.equal(d.cache.fetchedAt[k], undefined, `${field} at noon: not settled`);
    assert.equal(d.cache.emptyAt[k], Date.now(), `${field} at noon: the confirmation window starts now`);
    assert.equal(d.cache.data[k], data, `${field} at noon: saved items kept`);
  }
});

test("regression: a rate-limited item check is inconclusive, so search can still answer", async () => {
  // Copilot's case: one false-empty search answer, the item read is rate-limited (REST
  // core spent past the patience), and search's own retry has the real result.
  let searches = 0;
  const d = dashboard((url) => {
    if (!url.includes("/search/")) return { code: 429 };
    return searchOf(url).includes("merged") && ++searches > 1 ? found(MERGED_PR) : EMPTY;
  });
  const k = `prsMerged:${MERGED_DAY}`;
  d.cache.data[k] = [{ repo: "acme/web", number: 101, is_pr: true }];
  const r = await d.dailyData(d.c, MERGED_DAY, MERGED_DAY, true, true);
  assert.equal(r.metrics.prsMerged[MERGED_DAY].length, 1, "the retry's real answer is saved");
  assert.deepEqual(r.stale, []);
  assert.ok(d.cache.fetchedAt[k]);
});
