const test = require("node:test");
const assert = require("node:assert/strict");
const { refreshSharing } = require("../public/loads.js");

// A fake server: each request waits until the test answers it.
function server() {
  const asked = [];
  const fetch = (key, force) => new Promise((resolve, reject) => asked.push({ key, force, resolve, reject }));
  return { asked, load: refreshSharing(fetch) };
}

test("regression: a preset change during Refresh waits for the refresh instead of asking again", async () => {
  // Copilot's case: Refresh, then another preset with the same fetch range. The plain
  // load used to answer first from the cache and hide the refresh's result and warnings.
  const s = server();
  const refresh = s.load("09-22..10-22", true);
  const preset = s.load("09-22..10-22", false);
  assert.equal(s.asked.length, 1, "no second request");
  s.asked[0].resolve({ stale: ["prsMerged 10-01..10-01"] });
  assert.deepEqual(await preset, { stale: ["prsMerged 10-01..10-01"] }, "the preset shows the refresh's answer");
  assert.equal(await refresh, await preset);
});

test("a load of a different range, or after the refresh, asks on its own", async () => {
  const s = server();
  s.load("a", true);
  s.load("b", false);
  assert.deepEqual(s.asked.map((a) => [a.key, a.force]), [["a", true], ["b", false]]);
  s.asked[0].resolve({});
  await new Promise((r) => setImmediate(r));
  s.load("a", false);
  assert.deepEqual(s.asked.map((a) => [a.key, a.force]).at(-1), ["a", false], "the finished refresh is not reused");
});

test("a failed refresh is not reused, and a newer refresh replaces an older one", async () => {
  const s = server();
  const first = s.load("a", true);
  const second = s.load("a", true);
  assert.equal(s.asked.length, 2, "a second Refresh asks again");
  s.asked[0].reject(new Error("rate limited"));
  await assert.rejects(first);
  assert.equal(s.load("a", false), second, "the newer refresh is still the one joined");
  s.asked[1].reject(new Error("rate limited"));
  await assert.rejects(second);
  await new Promise((r) => setImmediate(r));
  s.load("a", false);
  assert.equal(s.asked.length, 3, "after it fails, a plain load asks on its own");
});

test("regression: refreshes of two ranges are tracked apart, so going back to the first joins its refresh", async () => {
  // Copilot's case: Refresh range A, pick and refresh range B, then go back to A before
  // either finishes. The plain load of A must wait for A's refresh, not ask again.
  const s = server();
  const a = s.load("a", true);
  s.load("b", true);
  assert.equal(s.load("a", false), a, "back on A, the load joins A's refresh");
  assert.equal(s.asked.length, 2, "no third request");
  s.asked[1].resolve({});
  await new Promise((r) => setImmediate(r));
  assert.equal(s.load("a", false), a, "B finishing doesn't forget A");
  s.load("b", false);
  assert.deepEqual(s.asked.map((x) => [x.key, x.force]).at(-1), ["b", false], "while B, finished, asks on its own");
});

const { hold, holds } = require("../public/loads.js");
const answer = (days, n) => ({ days, metrics: { prsMerged: Object.fromEntries(days.map((d) => [d, Array.from({ length: n }, (_, i) => ({ repo: "a/b", number: i }))])) } });

test("regression: days already loaded stay readable while another range loads", () => {
  // The Today tile hid its 29 merged PRs behind a loading shimmer while a fetch ran,
  // though the list beside it already showed them. What is held is what is shown.
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
