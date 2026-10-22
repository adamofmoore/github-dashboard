// REST search rate limits for one GitHub account. Search allows 30 requests a minute,
// but GitHub also trips a "secondary" limit when searches land back to back, often with
// quota still left, and the account is shared with every other tool using `gh` here.
// That limit answers 403 with no retry-after; GitHub's docs say wait at least a
// minute, longer each time it repeats, and retrying sooner only extends it. So REST
// searches go out one at a time and spaced, page requests ahead of background warming,
// and a rejection pauses every REST search on the account, not just its own. (The live
// lists' GraphQL search has its own limits and does not use this lane.)

export const SEARCH_GAP_MS = 2000; // 30 a minute
export const SECONDARY_BASE_MS = 60 * 1000;
export const SECONDARY_MAX_MS = 10 * 60 * 1000;
export const PATIENCE_MS = 75 * 1000; // longest a request waits on rate limits, all pauses together
export const LIMITED_TRIES = 6; // rate-limited answers a request takes before failing, however short the waits
export const RESERVE = 12; // searches a minute that background work leaves for the page

// How long GitHub asked us to wait after this response, or null when it is not a rate limit.
export function rateLimitWait(status, headers, body, strikes, now = Date.now()) {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = Number(headers.get("retry-after")) * 1000;
  const spent = headers.get("x-ratelimit-remaining") === "0", reset = Number(headers.get("x-ratelimit-reset")) * 1000;
  if (status === 403 && !retryAfter && !spent && !/rate limit/i.test(body)) return null;
  if (retryAfter) return retryAfter;
  const untilReset = spent && reset ? Math.max(reset - now, 0) + 1000 : 0;
  if (untilReset && !/secondary rate limit/i.test(body)) return untilReset;
  return Math.max(untilReset, Math.min(SECONDARY_BASE_MS * 2 ** strikes, SECONDARY_MAX_MS));
}
// Only secondary limits escalate; a spent quota or a retry-after is a fixed wait.
export const isSecondary = (headers, body) => !Number(headers.get("retry-after")) && (/secondary rate limit/i.test(body) || headers.get("x-ratelimit-remaining") !== "0");
// A plain spent quota limits only its own resource (search, core, graphql); anything else
// (a secondary limit, a retry-after) is a penalty on the whole account.
const isPrimary = (headers, body) => headers.get("x-ratelimit-remaining") === "0" && !Number(headers.get("retry-after")) && !/secondary rate limit/i.test(body);
// Both paths of one account record penalties in one { until } object, so a penalty one
// path hits holds the other too. `shared` returns it, or null while the login is unknown.
const noShared = () => null;
const extend = (shared, until) => { const p = shared(); if (p) p.until = Math.max(p.until, until); };

export function limited(until, what = "search") {
  const at = new Date(Math.ceil(until / 60000) * 60000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const e = new Error(`GitHub ${what} is rate-limited until ${at}`);
  e.code = 429; e.until = until;
  return e;
}

// Other REST calls on one token are not paced, but a rate limit one of them hits is
// remembered, so the next call (say the page retrying sign-in) waits it out, or fails
// at once if it outlasts the patience, rather than sending into it and extending it.
// A spent quota holds only its own resource (REST "core" and "graphql" are counted
// apart); a secondary limit or retry-after holds every call on the token, and until a
// call gets through again they go one at a time, so a call that wakes with the others
// cannot send while the first one's answer is extending the pause. Only a call sent
// after the latest such limit ends that; one already out when it hit proves nothing.
export function apiGate({ patienceMs = PATIENCE_MS, log = () => {}, shared = noShared } = {}) {
  const s = { blockedUntil: 0, resets: {}, strikes: 0, limited: false, probe: null, limits: 0 };
  const pauseEnd = (resource) => Math.max(s.blockedUntil, s.resets[resource] || 0, shared()?.until || 0);
  return {
    async request(send, what, resource = "core") {
      const deadline = Date.now() + patienceMs;
      for (let tries = 1; ; tries++) {
        for (;;) {
          const until = pauseEnd(resource);
          if (until > deadline) throw limited(until, "API");
          if (until > Date.now()) await new Promise((r) => setTimeout(r, until - Date.now()));
          else if (s.probe) await s.probe;
          else break;
        }
        let done;
        const since = s.limits;
        if (s.limited) s.probe = new Promise((r) => (done = r));
        try {
          const res = await send(), body = await res.text();
          const spent = res.headers.get("x-ratelimit-remaining") === "0", reset = Number(res.headers.get("x-ratelimit-reset")) * 1000 || 0;
          // A spent quota holds its resource until it resets, however short a retry-after is.
          if (spent) s.resets[resource] = Math.max(s.resets[resource] || 0, reset);
          const wait = rateLimitWait(res.status, res.headers, body, s.strikes);
          if (wait === null) {
            if (since === s.limits) { s.strikes = 0; s.limited = false; }
            return { res, body };
          }
          if (isPrimary(res.headers, body)) s.resets[resource] = Math.max(s.resets[resource] || 0, Date.now() + wait);
          else {
            if (isSecondary(res.headers, body)) s.strikes++;
            s.limited = true; s.limits++;
            s.blockedUntil = Math.max(s.blockedUntil, Date.now() + wait);
            extend(shared, s.blockedUntil);
          }
          log(`rate limit (${res.status}) on ${what}: waiting ${Math.round(wait / 1000)}s`);
        } finally { if (done) { s.probe = null; done(); } }
        if (tries >= LIMITED_TRIES) throw limited(pauseEnd(resource), "API");
      }
    },
  };
}

// `prio` is a shared { background } object rather than a flag, so a page request that
// joins a background fetch can promote it while it is still queued.
export function searchLane({ gapMs = SEARCH_GAP_MS, patienceMs = PATIENCE_MS, reserve = RESERVE, log = () => {}, shared = noShared } = {}) {
  const s = { remaining: Infinity, reset: 0, blockedUntil: 0, strikes: 0, last: -Infinity, busy: false, users: 0, queue: [], timer: null };
  // When a waiter could next send: after any rate-limit pause, and after the quota resets
  // if it is spent (or, for background work, down to the reserve).
  const pauseEnd = (prio) => Math.max(s.blockedUntil, shared()?.until || 0, s.remaining <= (prio.background ? reserve : 0) ? s.reset : 0);
  // A waiter whose patience the pause outlasts fails now rather than hanging the queue.
  // Checked on every turn, since the other path can extend a shared penalty at any time.
  function pump() {
    clearTimeout(s.timer); s.timer = null;
    if (s.busy) return;
    for (const w of s.queue.filter((w) => pauseEnd(w.prio) > w.deadline)) { s.queue.splice(s.queue.indexOf(w), 1); w.fail(limited(pauseEnd(w.prio))); }
    const next = s.queue.find((w) => !w.prio.background) || (s.users ? null : s.queue[0]);
    if (!next) return;
    const now = Date.now();
    const at = Math.max(s.last + gapMs, pauseEnd(next.prio));
    if (at > now) { s.timer = setTimeout(pump, at - now); return; }
    s.queue.splice(s.queue.indexOf(next), 1);
    s.busy = true; s.last = now;
    next.go();
  }
  function release(res) {
    const remaining = res?.headers.get("x-ratelimit-remaining");
    if (remaining != null) { s.remaining = Number(remaining); s.reset = Number(res.headers.get("x-ratelimit-reset")) * 1000; }
    s.busy = false;
    pump();
  }
  return {
    // Sends one search when its turn comes and returns { res, body } for anything that is
    // not a rate limit. Rate limits are waited out here, up to PATIENCE_MS in all and
    // LIMITED_TRIES answers, so a run of short retry-afters cannot loop forever.
    async request(send, prio) {
      const deadline = Date.now() + patienceMs;
      for (let tries = 1; ; tries++) {
        if (pauseEnd(prio) > deadline) throw limited(pauseEnd(prio));
        await new Promise((go, fail) => { s.queue.push({ prio, deadline, go, fail }); pump(); });
        let res, body, wait;
        try {
          res = await send(); body = await res.text();
          wait = rateLimitWait(res.status, res.headers, body, s.strikes);
          if (wait === null) s.strikes = 0;
          else {
            if (isSecondary(res.headers, body)) s.strikes++;
            s.blockedUntil = Math.max(s.blockedUntil, Date.now() + wait);
            if (!isPrimary(res.headers, body)) extend(shared, s.blockedUntil);
            const left = res.headers.get("x-ratelimit-remaining");
            log(`search rate limit (${res.status}${left == null ? "" : `, ${left} left`}${/secondary/i.test(body) ? ", secondary" : ""}): pausing searches ${Math.round(wait / 1000)}s`);
          }
        } finally { release(res); }
        if (wait === null) return { res, body };
        if (tries >= LIMITED_TRIES) throw limited(pauseEnd(prio));
      }
    },
    // Background searches wait while any page request is running.
    async whileUser(fn) {
      s.users++;
      try { return await fn(); } finally { s.users--; pump(); }
    },
    // A page request that needs a fetch the background already started takes it over.
    promote(prio) { prio.background = false; pump(); },
  };
}
