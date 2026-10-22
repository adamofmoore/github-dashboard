const test = require("node:test");
const assert = require("node:assert/strict");
const { rateLimitWait, searchLane, apiGate, accountPenalty, SEARCH_GAP_MS, SECONDARY_BASE_MS, SECONDARY_MAX_MS, PATIENCE_MS, LIMITED_TRIES } = require("../ratelimit.mjs");

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

test("a slow search holds the lane: the next one waits for it to finish, not just for the gap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const calls = [], lane = searchLane();
  const slow = async () => { calls.push(["slow", Date.now() - NOW]); await new Promise((r) => setTimeout(r, 5 * SEARCH_GAP_MS)); return reply(200, "{}"); };
  const quick = async () => { calls.push(["quick", Date.now() - NOW]); return reply(200, "{}"); };
  const all = Promise.all([lane.request(slow, user()), lane.request(quick, user())]);
  await advance(t, 6 * SEARCH_GAP_MS);
  await all;
  assert.deepEqual(calls, [["slow", 0], ["quick", 5 * SEARCH_GAP_MS]]);
});

test("background waits at exactly the reserve and goes one above it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  for (const [left, waits] of [[11, true], [12, true], [13, false]]) {
    const resetIn = (Date.now() - NOW) / 1000 + 30; // 30s from now, on each pass of the loop
    const gh = github(() => reply(200, "{}", quota(left, resetIn)));
    const lane = searchLane({ reserve: 12 });
    await lane.request(gh.send("user"), user());
    const background = lane.request(gh.send("bg"), bg());
    await advance(t, 5 * SEARCH_GAP_MS);
    assert.equal(gh.calls.length === 1, waits, `${left} left`);
    await advance(t, 30e3);
    await background;
  }
});

test("a pause ending exactly at the deadline is waited out; one a millisecond later fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  for (const [patienceMs, ok] of [[SECONDARY_BASE_MS, true], [SECONDARY_BASE_MS - 1, false]]) {
    const answers = [reply(403, SECONDARY, quota(11)), reply(200, "{}")];
    const gh = github(() => answers.shift());
    const done = searchLane({ patienceMs }).request(gh.send("x"), user()).then(() => true, (e) => (assert.equal(e.code, 429), false));
    await advance(t, SECONDARY_BASE_MS + SEARCH_GAP_MS);
    assert.equal(await done, ok, `patience ${patienceMs}`);
  }
});

test("regression: short retry-afters with a spent quota can't stretch a request past its patience", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // Copilot's case: retry-after: 1, but the quota is spent and resets a minute out, each time.
  const spentFor = (s) => ({ "retry-after": 1, "x-ratelimit-remaining": 0, "x-ratelimit-reset": Math.floor(Date.now() / 1000) + s });
  const gh = github((n) => (n <= 2 ? reply(403, PRIMARY, spentFor(60)) : reply(200, "{}")));
  const done = searchLane().request(gh.send("x"), user()).then(() => "sent", (e) => e.code);
  await advance(t, 130e3);
  assert.equal(await done, 429, "the second pause runs to 120s, past the 75s budget");
  assert.deepEqual(gh.calls.map((c) => Math.round((c.at - NOW) / 1000)), [0, 60]);
});

// ---------- the per-token gate for other REST calls ----------

test("regression: calls after a too-long rate limit never send into the cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // Copilot's case: /user hits two secondary limits (60s, then 120s, past the patience),
  // and the page asks again before the cooldown ends at 180s.
  const gh = github((n) => (n <= 2 ? reply(403, SECONDARY, quota(11)) : reply(200, "{}")));
  const gate = apiGate();
  const first = gate.request(gh.send("user"), "/user").catch((e) => e);
  await advance(t, SECONDARY_BASE_MS);
  const e = await first;
  assert.equal(e.code, 429);
  assert.equal(e.until, NOW + 3 * SECONDARY_BASE_MS);
  const now = await gate.request(gh.send("user"), "/user").catch((e) => e);
  assert.equal(now.code, 429, "120s of cooldown left is past the 75s patience, so it fails at once");
  await advance(t, SECONDARY_BASE_MS);
  const later = gate.request(gh.send("user"), "/user");
  await advance(t, 30e3);
  assert.equal(gh.calls.length, 2, "with 60s left it waits instead of sending");
  await advance(t, 31e3);
  await later;
  assert.deepEqual(gh.calls.map((c) => Math.round((c.at - NOW) / 1000)), [0, 60, 180]);
});

test("a call during a short remembered cooldown waits it out, then sends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github((n) => (n === 1 ? reply(429, "", { "retry-after": 100 }) : reply(200, "{}")));
  const gate = apiGate();
  const first = gate.request(gh.send("a"), "/a").catch((e) => e);
  await advance(t, 0);
  assert.equal((await first).code, 429, "a 100s retry-after is past the patience");
  await advance(t, 40e3);
  const second = gate.request(gh.send("b"), "/b");
  await advance(t, 61e3);
  await second;
  assert.deepEqual(gh.calls.map((c) => [c.label, Math.round((c.at - NOW) / 1000)]), [["a", 0], ["b", 100]]);
});

test("a secondary limit after a success starts back at a minute", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const answers = [reply(403, SECONDARY, quota(11)), reply(200, "{}"), reply(403, SECONDARY, quota(11)), reply(200, "{}")];
  const gh = github(() => answers.shift());
  const gate = apiGate();
  const a = gate.request(gh.send("a"), "/a");
  await advance(t, SECONDARY_BASE_MS);
  await a;
  const b = gate.request(gh.send("b"), "/b");
  await advance(t, SECONDARY_BASE_MS);
  await b;
  assert.deepEqual(gh.calls.map((c) => Math.round((c.at - NOW) / 1000)), [0, 60, 60, 120], "the second limit waits a minute again, not two");
});

test("regression: a call asleep on a cooldown rechecks it on waking, if another call extended it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // Copilot's case: a and b both sleep until 10s; a wakes first, is limited again for
  // 30s, and b must not then send on its old timer.
  const gh = github((n, label) => (n === 1 || (label === "a" && n === 2) ? reply(429, "", { "retry-after": n === 1 ? 10 : 30 }) : reply(200, "{}")));
  const gate = apiGate();
  const a = gate.request(gh.send("a"), "/a");
  await advance(t, 0);
  const b = gate.request(gh.send("b"), "/b");
  await advance(t, 45e3);
  await Promise.all([a, b]);
  assert.deepEqual(gh.calls.map((c) => [c.label, Math.round((c.at - NOW) / 1000)]), [["a", 0], ["a", 10], ["a", 40], ["b", 40]]);
});

test("a call that throws after a cooldown still lets the waiting ones go", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = github((n) => {
    if (n === 1) return reply(429, "", { "retry-after": 10 });
    if (n === 2) throw new Error("network down");
    return reply(200, "{}");
  });
  const gate = apiGate();
  const a = gate.request(gh.send("a"), "/a").catch((e) => e.message);
  await advance(t, 0);
  const b = gate.request(gh.send("b"), "/b");
  await advance(t, 11e3);
  assert.equal(await a, "network down");
  await b;
  assert.deepEqual(gh.calls.map((c) => [c.label, Math.round((c.at - NOW) / 1000)]), [["a", 0], ["a", 10], ["b", 10]]);
});

test("regression: a late success from a call sent before the limit doesn't end one-at-a-time recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // Copilot's case: a and b go out together; a is limited for 10s, b's success lands at
  // 2s, and c is waiting. At 10s a must go alone, and its new 30s pause holds c too.
  const gh = github((n, label) => {
    if (label === "b") return new Promise((r) => setTimeout(() => r(reply(200, "{}")), 2000));
    if (n === 1) return reply(429, "", { "retry-after": 10 });
    if (n === 3) return reply(429, "", { "retry-after": 30 });
    return reply(200, "{}");
  });
  const gate = apiGate();
  const a = gate.request(gh.send("a"), "/a");
  const b = gate.request(gh.send("b"), "/b");
  await advance(t, 1000);
  const c = gate.request(gh.send("c"), "/c");
  await advance(t, 45e3);
  await Promise.all([a, b, c]);
  assert.deepEqual(gh.calls.map((c) => [c.label, Math.round((c.at - NOW) / 1000)]), [["a", 0], ["b", 0], ["a", 10], ["a", 40], ["c", 40]]);
});

test("regression: the API gate waits for a spent quota's reset, not just a shorter retry-after", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // Copilot's case, the search lane's regression above for the gate: retry-after: 1, but
  // the quota is spent and resets a minute out.
  const spentFor = (s) => ({ "retry-after": 1, "x-ratelimit-remaining": 0, "x-ratelimit-reset": Math.floor(Date.now() / 1000) + s });
  const gh = github((n) => (n === 1 ? reply(403, PRIMARY, spentFor(60)) : reply(200, "{}")));
  const done = apiGate().request(gh.send("user"), "/user");
  await advance(t, 61e3);
  await done;
  assert.deepEqual(gh.calls.map((c) => Math.round((c.at - NOW) / 1000)), [0, 60]);
});

test("regression: a spent quota holds only its own resource; a secondary limit holds them all", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // Copilot's case: GraphQL succeeds with nothing left until a reset ten minutes out.
  const graphqlSpent = { "x-ratelimit-remaining": 0, "x-ratelimit-reset": NOW / 1000 + 600, "x-ratelimit-resource": "graphql" };
  const gh = github((n, label) => (label === "graphql" && n === 1 ? reply(200, "{}", graphqlSpent) : label === "secondary" ? reply(403, SECONDARY, quota(11)) : reply(200, "{}")));
  const gate = apiGate();
  await gate.request(gh.send("graphql"), "/graphql", "graphql");
  await gate.request(gh.send("core"), "/repos/acme/web/issues/1", "core");
  assert.equal((await gate.request(gh.send("graphql"), "/graphql", "graphql").catch((e) => e)).code, 429, "GraphQL waits for its own reset, past the patience");
  assert.equal(gh.calls.length, 2, "while REST went straight through");
  // A fresh token: a secondary limit on REST holds GraphQL as well.
  const gate2 = apiGate(), gh2 = github((n) => (n === 1 ? reply(403, SECONDARY, quota(11)) : reply(200, "{}")));
  const rest = gate2.request(gh2.send("rest"), "/user", "core");
  await advance(t, 0);
  const graphql = gate2.request(gh2.send("graphql"), "/graphql", "graphql");
  await advance(t, 30e3);
  assert.equal(gh2.calls.length, 1, "GraphQL waits out the REST secondary limit");
  await advance(t, 31e3);
  await Promise.all([rest, graphql]);
  assert.deepEqual(gh2.calls.map((c) => [c.label, Math.round((c.at - NOW) / 1000)]), [["rest", 0], ["rest", 60], ["graphql", 60]]);
});

// ---------- one account's penalty, shared by searches and other calls ----------

test("regression: a penalty on either path holds the other; a spent search quota doesn't", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // Copilot's case: GraphQL answers a secondary limit with retry-after: 120, and the
  // next search must not go out during it.
  let penalty = accountPenalty();
  const gh = github((n, label) => (label === "graphql" ? reply(403, SECONDARY, { "retry-after": 120 }) : reply(200, "{}")));
  assert.equal((await apiGate({ account: () => penalty }).request(gh.send("graphql"), "/graphql", "graphql").catch((e) => e)).code, 429);
  const search = await searchLane({ penalty }).request(gh.send("search"), user()).catch((e) => e);
  assert.equal(search.code, 429, "120s of penalty is past the search's patience");
  assert.deepEqual(gh.calls.map((c) => c.label), ["graphql"], "no search was sent");

  // And the other way: a search's secondary limit holds a REST call until it ends.
  penalty = accountPenalty();
  const gh2 = github((n) => (n === 1 ? reply(403, SECONDARY, quota(11)) : reply(200, "{}")));
  const s = searchLane({ penalty }).request(gh2.send("search"), user());
  await advance(t, 1000);
  const rest = apiGate({ account: () => penalty }).request(gh2.send("rest"), "/user", "core");
  await advance(t, 30e3);
  assert.equal(gh2.calls.length, 1, "the REST call waits out the search penalty");
  await advance(t, 35e3);
  await Promise.all([s, rest]);
  assert.equal(gh2.calls.find((c) => c.label === "rest").at - NOW, SECONDARY_BASE_MS, "and goes once it is over");

  // A spent search quota limits searches only.
  penalty = accountPenalty();
  const gh3 = github((n, label) => reply(200, "{}", label === "search" ? quota(0, 50) : {}));
  await searchLane({ penalty }).request(gh3.send("search"), user());
  await apiGate({ account: () => penalty }).request(gh3.send("rest"), "/user", "core");
  assert.deepEqual(gh3.calls.map((c) => c.label), ["search", "rest"]);
  assert.equal(gh3.calls[1].at, gh3.calls[0].at, "REST went straight out");
});

test("regression: calls waiting on a search's penalty go out one at a time when it ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // Copilot's case: a search trips a secondary limit, and the three live-list GraphQL
  // calls are waiting on it. The first one's answer is held, and extends the pause.
  const penalty = accountPenalty();
  let n = 0;
  const gh = github((_, label) => {
    if (label === "search") return reply(403, SECONDARY, quota(11));
    n++;
    if (n === 1) return new Promise((r) => setTimeout(() => r(reply(429, "", { "retry-after": 30 })), 5000));
    return reply(200, "{}");
  });
  const gate = apiGate({ account: () => penalty, patienceMs: 10 * 60e3 });
  searchLane({ penalty, patienceMs: 0 }).request(gh.send("search"), user()).catch(() => {});
  await advance(t, 0);
  const lists = [1, 2, 3].map((i) => gate.request(gh.send(`graphql${i}`), "/graphql", "graphql"));
  await advance(t, 60e3 + 5000 + 30e3 + 1000);
  await Promise.all(lists);
  const at = gh.calls.filter((c) => c.label !== "search").map((c) => [c.label, Math.round((c.at - NOW) / 1000)]);
  assert.deepEqual(at.slice(0, 2), [["graphql1", 60], ["graphql1", 95]], "the first goes alone, and again after its own new pause");
  assert.deepEqual(at.slice(2).map(([, s]) => s), [95, 95], "the others only once it got through");
});

test("regression: a search and an API call waiting on a failed probe don't both go out alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // Copilot's case: a's retry at 10s is the probe and fails outright at 12s; the search
  // and b were both waiting on it. One of them goes next, alone, and the other waits for
  // its answer.
  const penalty = accountPenalty();
  const gh = github((n, label) => {
    if (n === 1) return reply(429, "", { "retry-after": 10 });
    if (label === "a") return new Promise((_, fail) => setTimeout(() => fail(new Error("network down")), 2000));
    return new Promise((r) => setTimeout(() => r(reply(200, "{}")), 5000));
  });
  const gate = apiGate({ account: () => penalty }), lane = searchLane({ penalty, gapMs: 0 });
  const a = gate.request(gh.send("a"), "/a").catch((e) => e.message);
  await advance(t, 11e3);
  const waiting = [lane.request(gh.send("search"), user()), gate.request(gh.send("b"), "/b")];
  await advance(t, 15e3);
  await Promise.all(waiting);
  assert.equal(await a, "network down");
  assert.deepEqual(gh.calls.map((c) => [c.label, Math.round((c.at - NOW) / 1000)]), [["a", 0], ["a", 10], ["search", 12], ["b", 17]]);
});
