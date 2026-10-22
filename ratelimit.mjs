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

export function limited(until, what = "search") {
  const at = new Date(Math.ceil(until / 60000) * 60000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const e = new Error(`GitHub ${what} is rate-limited until ${at}`);
  e.code = 429; e.until = until;
  return e;
}

// One GitHub account's penalty, kept once and used by every path that calls GitHub for
// it (the search lane and the gate for other calls), so a penalty one path hits holds
// them all. Until a call sent after the latest penalty gets through, calls go out one
// at a time: a call that wakes with the others cannot send while the first one's answer
// is extending the pause, and one already out when the penalty hit proves nothing.
export function accountPenalty() {
  const s = { until: 0, strikes: 0, recovering: false, probe: null, count: 0 };
  return {
    get until() { return s.until; },
    get strikes() { return s.strikes; },
    // Resolves once the call going out alone has its answer; null when none is.
    get probe() { return s.probe; },
    // Call right before sending; pass what it returns to settle() with the answer.
    begin() {
      const call = { since: s.count, done: null };
      if (s.recovering) s.probe = new Promise((r) => (call.done = r));
      return call;
    },
    // `wait` is null for an answer that is not a rate limit, a pause for one that is,
    // and undefined when the call failed outright (that only ends its turn alone).
    settle(call, wait, headers, body) {
      if (wait === null && call.since === s.count) { s.strikes = 0; s.recovering = false; }
      if (wait != null && !isPrimary(headers, body)) {
        if (isSecondary(headers, body)) s.strikes++;
        s.recovering = true; s.count++;
        s.until = Math.max(s.until, Date.now() + wait);
      }
      if (call.done) { s.probe = null; call.done(); }
    },
  };
}

// Other REST calls are not paced, but a rate limit one of them hits is remembered, so
// the next call (say the page retrying sign-in) waits it out, or fails at once if it
// outlasts the patience, rather than sending into it and extending it. A spent quota
// holds only its own resource (REST "core" and "graphql" are counted apart). `account`
// returns the account's penalty record, or null while the login is unknown, when the
// gate keeps one of its own.
export function apiGate({ patienceMs = PATIENCE_MS, log = () => {}, account = () => null } = {}) {
  const resets = {}, own = accountPenalty(), penalty = () => account() || own;
  return {
    async request(send, what, resource = "core") {
      const deadline = Date.now() + patienceMs;
      for (let tries = 1; ; tries++) {
        for (;;) {
          const until = Math.max(penalty().until, resets[resource] || 0);
          if (until > deadline) throw limited(until, "API");
          if (until > Date.now()) await new Promise((r) => setTimeout(r, until - Date.now()));
          else if (penalty().probe) await penalty().probe;
          else break;
        }
        const p = penalty(), call = p.begin();
        let res, body, wait;
        try {
          res = await send(); body = await res.text();
          // A spent quota holds its resource until it resets, however short a retry-after is.
          if (res.headers.get("x-ratelimit-remaining") === "0") resets[resource] = Math.max(resets[resource] || 0, Number(res.headers.get("x-ratelimit-reset")) * 1000 || 0);
          wait = rateLimitWait(res.status, res.headers, body, p.strikes);
          if (wait !== null && isPrimary(res.headers, body)) resets[resource] = Math.max(resets[resource] || 0, Date.now() + wait);
        } finally { p.settle(call, wait, res?.headers, body); }
        if (wait === null) return { res, body };
        log(`rate limit (${res.status}) on ${what}: waiting ${Math.round(wait / 1000)}s`);
        if (tries >= LIMITED_TRIES) throw limited(Math.max(penalty().until, resets[resource] || 0), "API");
      }
    },
  };
}

// `prio` is a shared { background } object rather than a flag, so a page request that
// joins a background fetch can promote it while it is still queued.
export function searchLane({ gapMs = SEARCH_GAP_MS, patienceMs = PATIENCE_MS, reserve = RESERVE, log = () => {}, penalty = accountPenalty() } = {}) {
  const s = { remaining: Infinity, reset: 0, blockedUntil: 0, last: -Infinity, busy: false, users: 0, queue: [], timer: null };
  // When a waiter could next send: after the account's penalty and any spent search
  // quota pause, and after the quota resets if it is spent (or, for background work,
  // down to the reserve).
  const pauseEnd = (prio) => Math.max(s.blockedUntil, penalty.until, s.remaining <= (prio.background ? reserve : 0) ? s.reset : 0);
  function pump() {
    clearTimeout(s.timer); s.timer = null;
    if (s.busy) return;
    // A waiter whose patience the pause outlasts fails now rather than hanging the queue.
    // Checked on every turn, since another path can extend the penalty at any time.
    for (const w of s.queue.filter((w) => pauseEnd(w.prio) > w.deadline)) { s.queue.splice(s.queue.indexOf(w), 1); w.fail(limited(pauseEnd(w.prio))); }
    const next = s.queue.find((w) => !w.prio.background) || (s.users ? null : s.queue[0]);
    if (!next) return;
    const now = Date.now();
    const at = Math.max(s.last + gapMs, pauseEnd(next.prio));
    if (at > now) { s.timer = setTimeout(pump, at - now); return; }
    if (penalty.probe) { penalty.probe.then(pump); return; } // another path's call is going out alone
    s.queue.splice(s.queue.indexOf(next), 1);
    s.busy = true; s.last = now;
    // Taken here, in the same turn as the check above, so no other call can take it between.
    next.go(penalty.begin());
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
        const call = await new Promise((go, fail) => { s.queue.push({ prio, deadline, go, fail }); pump(); });
        let res, body, wait;
        try {
          res = await send(); body = await res.text();
          wait = rateLimitWait(res.status, res.headers, body, penalty.strikes);
          if (wait !== null) {
            if (isPrimary(res.headers, body)) s.blockedUntil = Math.max(s.blockedUntil, Date.now() + wait);
            const left = res.headers.get("x-ratelimit-remaining");
            log(`search rate limit (${res.status}${left == null ? "" : `, ${left} left`}${/secondary/i.test(body) ? ", secondary" : ""}): pausing searches ${Math.round(wait / 1000)}s`);
          }
        } finally { penalty.settle(call, wait, res?.headers, body); release(res); }
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
