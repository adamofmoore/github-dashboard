import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4747);
const CACHE_FILE = path.join(ROOT, "cache", "days.json");
const API = "https://api.github.com";

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
if (!token) throw new Error("gh auth token returned nothing; run `gh auth login`");

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "github-dashboard-local",
};

let login = null;
async function me() {
  if (login) return login;
  const r = await fetch(`${API}/user`, { headers });
  login = (await r.json()).login;
  return login;
}

// ---------- rate-limit aware fetch ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gh(url, init = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (res.status === 403 || res.status === 429) {
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const retryAfter = Number(res.headers.get("retry-after")) * 1000;
      const wait = retryAfter || (remaining === 0 && reset ? Math.max(reset - Date.now(), 1000) : 5000);
      console.log(`rate limited on ${url.slice(0, 80)}; waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait + 500);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    return res.json();
  }
  throw new Error(`gave up after retries: ${url}`);
}

// ---------- day math (local timezone, midnight to midnight) ----------
const pad = (n) => String(n).padStart(2, "0");
function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localDay(iso) {
  return dayKey(new Date(iso));
}
function startOfDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function endOfDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}
function offsetIso(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function daysBetween(from, to) {
  const out = [];
  for (let d = startOfDay(from); d <= startOfDay(to); d.setDate(d.getDate() + 1)) out.push(dayKey(d));
  return out;
}
function today() {
  return dayKey(new Date());
}

// ---------- metrics ----------
// Each metric: search qualifier template, and which timestamp buckets it into a day.
const METRICS = {
  issuesOpened: { q: (u) => `author:${u} is:issue`, field: "created", ts: (i) => i.created_at },
  issuesClosed: { q: (u) => `assignee:${u} is:issue`, field: "closed", ts: (i) => i.closed_at },
  prsOpened: { q: (u) => `author:${u} is:pr`, field: "created", ts: (i) => i.created_at },
  prsClosed: { q: (u) => `author:${u} is:pr is:unmerged`, field: "closed", ts: (i) => i.closed_at },
  prsMerged: { q: (u) => `author:${u} is:pr`, field: "merged", ts: (i) => i.pull_request?.merged_at },
};

function slim(i) {
  const repo = i.repository_url.replace(`${API}/repos/`, "");
  return {
    repo,
    number: i.number,
    title: i.title,
    url: i.html_url,
    state: i.state,
    state_reason: i.state_reason || null,
    draft: i.draft || false,
    created_at: i.created_at,
    closed_at: i.closed_at,
    merged_at: i.pull_request?.merged_at || null,
    is_pr: Boolean(i.pull_request),
  };
}

async function searchRange(metric, fromKey, toKey, user) {
  const m = METRICS[metric];
  const range = `${offsetIso(startOfDay(fromKey))}..${offsetIso(endOfDay(toKey))}`;
  const q = `${m.q(user)} ${m.field}:${range}`;
  const first = await gh(`${API}/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=1`);
  if (first.total_count > 1000 && fromKey !== toKey) {
    const days = daysBetween(fromKey, toKey);
    const mid = days[Math.floor(days.length / 2) - 1];
    const next = days[Math.floor(days.length / 2)];
    const [a, b] = await Promise.all([searchRange(metric, fromKey, mid, user), searchRange(metric, next, toKey, user)]);
    return a.concat(b);
  }
  let items = first.items;
  const pages = Math.min(10, Math.ceil(first.total_count / 100));
  for (let p = 2; p <= pages; p++) {
    const r = await gh(`${API}/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${p}`);
    items = items.concat(r.items);
  }
  // re-filter into the requested day window by local time and bucket
  const buckets = {};
  for (const k of daysBetween(fromKey, toKey)) buckets[k] = [];
  for (const it of items) {
    const ts = m.ts(it);
    if (!ts) continue;
    const k = localDay(ts);
    if (buckets[k]) buckets[k].push(slim(it));
  }
  return Object.entries(buckets).map(([day, list]) => ({ day, items: list }));
}

// ---------- cache ----------
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
} catch {
  cache = {};
}
let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)), 250);
}

const inflight = new Map();
async function dailyData(fromKey, toKey, force) {
  const user = await me();
  const tKey = today();
  const days = daysBetween(fromKey, toKey);
  const out = {};
  for (const metric of Object.keys(METRICS)) {
    out[metric] = {};
    const missing = days.filter((d) => force || d >= tKey || !cache[`${metric}:${d}`]);
    // contiguous spans of missing days
    const spans = [];
    for (const d of missing) {
      const last = spans[spans.length - 1];
      if (last && daysBetween(last[1], d).length === 2) last[1] = d;
      else spans.push([d, d]);
    }
    await Promise.all(
      spans.map(async ([a, b]) => {
        const key = `${metric}:${a}:${b}`;
        if (!inflight.has(key)) {
          inflight.set(
            key,
            searchRange(metric, a, b, user).finally(() => inflight.delete(key)),
          );
        }
        const res = await inflight.get(key);
        for (const { day, items } of res) {
          if (day < tKey) cache[`${metric}:${day}`] = items;
          out[metric][day] = items;
        }
      }),
    );
    for (const d of days) if (!out[metric][d]) out[metric][d] = cache[`${metric}:${d}`] || [];
  }
  saveCache();
  return { user, from: fromKey, to: toKey, today: tKey, days, metrics: out };
}

// ---------- live (GraphQL) ----------
async function graphql(query, variables) {
  const r = await gh(`${API}/graphql`, { method: "POST", body: JSON.stringify({ query, variables }) });
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.data;
}

async function searchAll(q, fragment) {
  const nodes = [];
  let after = null;
  let count = 0;
  for (let i = 0; i < 10; i++) {
    const data = await graphql(
      `query($q:String!,$after:String){ search(query:$q,type:ISSUE,first:100,after:$after){ issueCount pageInfo{hasNextPage endCursor} nodes{ ${fragment} } } }`,
      { q, after },
    );
    count = data.search.issueCount;
    nodes.push(...data.search.nodes.filter((n) => n && n.number));
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return { count, nodes };
}

const ISSUE_FRAG = `... on Issue {
  number title url createdAt updatedAt
  repository{ nameWithOwner }
  labels(first:10){ nodes{ name color } }
  milestone{ title }
  linkedPrs: closedByPullRequestsReferences(first:10, includeClosedPrs:false){ nodes{ number url isDraft state repository{ nameWithOwner } } }
}`;
const PR_FRAG = `... on PullRequest {
  number title url createdAt updatedAt isDraft reviewDecision mergeable
  headRefName baseRefName additions deletions
  repository{ nameWithOwner }
  labels(first:10){ nodes{ name color } }
  statusCheckRollup{ state }
  closingIssuesReferences(first:5){ nodes{ number title url } }
  reviewRequests(first:5){ nodes{ requestedReviewer{ ... on User{ login } ... on Team{ name } } } }
}`;

async function liveData() {
  const user = await me();
  const [issues, prs, reviewRequests] = await Promise.all([
    searchAll(`assignee:${user} is:issue is:open`, ISSUE_FRAG),
    searchAll(`author:${user} is:pr is:open`, PR_FRAG),
    searchAll(`review-requested:${user} is:pr is:open`, PR_FRAG),
  ]);
  return {
    user,
    fetchedAt: new Date().toISOString(),
    issues: issues.nodes.map((n) => ({
      repo: n.repository.nameWithOwner,
      number: n.number,
      title: n.title,
      url: n.url,
      created_at: n.createdAt,
      updated_at: n.updatedAt,
      labels: n.labels.nodes,
      milestone: n.milestone?.title || null,
      linkedPrs: n.linkedPrs.nodes.map((p) => ({ repo: p.repository.nameWithOwner, number: p.number, url: p.url, draft: p.isDraft, state: p.state })),
    })),
    prs: prs.nodes.map(slimPr),
    reviewRequests: reviewRequests.nodes.map(slimPr),
  };
}
function slimPr(n) {
  return {
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    draft: n.isDraft,
    reviewDecision: n.reviewDecision,
    mergeable: n.mergeable,
    checks: n.statusCheckRollup?.state || null,
    head: n.headRefName,
    base: n.baseRefName,
    additions: n.additions,
    deletions: n.deletions,
    labels: n.labels.nodes,
    closes: n.closingIssuesReferences.nodes,
    reviewers: n.reviewRequests.nodes.map((r) => r.requestedReviewer?.login || r.requestedReviewer?.name).filter(Boolean),
  };
}

// ---------- http ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/api/live") return send(res, 200, await liveData());
    if (url.pathname === "/api/daily") {
      const to = url.searchParams.get("to") || today();
      const from = url.searchParams.get("from") || to;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return send(res, 400, { error: "bad range" });
      if (daysBetween(from, to).length > 366) return send(res, 400, { error: "range over 366 days" });
      return send(res, 200, await dailyData(from, to, url.searchParams.get("force") === "1"));
    }
    if (url.pathname === "/api/me") return send(res, 200, { login: await me() });
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    file = path.join(ROOT, "public", path.normalize(file));
    if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`github-dashboard → http://localhost:${PORT}`));
