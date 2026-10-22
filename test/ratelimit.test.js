const test = require("node:test");
const assert = require("node:assert/strict");
const { rateLimitWait, searchLane, SEARCH_GAP_MS, SECONDARY_BASE_MS, SECONDARY_MAX_MS, PATIENCE_MS, LIMITED_TRIES } = require("../ratelimit.mjs");

// Bodies and headers as GitHub sent them on 2026-10-22 (request D037:324345:980C7D…).
const SECONDARY = '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again. For more on scraping GitHub and how it may affect your rights, please review our Terms of Service.","documentation_url":"https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits","status":"403"}';
const PRIMARY = '{"message":"API rate limit exceeded for user ID 7817400.","documentation_url":"https://docs.github.com/rest/overview/rate-limits-for-the-rest-api","status":"403"}';
const NOW = 1792682365000;
const headers = (h) => new Headers(Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)])));
const quota = (remaining, resetInS = 7) => ({ "x-ratelimit-limit": 30, "x-ratelimit-remaining": remaining, "x-ratelimit-reset": NOW / 1000 + resetInS, "x-ratelimit-resource": "search" });

test("a secondary limit with quota left waits a minute, not five seconds", () => {
  assert.equal(rateLimitWait(403, headers(quota(11)), SECONDARY, 0, NOW), SECONDARY_BASE_MS);
});

test("a repeating secondary limit doubles its wait, up to a cap", () => {
  const waits = [0, 1, 2, 3, 10].map((strikes) => rateLimitWait(403, headers(quota(11)), SECONDARY, strikes, NOW));
  assert.deepEqual(waits, [60e3, 120e3, 240e3, 480e3, SECONDARY_MAX_MS]);
});

test("a secondary limit that also spent the quota waits for whichever ends later", () => {
  assert.equal(rateLimitWait(403, headers(quota(0, 7)), SECONDARY, 0, NOW), SECONDARY_BASE_MS);
  assert.equal(rateLimitWait(403, headers(quota(0, 90)), SECONDARY, 0, NOW), 91e3);
});

test("a spent primary quota waits until it resets", () => {
  assert.equal(rateLimitWait(403, headers(quota(0, 20)), PRIMARY, 0, NOW), 21e3);
  assert.equal(rateLimitWait(403, headers(quota(0, -3)), PRIMARY, 0, NOW), 1e3, "a reset already past still pauses briefly");
});

test("retry-after wins over everything else", () => {
  assert.equal(rateLimitWait(403, headers({ ...quota(11), "retry-after": 30 }), SECONDARY, 4, NOW), 30e3);
  assert.equal(rateLimitWait(429, headers({ "retry-after": 2 }), "", 0, NOW), 2e3);
});

test("a 429, or a spent quota, with no further guidance is treated as a secondary limit", () => {
  assert.equal(rateLimitWait(429, headers({}), "", 0, NOW), SECONDARY_BASE_MS);
  assert.equal(rateLimitWait(403, headers({ "x-ratelimit-remaining": 0 }), PRIMARY, 0, NOW), SECONDARY_BASE_MS, "spent quota with no reset time still backs off");
});

test("a 403 that is not about rate limits is not retried", () => {
  assert.equal(rateLimitWait(403, headers({ "x-ratelimit-remaining": 4999, "x-ratelimit-reset": NOW / 1000 + 3000 }), '{"message":"Resource protected by organization SAML enforcement."}', 0, NOW), null);
  assert.equal(rateLimitWait(200, headers(quota(11)), "{}", 0, NOW), null);
  assert.equal(rateLimitWait(422, headers(quota(11)), '{"message":"Validation Failed"}', 0, NOW), null);
});

// ---------- the lane, on a mocked clock ----------

const settle = () => new Promise((r) => setImmediate(r));
async function advance(t, ms, step = 250) { await settle(); for (let i = 0; i < ms; i += step) { t.mock.timers.tick(step); await settle(); } }
const reply = (status, body, h = quota(20, 60)) => ({ status, ok: status < 300, headers: headers(h), text: async () => body });
const user = () => ({ background: false });
const bg = () => ({ background: true });

// A fake GitHub that records when each search arrived and answers from a script.
function github(answer) {
  const calls = [];
  return { calls, send: (label) => async () => { calls.push({ label, at: Date.now() }); return answer(calls.length, label); } };
}

test("searches go out one at a time, spaced by the gap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github(() => reply(200, "{}"));
  const lane = searchLane();
  const all = Promise.all(["a", "b", "c"].map((l) => lane.request(gh.send(l), user())));
  await advance(t, 3 * SEARCH_GAP_MS);
  await all;
  assert.deepEqual(gh.calls.map((c) => c.at - NOW), [0, SEARCH_GAP_MS, 2 * SEARCH_GAP_MS]);
});

test("regression: a secondary limit lasting 50s is waited out, not given up on after six 5s retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // GitHub's penalty here outlasts the old 6 x 5.5s retry loop (33s), which then threw "gave up after retries".
  const gh = github(() => (Date.now() - NOW < 50e3 ? reply(403, SECONDARY, quota(11)) : reply(200, '{"total_count":1}')));
  const lane = searchLane();
  const done = lane.request(gh.send("page4"), user());
  await advance(t, SECONDARY_BASE_MS + SEARCH_GAP_MS);
  const { res, body } = await done;
  assert.equal(res.status, 200);
  assert.equal(body, '{"total_count":1}');
  assert.deepEqual(gh.calls.map((c) => c.at - NOW), [0, SECONDARY_BASE_MS], "one retry, after the full minute; no hammering inside the penalty");
});

test("a rate limit pauses every search on the token, not just the one that hit it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github((n) => (n === 1 ? reply(403, SECONDARY, quota(11)) : reply(200, "{}")));
  const lane = searchLane();
  const all = Promise.all([lane.request(gh.send("first"), user()), lane.request(gh.send("second"), user())]);
  await advance(t, SECONDARY_BASE_MS + 2 * SEARCH_GAP_MS);
  await all;
  assert.deepEqual(gh.calls.map((c) => [c.label, c.at - NOW]), [["first", 0], ["second", SECONDARY_BASE_MS], ["first", SECONDARY_BASE_MS + SEARCH_GAP_MS]]);
});

test("a pause longer than a request's patience fails it at once, saying until when", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github(() => reply(403, SECONDARY, quota(11)));
  const lane = searchLane();
  // First strike pauses 60s (within patience) and retries; the second pauses 120s, past it.
  const first = lane.request(gh.send("x"), user()).then(() => assert.fail("should not resolve"), (e) => e);
  await advance(t, SECONDARY_BASE_MS + SEARCH_GAP_MS);
  const err = await first;
  assert.equal(err.code, 429);
  assert.equal(err.until, NOW + SECONDARY_BASE_MS + 2 * SECONDARY_BASE_MS);
  assert.match(err.message, /^GitHub search is rate-limited until /);
  assert.ok(2 * SECONDARY_BASE_MS > PATIENCE_MS);
  // Anything that arrives while the pause runs fails without touching GitHub.
  const sent = gh.calls.length;
  await assert.rejects(lane.request(gh.send("y"), user()), (e) => e.code === 429 && e.until === err.until);
  assert.equal(gh.calls.length, sent);
});

test("a request already waiting when a long pause starts fails too, instead of hanging", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github((n) => (n === 1 ? reply(403, SECONDARY, quota(11)) : reply(200, "{}")));
  const lane = searchLane({ patienceMs: 30e3 });
  const first = lane.request(gh.send("first"), user()).catch((e) => e);
  const second = lane.request(gh.send("second"), user()).catch((e) => e);
  await advance(t, 1000);
  assert.equal((await first).code, 429);
  assert.equal((await second).code, 429);
  assert.equal(gh.calls.length, 1);
});

test("regression: a run of short retry-afters gives up instead of retrying forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // retry-after: 30 never exceeds patience on its own and never escalates.
  let gh = github(() => reply(403, SECONDARY, { ...quota(11), "retry-after": 30 }));
  let done = searchLane().request(gh.send("x"), user()).catch((e) => e);
  await advance(t, PATIENCE_MS + 30e3);
  let err = await done;
  assert.equal(err.code, 429);
  assert.equal(gh.calls.length, 3, "sends at 0s, 30s, 60s; the pause to 90s outlasts the 75s budget");
  // retry-after: 1 fits the budget many times over, so the try count stops it.
  gh = github(() => reply(429, "", { "retry-after": 1 }));
  done = searchLane().request(gh.send("y"), user()).catch((e) => e);
  await advance(t, 30e3);
  err = await done;
  assert.equal(err.code, 429);
  assert.equal(gh.calls.length, LIMITED_TRIES);
});

test("a spent quota or retry-after does not escalate the next secondary limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const answers = [reply(403, PRIMARY, quota(0, 5)), reply(403, SECONDARY, quota(11)), reply(200, "{}")];
  const gh = github(() => answers.shift());
  const done = searchLane().request(gh.send("x"), user());
  await advance(t, 6e3 + SECONDARY_BASE_MS + SEARCH_GAP_MS);
  assert.equal((await done).res.status, 200);
  assert.deepEqual(gh.calls.map((c) => c.at - NOW), [0, 6e3, 6e3 + SECONDARY_BASE_MS], "the secondary limit waits one minute, not two");
});

test("user searches jump ahead of background ones", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github(() => reply(200, "{}"));
  const lane = searchLane();
  const all = Promise.all([lane.request(gh.send("bg1"), bg()), lane.request(gh.send("bg2"), bg()), lane.request(gh.send("user"), user())]);
  await advance(t, 3 * SEARCH_GAP_MS);
  await all;
  assert.deepEqual(gh.calls.map((c) => c.label), ["bg1", "user", "bg2"]);
});

test("background searches hold off while a user request is running", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github(() => reply(200, "{}"));
  const lane = searchLane();
  let finish;
  const held = lane.whileUser(() => new Promise((r) => (finish = r)));
  const background = lane.request(gh.send("bg"), bg());
  await advance(t, 5 * SEARCH_GAP_MS);
  assert.equal(gh.calls.length, 0);
  finish();
  await held;
  await advance(t, SEARCH_GAP_MS);
  await background;
  assert.equal(gh.calls.length, 1);
});

test("regression: a user request that joins a background fetch promotes it instead of deadlocking", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github(() => reply(200, "{}"));
  const lane = searchLane();
  const prio = bg();
  // A page request is running, so the warm loop's fetch for this span queues behind it.
  // The page request then needs that same span and awaits the shared fetch. The old
  // code had background yield to page requests and page requests await background
  // fetches, so this pair waited on each other forever.
  let finished = false;
  lane.whileUser(async () => {
    const shared = lane.request(gh.send("span"), prio);
    await settle();
    assert.equal(gh.calls.length, 0, "queued behind the running page request");
    lane.promote(prio);
    await shared;
  }).then(() => (finished = true));
  await advance(t, SEARCH_GAP_MS);
  assert.equal(finished, true);
  assert.equal(gh.calls.length, 1);
});

test("background leaves the last searches of the minute for the page", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github(() => reply(200, "{}", quota(5, 30)));
  const lane = searchLane({ reserve: 12 });
  const first = lane.request(gh.send("user"), user());
  await advance(t, 250);
  await first;
  const background = lane.request(gh.send("bg"), bg());
  await advance(t, 20e3);
  assert.equal(gh.calls.length, 1, "5 left is under the reserve, so background waits for the reset");
  await advance(t, 15e3);
  await background;
  assert.equal(gh.calls[1].at - NOW >= 30e3, true);
});

test("a network error frees the lane and reaches the caller", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const lane = searchLane();
  const failing = lane.request(async () => { throw new Error("ECONNRESET"); }, user());
  await assert.rejects(failing, /ECONNRESET/);
  const gh = github(() => reply(200, "{}"));
  const next = lane.request(gh.send("next"), user());
  await advance(t, SEARCH_GAP_MS);
  assert.equal((await next).res.status, 200);
});

test("a 403 that is not a rate limit comes straight back to the caller", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github(() => reply(403, '{"message":"Resource protected by organization SAML enforcement."}', { "x-ratelimit-remaining": 4999 }));
  const lane = searchLane();
  const { res } = await lane.request(gh.send("sso"), user());
  assert.equal(res.status, 403);
  assert.equal(gh.calls.length, 1);
});
