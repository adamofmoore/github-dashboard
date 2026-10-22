// Search rate limits for one GitHub token. Search allows 30 requests a minute, but
// GitHub also trips a "secondary" limit when searches land back to back, often with
// quota still left, and the token is shared with every other tool using `gh` here.
// That limit answers 403 with no retry-after; GitHub's docs say wait at least a
// minute, longer each time it repeats, and retrying sooner only extends it. So
// searches go out one at a time and spaced, page requests ahead of background
// warming, and a rejection pauses every search on the token, not just its own.

export const SEARCH_GAP_MS = 2000; // 30 a minute
export const SECONDARY_BASE_MS = 60 * 1000;
export const SECONDARY_MAX_MS = 10 * 60 * 1000;
export const PATIENCE_MS = 75 * 1000; // longest pause a request sits through before failing
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

export function limited(until, what = "search") {
  const at = new Date(Math.ceil(until / 60000) * 60000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const e = new Error(`GitHub ${what} is rate-limited until ${at}`);
  e.code = 429; e.until = until;
  return e;
}

// `prio` is a shared { background } object rather than a flag, so a page request that
// joins a background fetch can promote it while it is still queued.
export function searchLane({ gapMs = SEARCH_GAP_MS, patienceMs = PATIENCE_MS, reserve = RESERVE, log = () => {} } = {}) {
  const s = { remaining: Infinity, reset: 0, blockedUntil: 0, strikes: 0, last: -Infinity, busy: false, users: 0, queue: [], timer: null };
  function pump() {
    clearTimeout(s.timer); s.timer = null;
    if (s.busy) return;
    const next = s.queue.find((w) => !w.prio.background) || (s.users ? null : s.queue[0]);
    if (!next) return;
    const now = Date.now();
    const quotaAt = s.remaining <= (next.prio.background ? reserve : 0) ? s.reset : 0;
    const at = Math.max(s.last + gapMs, s.blockedUntil, quotaAt);
    if (at > now) { s.timer = setTimeout(pump, at - now); return; }
    s.queue.splice(s.queue.indexOf(next), 1);
    s.busy = true; s.last = now;
    next.go();
  }
  // A pause longer than anyone's patience fails the whole queue now rather than hanging it.
  function release(res) {
    const remaining = res?.headers.get("x-ratelimit-remaining");
    if (remaining != null) { s.remaining = Number(remaining); s.reset = Number(res.headers.get("x-ratelimit-reset")) * 1000; }
    s.busy = false;
    if (s.blockedUntil - Date.now() > patienceMs) for (const w of s.queue.splice(0)) w.fail(limited(s.blockedUntil));
    pump();
  }
  return {
    // Sends one search when its turn comes and returns { res, body } for anything that is
    // not a rate limit; rate limits are waited out here, or fail once the pause is too long.
    async request(send, prio) {
      for (;;) {
        if (s.blockedUntil - Date.now() > patienceMs) throw limited(s.blockedUntil);
        await new Promise((go, fail) => { s.queue.push({ prio, go, fail }); pump(); });
        let res, body, wait;
        try {
          res = await send(); body = await res.text();
          wait = rateLimitWait(res.status, res.headers, body, s.strikes);
          if (wait === null) s.strikes = 0;
          else {
            s.strikes++; s.blockedUntil = Math.max(s.blockedUntil, Date.now() + wait);
            log(`search rate limit (${res.status}, ${res.headers.get("x-ratelimit-remaining")} left${/secondary/i.test(body) ? ", secondary" : ""}): pausing searches ${Math.round(wait / 1000)}s`);
          }
        } finally { release(res); }
        if (wait === null) return { res, body };
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
