import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { demoDaily, demoLive, demoRepos } from "./demo.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || "127.0.0.1";
const CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const CACHE_DIR = path.join(ROOT, "cache");
const SESSIONS_FILE = path.join(CACHE_DIR, "sessions.json");
const API = "https://api.github.com";
const WARM_DAYS = 90;
const DEMO = process.env.DEMO === "1";
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- owner token from gh ----------
let ownerToken = "";
try { ownerToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}

// ---------- day math (local timezone, midnight to midnight) ----------
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDay = (iso) => dayKey(new Date(iso));
function startOfDay(key) { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0); }
function endOfDay(key) { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999); }
function offsetIso(d) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function daysBetween(from, to) { const out = []; for (let d = startOfDay(from); d <= startOfDay(to); d.setDate(d.getDate() + 1)) out.push(dayKey(d)); return out; }
function shift(key, n) { const d = startOfDay(key); d.setDate(d.getDate() + n); return dayKey(d); }
const today = () => dayKey(new Date());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- per-token GitHub client with rate-limit awareness ----------
const RESERVE = 12;
const clients = new Map();
function client(token) {
  if (clients.has(token)) return clients.get(token);
  const c = {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "github-dashboard-local" },
    search: { remaining: 30, reset: 0 },
    userRequests: 0,
    login: null,
    async gh(url, init = {}, background = false) {
      const isSearch = url.includes("/search/");
      for (let attempt = 0; attempt < 6; attempt++) {
        if (background && isSearch) {
          while (c.userRequests > 0 || (c.search.remaining <= RESERVE && c.search.reset > Date.now())) await sleep(250);
          if (c.search.remaining <= RESERVE) c.search.remaining = 30;
        }
        const res = await fetch(url, { ...init, headers: { ...c.headers, ...(init.headers || {}) } });
        if (isSearch && res.headers.get("x-ratelimit-remaining") !== null) {
          c.search = { remaining: Number(res.headers.get("x-ratelimit-remaining")), reset: Number(res.headers.get("x-ratelimit-reset")) * 1000 };
        }
        if (res.status === 403 || res.status === 429) {
          const remaining = Number(res.headers.get("x-ratelimit-remaining"));
          const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
          const retryAfter = Number(res.headers.get("retry-after")) * 1000;
          const wait = retryAfter || (remaining === 0 && reset ? Math.max(reset - Date.now(), 1000) : 5000);
          console.log(`[${c.login || "?"}] rate limited; waiting ${Math.round(wait / 1000)}s`);
          await sleep(wait + 500);
          continue;
        }
        if (res.status === 401) { const e = new Error("GitHub rejected the token"); e.code = 401; throw e; }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
        return res.json();
      }
      throw new Error(`gave up after retries: ${url}`);
    },
    async me() { if (!c.login) c.login = (await c.gh(`${API}/user`)).login; return c.login; },
    async graphql(query, variables) {
      const r = await c.gh(`${API}/graphql`, { method: "POST", body: JSON.stringify({ query, variables }) });
      if (r.errors) throw new Error(JSON.stringify(r.errors));
      return r.data;
    },
  };
  clients.set(token, c);
  return c;
}

// ---------- sessions ----------
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch {}
function saveSessions() { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions), { mode: 0o600 }); }
function cookie(req, name) { const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return m ? m[1] : null; }
function sessionFor(req) {
  const sid = cookie(req, "ghdash");
  if (sid && sessions[sid]) return { ...sessions[sid], sid };
  const ip = req.socket.remoteAddress;
  if (ownerToken && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) return { token: ownerToken, owner: true };
  return null;
}
function newSession(res, token, login) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions[sid] = { token, login, created: new Date().toISOString() };
  saveSessions();
  res.setHeader("Set-Cookie", `ghdash=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`);
}

// ---------- device flow ----------
const pendingDevice = new Map();
async function deviceStart() {
  const r = await fetch("https://github.com/login/device/code", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: CLIENT_ID, scope: "repo read:org" }) });
  const j = await r.json();
  if (!j.device_code) throw new Error(j.error_description || "device flow failed");
  pendingDevice.set(j.device_code, { interval: j.interval || 5, last: 0 });
  return { device_code: j.device_code, user_code: j.user_code, verification_uri: j.verification_uri, interval: j.interval || 5, expires_in: j.expires_in };
}
async function devicePoll(device_code) {
  const p = pendingDevice.get(device_code);
  if (!p) return { status: "unknown" };
  if (Date.now() - p.last < p.interval * 1000) return { status: "pending" };
  p.last = Date.now();
  const r = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: CLIENT_ID, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) });
  const j = await r.json();
  if (j.access_token) { pendingDevice.delete(device_code); return { status: "ok", token: j.access_token }; }
  if (j.error === "slow_down") { p.interval += 5; return { status: "pending" }; }
  if (j.error === "authorization_pending") return { status: "pending" };
  pendingDevice.delete(device_code);
  return { status: "error", error: j.error_description || j.error };
}

// ---------- metrics ----------
const METRICS = {
  issuesOpened: { q: (u) => `author:${u} is:issue`, field: "created", ts: (i) => i.created_at },
  issuesClosed: { q: (u) => `assignee:${u} is:issue`, field: "closed", ts: (i) => i.closed_at },
  prsOpened: { q: (u) => `author:${u} is:pr`, field: "created", ts: (i) => i.created_at },
  prsClosed: { q: (u) => `author:${u} is:pr is:unmerged`, field: "closed", ts: (i) => i.closed_at },
  prsMerged: { q: (u) => `author:${u} is:pr`, field: "merged", ts: (i) => i.pull_request?.merged_at },
};
function slim(i) {
  return { repo: i.repository_url.replace(`${API}/repos/`, ""), number: i.number, title: i.title, url: i.html_url, state: i.state, state_reason: i.state_reason || null, draft: i.draft || false, created_at: i.created_at, closed_at: i.closed_at, merged_at: i.pull_request?.merged_at || null, is_pr: Boolean(i.pull_request) };
}
async function searchRange(c, metric, fromKey, toKey, user, background) {
  const m = METRICS[metric];
  const q = `${m.q(user)} ${m.field}:${offsetIso(startOfDay(fromKey))}..${offsetIso(endOfDay(toKey))}`;
  const first = await c.gh(`${API}/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=1`, {}, background);
  if (first.total_count > 1000 && fromKey !== toKey) {
    const days = daysBetween(fromKey, toKey), mid = days[Math.floor(days.length / 2) - 1], next = days[Math.floor(days.length / 2)];
    const [a, b] = await Promise.all([searchRange(c, metric, fromKey, mid, user, background), searchRange(c, metric, next, toKey, user, background)]);
    return a.concat(b);
  }
  let items = first.items;
  const pages = Math.min(10, Math.ceil(first.total_count / 100));
  for (let p = 2; p <= pages; p++) items = items.concat((await c.gh(`${API}/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${p}`, {}, background)).items);
  const buckets = {};
  for (const k of daysBetween(fromKey, toKey)) buckets[k] = [];
  for (const it of items) { const ts = m.ts(it); if (!ts) continue; const k = localDay(ts); if (buckets[k]) buckets[k].push(slim(it)); }
  return Object.entries(buckets).map(([day, list]) => ({ day, items: list }));
}

// ---------- per-user day cache ----------
const caches = new Map();
function cacheFor(login) {
  if (caches.has(login)) return caches.get(login);
  const file = path.join(CACHE_DIR, `days-${login}.json`);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  let timer = null;
  const entry = { data, save() { clearTimeout(timer); timer = setTimeout(() => fs.writeFileSync(file, JSON.stringify(data)), 250); } };
  caches.set(login, entry);
  return entry;
}
const inflight = new Map();
const FRESH_MS = 90 * 1000;
const freshness = new Map();
async function dailyData(c, fromKey, toKey, force, background = false) {
  const user = await c.me();
  const cache = cacheFor(user);
  const tKey = today(), days = daysBetween(fromKey, toKey), out = {};
  for (const metric of Object.keys(METRICS)) {
    out[metric] = {};
    const fresh = (d) => d < tKey || (Date.now() - (freshness.get(`${user}:${metric}:${d}`) || 0) < FRESH_MS);
    const missing = days.filter((d) => force || !(fresh(d) && cache.data[`${metric}:${d}`]));
    const spans = [];
    for (const d of missing) { const last = spans[spans.length - 1]; if (last && daysBetween(last[1], d).length === 2) last[1] = d; else spans.push([d, d]); }
    await Promise.all(spans.map(async ([a, b]) => {
      const key = `${user}:${metric}:${a}:${b}`;
      if (!inflight.has(key)) inflight.set(key, searchRange(c, metric, a, b, user, background).finally(() => inflight.delete(key)));
      for (const { day, items } of await inflight.get(key)) { cache.data[`${metric}:${day}`] = items; if (day >= tKey) freshness.set(`${user}:${metric}:${day}`, Date.now()); out[metric][day] = items; }
    }));
    for (const d of days) if (!out[metric][d]) out[metric][d] = cache.data[`${metric}:${d}`] || [];
  }
  cache.save();
  return { user, from: fromKey, to: toKey, today: tKey, days, metrics: out };
}

// ---------- live (GraphQL) ----------
async function searchAll(c, q, fragment) {
  const nodes = []; let after = null;
  for (let i = 0; i < 10; i++) {
    const data = await c.graphql(`query($q:String!,$after:String){ search(query:$q,type:ISSUE,first:100,after:$after){ issueCount pageInfo{hasNextPage endCursor} nodes{ ${fragment} } } }`, { q, after });
    nodes.push(...data.search.nodes.filter((n) => n && n.number));
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return nodes;
}
const ISSUE_FRAG = `... on Issue { number title url createdAt updatedAt repository{ nameWithOwner } labels(first:10){ nodes{ name color } } milestone{ title }
  linkedPrs: closedByPullRequestsReferences(first:10, includeClosedPrs:false){ nodes{ number url isDraft state repository{ nameWithOwner } } } }`;
const PR_FRAG = `... on PullRequest { number title url createdAt updatedAt isDraft reviewDecision mergeable headRefName baseRefName additions deletions repository{ nameWithOwner }
  labels(first:10){ nodes{ name color } } statusCheckRollup{ state } closingIssuesReferences(first:5){ nodes{ number title url } }
  reviewRequests(first:5){ nodes{ requestedReviewer{ ... on User{ login } ... on Team{ name } } } } }`;
function slimPr(n) {
  return { repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, created_at: n.createdAt, updated_at: n.updatedAt, draft: n.isDraft, reviewDecision: n.reviewDecision, mergeable: n.mergeable, checks: n.statusCheckRollup?.state || null, head: n.headRefName, base: n.baseRefName, additions: n.additions, deletions: n.deletions, labels: n.labels.nodes, closes: n.closingIssuesReferences.nodes, reviewers: n.reviewRequests.nodes.map((r) => r.requestedReviewer?.login || r.requestedReviewer?.name).filter(Boolean) };
}
async function liveData(c) {
  const user = await c.me();
  const [issues, prs, reviewRequests] = await Promise.all([
    searchAll(c, `assignee:${user} is:issue is:open`, ISSUE_FRAG),
    searchAll(c, `author:${user} is:pr is:open`, PR_FRAG),
    searchAll(c, `review-requested:${user} is:pr is:open`, PR_FRAG),
  ]);
  return { user, fetchedAt: new Date().toISOString(),
    issues: issues.map((n) => ({ repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, created_at: n.createdAt, updated_at: n.updatedAt, labels: n.labels.nodes, milestone: n.milestone?.title || null, linkedPrs: n.linkedPrs.nodes.map((p) => ({ repo: p.repository.nameWithOwner, number: p.number, url: p.url, draft: p.isDraft, state: p.state })) })),
    prs: prs.map(slimPr), reviewRequests: reviewRequests.map(slimPr) };
}

// ---------- local repos (owner only) ----------
const SCAN_ROOTS = (process.env.REPO_ROOTS || "~,~/Studio").split(",").map((r) => r.trim().replace(/^~/, process.env.HOME)).filter(Boolean);
const SKIP = new Set(["node_modules", "Library", ".worktrees", "worktrees", ".git", "Downloads", "Applications", "Movies", "Music", "Pictures", ...(process.env.REPO_SKIP || "Dropbox (Personal),TrainerRoad Dropbox").split(",").map((x) => x.trim()).filter(Boolean)]);
function remoteRepo(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, ".git", "config"), "utf8").match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
    const u = m && m[1].match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
    return u ? u[1] : null;
  } catch { return null; }
}
function scanRepos(root, depth, out) {
  if (depth < 0) return;
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.name === ".git")) { const r = remoteRepo(root); if (r) out.set(r.toLowerCase(), { repo: r, path: root }); return; }
  for (const e of entries) { if (!e.isDirectory() || SKIP.has(e.name) || (e.name.startsWith(".") && root === process.env.HOME)) continue; scanRepos(path.join(root, e.name), depth - 1, out); }
}
let localRepoCache = { at: 0, list: [] };
function localRepos() {
  if (Date.now() - localRepoCache.at < 10 * 60 * 1000) return localRepoCache.list;
  const out = new Map(); for (const r of SCAN_ROOTS) scanRepos(r, 6, out);
  localRepoCache = { at: Date.now(), list: [...out.values()].sort((a, b) => a.repo.localeCompare(b.repo)) };
  return localRepoCache.list;
}

// ---------- background warm for every known token ----------
let warming = false;
async function warm() {
  if (warming) return; warming = true;
  const tokens = new Set([ownerToken, ...Object.values(sessions).map((s) => s.token)].filter(Boolean));
  for (const token of tokens) {
    const c = client(token);
    try { const t = today(); await dailyData(c, shift(t, -1), t, true, true); await dailyData(c, shift(t, -(WARM_DAYS - 1)), t, false, true); }
    catch (e) { console.error(`warm failed for ${c.login || "?"}:`, e.message); }
  }
  warming = false;
}
if (!DEMO) { setTimeout(warm, 500); setInterval(warm, 5 * 60 * 1000); }

// ---------- http ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
function send(res, code, body, type = "application/json") { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(type.startsWith("application/json") ? JSON.stringify(body) : body); }
function readBody(req) { return new Promise((r) => { let s = ""; req.on("data", (d) => (s += d)).on("end", () => r(s)); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (DEMO && url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/auth/status" || url.pathname === "/api/me") return send(res, 200, { loggedIn: true, login: "octocat", owner: true, deviceFlow: false });
      if (url.pathname === "/api/live") return send(res, 200, demoLive(today()));
      if (url.pathname === "/api/repos") return send(res, 200, { repos: demoRepos });
      if (url.pathname === "/api/daily") {
        const to = url.searchParams.get("to") || today(), from = url.searchParams.get("from") || to, days = daysBetween(from, to);
        return send(res, 200, { user: "octocat", from, to, today: today(), days, metrics: demoDaily(days, today()) });
      }
      return send(res, 404, { error: "not found" });
    }
    if (url.pathname === "/api/auth/status") {
      const s = sessionFor(req);
      if (!s) return send(res, 200, { loggedIn: false, deviceFlow: Boolean(CLIENT_ID) });
      try { const login = await client(s.token).me(); return send(res, 200, { loggedIn: true, login, owner: Boolean(s.owner), deviceFlow: Boolean(CLIENT_ID) }); }
      catch (e) { if (e.code === 401) { if (s.sid) { delete sessions[s.sid]; saveSessions(); } return send(res, 200, { loggedIn: false, deviceFlow: Boolean(CLIENT_ID), error: "Saved token was rejected, sign in again" }); } throw e; }
    }
    if (url.pathname === "/api/auth/device/start" && req.method === "POST") {
      if (!CLIENT_ID) return send(res, 400, { error: "GITHUB_CLIENT_ID is not set on the server" });
      return send(res, 200, await deviceStart());
    }
    if (url.pathname === "/api/auth/device/poll" && req.method === "POST") {
      const { device_code } = JSON.parse(await readBody(req) || "{}");
      const r = await devicePoll(device_code);
      if (r.status === "ok") { const login = await client(r.token).me(); newSession(res, r.token, login); setTimeout(warm, 100); return send(res, 200, { status: "ok", login }); }
      return send(res, 200, r);
    }
    if (url.pathname === "/api/auth/token" && req.method === "POST") {
      const { token } = JSON.parse(await readBody(req) || "{}");
      if (!token || !/^[\w-]+$/.test(token)) return send(res, 400, { error: "Paste a GitHub token" });
      try { const login = await client(token).me(); newSession(res, token, login); setTimeout(warm, 100); return send(res, 200, { status: "ok", login }); }
      catch (e) { if (e.code === 401) return send(res, 401, { error: "GitHub rejected that token" }); throw e; }
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const sid = cookie(req, "ghdash"); if (sid) { delete sessions[sid]; saveSessions(); }
      res.setHeader("Set-Cookie", "ghdash=; Path=/; Max-Age=0"); return send(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/")) {
      const s = sessionFor(req);
      if (!s) return send(res, 401, { error: "Sign in with GitHub first" });
      const c = client(s.token);
      if (url.pathname === "/api/live") return send(res, 200, await liveData(c));
      if (url.pathname === "/api/me") return send(res, 200, { login: await c.me(), owner: Boolean(s.owner) });
      if (url.pathname === "/api/repos") return send(res, 200, { repos: s.owner ? localRepos() : [] });
      if (url.pathname === "/api/daily") {
        const to = url.searchParams.get("to") || today(), from = url.searchParams.get("from") || to;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return send(res, 400, { error: "bad range" });
        if (daysBetween(from, to).length > 366) return send(res, 400, { error: "range over 366 days" });
        c.userRequests++;
        try { return send(res, 200, await dailyData(c, from, to, url.searchParams.get("force") === "1")); } finally { c.userRequests--; }
      }
      return send(res, 404, { error: "not found" });
    }

    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    file = path.join(ROOT, "public", path.normalize(file));
    if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    console.error(e);
    if (e.code === 401) return send(res, 401, { error: "Sign in with GitHub first" });
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`github-dashboard → http://${HOST}:${PORT}${CLIENT_ID ? " (device-flow sign-in enabled)" : " (sign-in by pasted token only; set GITHUB_CLIENT_ID for one-click GitHub sign-in)"}`));
