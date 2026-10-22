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
