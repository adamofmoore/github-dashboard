// Activity by day: the four search metrics, fetched per local day and cached. server.mjs
// passes in the per-login cache and search lane, so the whole path from a search reply to
// a cache write can be tested without starting a server.
import { firstPage, restPages } from "./search.mjs";

export const API = "https://api.github.com";

// ---------- day math (local timezone, midnight to midnight) ----------
const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localDay = (iso) => dayKey(new Date(iso));
export function startOfDay(key) { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0); }
export function endOfDay(key) { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999); }
function offsetIso(d) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
export function daysBetween(from, to) { const out = []; for (let d = startOfDay(from); d <= startOfDay(to); d.setDate(d.getDate() + 1)) out.push(dayKey(d)); return out; }
export function shift(key, n) { const d = startOfDay(key); d.setDate(d.getDate() + n); return dayKey(d); }
export const today = () => dayKey(new Date());

// ---------- metrics ----------
export const METRICS = {
  issuesOpened: { q: (u) => `author:${u} is:issue`, field: "created", ts: (i) => i.created_at },
  issuesClosed: { q: (u) => `assignee:${u} is:issue`, field: "closed", ts: (i) => i.closed_at },
  prsOpened: { q: (u) => `author:${u} is:pr`, field: "created", ts: (i) => i.created_at },
  prsMerged: { q: (u) => `author:${u} is:pr`, field: "merged", ts: (i) => i.pull_request?.merged_at },
};
export function slim(i) {
  return { repo: i.repository_url.replace(`${API}/repos/`, ""), number: i.number, title: i.title, url: i.html_url, state: i.state, state_reason: i.state_reason || null, draft: i.draft || false, created_at: i.created_at, closed_at: i.closed_at, merged_at: i.pull_request?.merged_at || null, is_pr: Boolean(i.pull_request) };
}
// Whether an issue, as the issues API returns it, still belongs in this metric's range.
export function belongsIn(metric, user, issue, isPr, fromKey, toKey) {
  const ts = METRICS[metric].ts(issue), who = metric === "issuesClosed" ? (issue.assignees || []).map((a) => a.login) : [issue.user?.login];
  return Boolean(ts) && Boolean(issue.pull_request) === isPr && who.includes(user) && localDay(ts) >= fromKey && localDay(ts) <= toKey;
}

export const FRESH_MS = 90 * 1000; // how long today's counts are reused
export const CONFIRM_MS = 10 * 60 * 1000; // how far apart two unverifiable empty answers must be to settle a day
export const CHECK_ITEMS = 5; // cached items read directly to test an empty answer

export function createActivity({ cacheFor, laneFor, log = () => {} }) {
  // Whether items we already had still belong in the range, read from the issues
  // themselves rather than through search: true if one does, false only when every known
  // item was read and none does, null when that cannot be told (too many to read them
  // all, or some unreadable), which firstPage treats like knowing nothing.
  async function stillInRange(c, metric, user, known, fromKey, toKey) {
    let unread = Math.max(known.length - CHECK_ITEMS, 0);
    for (const item of known.slice(0, CHECK_ITEMS)) {
      let issue;
      try { issue = await c.gh(`${API}/repos/${item.repo}/issues/${item.number}`); }
      catch (e) {
        if (e.status === 404 || e.status === 410) continue; // gone for this token, so gone from its search too
        if (e.status === 403 || e.status === 451) { unread++; continue; } // SSO or legal block: no evidence either way
        throw e;
      }
      if (belongsIn(metric, user, issue, item.is_pr, fromKey, toKey)) return true;
    }
    return unread ? null : false;
  }

  // `known` is what the cache already holds for the range, each item tagged with its day.
  // Each returned day carries `unconfirmed` when its emptiness rests on answers nothing
  // could check.
  async function searchRange(c, metric, fromKey, toKey, user, prio, known = []) {
    const m = METRICS[metric];
    const q = `${m.q(user)} ${m.field}:${offsetIso(startOfDay(fromKey))}..${offsetIso(endOfDay(toKey))}`;
    const page = (p) => c.gh(`${API}/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${p}`, {}, prio);
    const label = `${metric} ${fromKey}..${toKey}`;
    const first = await firstPage(page, known.length ? () => stillInRange(c, metric, user, known, fromKey, toKey) : null, label);
    if (first.total_count > 1000 && fromKey !== toKey) {
      const days = daysBetween(fromKey, toKey), mid = days[Math.floor(days.length / 2) - 1], next = days[Math.floor(days.length / 2)];
      const [a, b] = await Promise.all([searchRange(c, metric, fromKey, mid, user, prio, known.filter((i) => i.day <= mid)), searchRange(c, metric, next, toKey, user, prio, known.filter((i) => i.day >= next))]);
      return a.concat(b);
    }
    const items = await restPages(page, first, label);
    const buckets = {};
    for (const k of daysBetween(fromKey, toKey)) buckets[k] = [];
    for (const it of items) { const ts = m.ts(it); if (!ts) continue; const k = localDay(ts); if (buckets[k]) buckets[k].push(slim(it)); }
    return Object.entries(buckets).map(([day, list]) => ({ day, items: list, unconfirmed: Boolean(first.unconfirmed) }));
  }

  const inflight = new Map();
  async function dailyData(c, fromKey, toKey, force, background = false) {
    const user = await c.me();
    const cache = cacheFor(user), lane = laneFor(user);
    const tKey = today(), days = daysBetween(fromKey, toKey), out = {}, stale = [];
    for (const metric of Object.keys(METRICS)) {
      out[metric] = {};
      // A past day is reusable only once it was fetched after it ended — otherwise a
      // day cached mid-evening would keep its partial counts forever.
      const fresh = (d) => { const at = cache.fetchedAt[`${metric}:${d}`] || 0; return at > 0 && (d < tKey ? at >= endOfDay(d).getTime() : Date.now() - at < FRESH_MS); };
      const missing = days.filter((d) => force || !(fresh(d) && cache.data[`${metric}:${d}`]));
      const spans = [];
      for (const d of missing) { const last = spans[spans.length - 1]; if (last && daysBetween(last[1], d).length === 2) last[1] = d; else spans.push([d, d]); }
      await Promise.all(spans.map(async ([a, b]) => {
        const key = `${user}:${metric}:${a}:${b}`;
        if (!inflight.has(key)) {
          const prio = { background }, known = daysBetween(a, b).flatMap((d) => (cache.data[`${metric}:${d}`] || []).map((i) => ({ ...i, day: d })));
          inflight.set(key, { prio, done: searchRange(c, metric, a, b, user, prio, known).finally(() => inflight.delete(key)) });
        }
        // Background searches yield to page requests, so a page request awaiting a fetch the
        // warm loop started has to take it over, or each would wait on the other forever.
        const job = inflight.get(key);
        if (!background) lane.promote(job.prio);
        // When search keeps answering wrong for a range, that range keeps its saved days
        // (unsettled, so it is asked again next time) and the rest still refresh.
        let result;
        try { result = await job.done; }
        catch (e) { if (e.code !== "UNRELIABLE") throw e; log(`${e.message}; keeping saved data`); stale.push(`${metric} ${a}..${b}`); return; }
        for (const { day, items, unconfirmed } of result) {
          const k = `${metric}:${day}`;
          if (unconfirmed) {
            // Nothing could check this empty answer, and false ones come in bursts, so the
            // day settles only once another answer at least CONFIRM_MS later agrees. An
            // earlier settled empty counts as that answer. Until then it keeps what it had.
            const prior = cache.emptyAt[k] ?? (cache.fetchedAt[k] && cache.data[k]?.length === 0 ? cache.fetchedAt[k] : undefined);
            if (prior === undefined || Date.now() - prior < CONFIRM_MS) { cache.emptyAt[k] = prior ?? Date.now(); out[metric][day] = cache.data[k] || []; continue; }
          }
          delete cache.emptyAt[k];
          cache.data[k] = items; cache.fetchedAt[k] = Date.now(); out[metric][day] = items;
        }
      }));
      for (const d of days) if (!out[metric][d]) out[metric][d] = cache.data[`${metric}:${d}`] || [];
    }
    cache.save();
    return { user, from: fromKey, to: toKey, today: tKey, days, metrics: out, stale };
  }

  return { dailyData };
}
