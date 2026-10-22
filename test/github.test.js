const test = require("node:test");
const assert = require("node:assert/strict");
const { createGitHub } = require("../github.mjs");

const NOW = 1792682365000;
const SECONDARY = '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}';
const settle = () => new Promise((r) => setImmediate(r));
const reply = (status, body, h = {}) => new Response(body, { status, headers: h });

// A fake GitHub answering each path from `answer(path, n)`, recording what was sent.
function fakeGitHub(answer) {
  const calls = [];
  const fetch = async (url) => { const path = new URL(url).pathname; calls.push(path); return answer(path, calls.length); };
  return { calls, ...createGitHub({ fetch }) };
}

test("regression: concurrent sign-in lookups share one /user call, and its penalty", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  // Copilot's case: warm() and /api/auth/status look up the login at once; the lookup
  // hits a secondary limit, so no search may go out on a second, luckier lookup.
  const gh = fakeGitHub((path) => (path === "/user" ? reply(403, SECONDARY, { "retry-after": "120" }) : reply(200, "{}")));
  const c = gh.client("token");
  const both = await Promise.all([c.me().catch((e) => e.code), c.gh("https://api.github.com/search/issues?q=x").catch((e) => e.code)]);
  assert.deepEqual(both, [429, 429]);
  assert.deepEqual(gh.calls, ["/user"], "one lookup, and no search");
  assert.equal(await c.me().catch((e) => e.code), 429, "a lookup during the penalty fails without sending");
  assert.deepEqual(gh.calls, ["/user"]);
});

test("a failed lookup is retried, and the login is then remembered", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = fakeGitHub((path, n) => (n === 1 ? reply(500, "{}") : reply(200, '{"login":"me"}')));
  const c = gh.client("token");
  assert.equal(await c.me().catch((e) => e.status), 500);
  assert.equal(await c.me(), "me");
  assert.equal(await c.me(), "me");
  assert.deepEqual(gh.calls, ["/user", "/user"]);
});

test("a GraphQL penalty holds the same account's searches, across tokens", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const gh = fakeGitHub((path) => (path === "/user" ? reply(200, '{"login":"me"}') : path === "/graphql" ? reply(403, SECONDARY, { "retry-after": "120" }) : reply(200, '{"total_count":0,"items":[]}')));
  const a = gh.client("owner token"), b = gh.client("session token");
  await a.me(); await b.me();
  assert.equal(await a.graphql("{ viewer { login } }").catch((e) => e.code), 429);
  assert.equal(await b.gh("https://api.github.com/search/issues?q=x").catch((e) => e.code), 429, "another token for the same login is held too");
  assert.deepEqual(gh.calls, ["/user", "/user", "/graphql"]);
});
