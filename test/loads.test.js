const test = require("node:test");
const assert = require("node:assert/strict");
const { hold, holds, plan, createLoader } = require("../public/loads.js");

const days = (a, b) => { const out = []; for (let d = a; d <= b; d++) out.push(String(d).padStart(2, "0")); return out; };
const tick = () => new Promise((r) => setImmediate(r));
// A fake server: each request waits until the test answers it, with one merged PR a day.
function server(windows) {
  const asked = [];
  const fetch = (from, to, force) => new Promise((resolve, reject) => asked.push({ from, to, force, resolve, reject }));
  const answer = (q, n = 1) => q.resolve({ days: days(+q.from, +q.to), metrics: { prsMerged: Object.fromEntries(days(+q.from, +q.to).map((d) => [d, Array(n).fill({ repo: "a/b" })])) } });
  const status = [];
  const loader = createLoader({ fetch, windows: () => windows.list, onStatus: (r) => status.push(r.running) });
  return { asked, answer, loader, status };
}
// Days 01..30, today is 30: Today needs 29..30, Yesterday 28..29, 7d 24..30, 30d 01..30.
const TILES = () => [days(29, 30), days(28, 29), days(24, 30), days(1, 30)];

test("plan: each day goes to the first window that needs it, as contiguous pieces", () => {
  assert.deepEqual(plan(TILES(), []).map((p) => [p[0], p.at(-1)]), [["29", "30"], ["28", "28"], ["24", "27"], ["01", "23"]]);
  assert.deepEqual(plan([days(1, 10)], ["04", "05"]).map((p) => [p[0], p.at(-1)]), [["01", "03"], ["06", "10"]], "skipped days split a window");
  assert.deepEqual(plan(TILES(), days(1, 30)), [], "nothing left to ask");
});

test("regression: Today is asked for first and fills in before the rest of the range loads", async () => {
  const w = { list: TILES() }, s = server(w);
  s.loader.start();
  assert.equal(s.asked.length, 1, "one piece at a time");
  assert.deepEqual([s.asked[0].from, s.asked[0].to], ["29", "30"]);
  assert.equal(s.loader.state(days(29, 30)), "loading");
  s.answer(s.asked[0]); await tick();
  assert.equal(s.loader.state(days(29, 30)), "ready", "Today shows while the rest still loads");
  assert.equal(s.loader.state(days(24, 30)), "loading");
  assert.deepEqual(s.asked.map((q) => [q.from, q.to]), [["29", "30"], ["28", "28"]], "then Yesterday's missing day only");
  s.answer(s.asked[1]); await tick(); s.answer(s.asked[2]); await tick(); s.answer(s.asked[3]); await tick();
  assert.deepEqual(s.asked.map((q) => [q.from, q.to]).slice(2), [["24", "27"], ["01", "23"]]);
  assert.equal(s.loader.state(days(1, 30)), "ready");
  assert.equal(s.loader.busy(), false);
  assert.deepEqual(s.status, [true, false], "status hears the round start and finish");
});

test("regression: on Refresh every stat shows loading again until this load has its days", async () => {
  // Numbers from the last load stayed on screen through a Refresh, so nothing said which
  // ones were current. Each now reads loading until the refresh brings its own days.
  const w = { list: [days(29, 30)] }, s = server(w);
  s.loader.start(); s.answer(s.asked[0]); await tick();
  s.loader.start({ force: true });
  assert.equal(s.loader.state(days(29, 30)), "loading");
  assert.equal(s.asked[1].force, true);
  s.answer(s.asked[1]); await tick();
  assert.equal(s.loader.state(days(29, 30)), "ready");
});

test("the timed poll keeps showing what is held while it checks", async () => {
  const w = { list: [days(29, 30)] }, s = server(w);
  s.loader.start(); s.answer(s.asked[0]); await tick();
  s.loader.start({ quiet: true });
  assert.equal(s.loader.state(days(29, 30)), "ready");
  assert.equal(s.asked.length, 2, "it still asks");
  assert.equal(s.loader.state(days(1, 2)), "loading", "a day never loaded still reads loading");
});

test("picking a tile or range mid-load moves its days up, inside the same refresh", async () => {
  // Subsumes the old refreshSharing regression: a preset change during Refresh used to ask
  // separately, unforced, and its quicker answer hid the refresh's. It now joins the round.
  const w = { list: TILES() }, s = server(w);
  s.loader.start({ force: true });
  w.list = [days(29, 30), days(5, 9), ...TILES()]; s.loader.nudge();
  assert.equal(s.asked.length, 1, "nudging a running load doesn't ask twice at once");
  s.answer(s.asked[0]); await tick();
  assert.deepEqual([s.asked[1].from, s.asked[1].to, s.asked[1].force], ["05", "09", true]);
});

test("a nudge after a load finished asks only for the days it is missing", async () => {
  const w = { list: [days(29, 30)] }, s = server(w);
  s.loader.start(); s.answer(s.asked[0]); await tick();
  w.list = [days(29, 30), days(20, 30)]; s.loader.nudge();
  assert.deepEqual([s.asked[1].from, s.asked[1].to], ["20", "28"]);
});

test("an older load answering after a newer one started doesn't count as the newer one's", async () => {
  const w = { list: [days(29, 30)] }, s = server(w);
  s.loader.start();
  s.loader.start({ force: true });
  s.answer(s.asked[0]); await tick();
  assert.equal(s.loader.state(days(29, 30)), "loading", "the old answer is held but isn't this load's");
  s.answer(s.asked[1], 3); await tick();
  assert.equal(s.loader.state(days(29, 30)), "ready");
  assert.equal(s.loader.held.metrics.prsMerged["30"].length, 3);
});

test("a refused piece isn't retried this load: its stats show the last count, or none", async () => {
  const w = { list: [days(29, 30), days(20, 28)] }, s = server(w);
  s.loader.start(); s.answer(s.asked[0]); await tick(); s.answer(s.asked[1]); await tick();
  s.loader.start({ force: true });
  s.asked[2].reject(new Error("rate limited")); await tick();
  assert.equal(s.loader.state(days(29, 30)), "old", "held from before, so the last count shows");
  assert.deepEqual([s.asked[3].from, s.asked[3].to], ["20", "28"], "the load moves on");
  s.asked[3].reject(new Error("rate limited")); await tick();
  assert.equal(s.asked.length, 4, "and doesn't ask again");
  assert.equal(s.loader.busy(), false);
  assert.equal(s.loader.state(days(1, 2)), "loading");
  const fresh = server({ list: [days(29, 30)] });
  fresh.loader.start(); fresh.asked[0].reject(new Error("rate limited")); await tick();
  assert.equal(fresh.loader.state(days(29, 30)), "failed", "nothing held: no number to show");
});

const answer = (days, n) => ({ days, metrics: { prsMerged: Object.fromEntries(days.map((d) => [d, Array.from({ length: n }, (_, i) => ({ repo: "a/b", number: i }))])) } });

test("hold: a second range adds to the days held rather than replacing them", () => {
  let held = hold(null, answer(["10-25", "10-26"], 29), 1);
  assert.equal(holds(held, ["10-26"]), true);
  held = hold(held, answer(["10-20", "10-21"], 1), 2);
  assert.equal(holds(held, ["10-20", "10-26"]), true, "a second range adds to the first rather than replacing it");
  assert.equal(held.metrics.prsMerged["10-26"].length, 29);
  assert.equal(holds(held, ["10-22"]), false, "a day never loaded is not held");
  assert.equal(holds(null, ["10-26"]), false, "nothing is held before the first answer");
});

test("an older answer landing late doesn't overwrite a newer one's days", () => {
  let held = hold(null, answer(["10-26"], 5), 2);
  held = hold(held, answer(["10-25", "10-26"], 3), 1);
  assert.equal(held.metrics.prsMerged["10-26"].length, 5, "the newer request's count stays");
  assert.equal(held.metrics.prsMerged["10-25"].length, 3, "the older one still fills days the newer didn't fetch");
  held = hold(held, answer(["10-26"], 7), 2);
  assert.equal(held.metrics.prsMerged["10-26"].length, 7, "the same request answering again (a shared refresh) still lands");
});
