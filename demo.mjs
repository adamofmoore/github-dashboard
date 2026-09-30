// Deterministic fake data for screenshots and README. Enabled with DEMO=1.
const REPOS = ["acme/web", "acme/api", "acme/mobile", "acme/infra", "octocat/hello-world"];
const WORDS = ["Fix", "Add", "Refactor", "Remove", "Speed up", "Document", "Migrate", "Retry", "Cache", "Validate"];
const THINGS = ["login redirect", "billing webhook", "search index", "onboarding flow", "rate limiter", "dark mode toggle", "CSV export", "avatar upload", "feature flags", "release pipeline", "date picker", "notification badge"];
let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const title = () => `${pick(WORDS)} the ${pick(THINGS)}`;
let n = 1000;
const pad = (x) => String(x).padStart(2, "0");
const iso = (dayKey, h) => `${dayKey}T${pad(h)}:${pad(Math.floor(rnd() * 60))}:00Z`;

export function demoDaily(days, todayKey) {
  const metrics = { issuesOpened: {}, issuesClosed: {}, prsOpened: {}, prsMerged: {} };
  for (const d of days) {
    const dow = new Date(d + "T12:00:00").getDay();
    const weekend = dow === 0 || dow === 6;
    const scale = weekend ? 0.15 : 0.6 + rnd() * 0.8;
    const make = (count, kind) => Array.from({ length: Math.round(count * scale) }, () => {
      const repo = pick(REPOS), num = n++;
      const merged = kind === "merged", closed = kind === "closed" || merged, isPr = kind !== "issueOpen" && kind !== "issueClose";
      return { repo, number: num, title: title(), url: `https://github.com/${repo}/${isPr ? "pull" : "issues"}/${num}`, state: closed || kind === "issueClose" ? "closed" : "open", state_reason: kind === "issueClose" ? (rnd() < 0.15 ? "not_planned" : "completed") : null, draft: false, created_at: iso(d, 9), closed_at: closed || kind === "issueClose" ? iso(d, 15) : null, merged_at: merged ? iso(d, 16) : null, is_pr: isPr };
    });
    metrics.prsMerged[d] = make(12, "merged");
    metrics.prsOpened[d] = make(14, "open");
    metrics.issuesOpened[d] = make(6, "issueOpen");
    metrics.issuesClosed[d] = make(9, "issueClose");
  }
  return metrics;
}

export function demoLive(todayKey) {
  const issues = Array.from({ length: 14 }, (_, i) => { const repo = pick(REPOS), num = n++; const inflight = i < 5;
    return { repo, number: num, title: title(), url: `https://github.com/${repo}/issues/${num}`, created_at: iso(todayKey, 8), updated_at: iso(todayKey, 10 + (i % 6)), labels: rnd() < 0.5 ? [{ name: pick(["bug", "enhancement", "P1", "needs-design", "a11y", "flaky", "cleanup"]), color: "" }] : [], milestone: null, comments: Math.floor(rnd() * 4), why: `${pick(["Riders hit this on every", "Reproduces on master in the", "Blocks the release of the", "Wrong number shown in the", "Keyboard users cannot reach the"])} ${pick(THINGS)}.`, linkedPrs: inflight ? [{ repo, number: n, title: title(), url: `https://github.com/${repo}/pull/${n++}`, draft: rnd() < 0.3, state: "OPEN" }] : [] }; });
  const pr = (i) => { const repo = pick(REPOS), num = n++; const draft = i % 3 === 2;
    return { repo, number: num, title: title(), url: `https://github.com/${repo}/pull/${num}`, created_at: iso(todayKey, 8), updated_at: iso(todayKey, 9 + (i % 7)), draft, reviewDecision: draft ? null : pick(["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED", null]), mergeable: rnd() < 0.1 ? "CONFLICTING" : "MERGEABLE", checks: pick(["SUCCESS", "PENDING", "FAILURE", "SUCCESS"]), head: `feat/${pick(THINGS).replace(/ /g, "-")}`, base: "main", additions: Math.floor(rnd() * 400), deletions: Math.floor(rnd() * 120), labels: [], closes: rnd() < 0.5 ? [{ number: n, title: title(), url: `https://github.com/${repo}/issues/${n++}` }] : [], reviewers: rnd() < 0.5 ? [pick(["hubot", "mona", "octocat"])] : [] }; };
  return { user: "octocat", fetchedAt: new Date().toISOString(), issues, prs: Array.from({ length: 7 }, (_, i) => pr(i)), reviewRequests: Array.from({ length: 3 }, (_, i) => pr(i + 10)) };
}

export const demoRepos = REPOS.slice(0, 3).map((repo) => ({ repo, path: `/home/octocat/${repo.split("/")[1]}` }));

export function demoQuota() {
  const now = Date.now(), hours = (h) => new Date(now + h * 3600 * 1000).toISOString(), at = new Date(now - 4 * 60 * 1000).toISOString();
  const w = (name, pct, inHours) => ({ name, pct, resets_at: pct ? hours(inHours) : null });
  const acct = (id, label, five, seven, fable, fiveIn, sevenIn) => ({ file: `claude-${id}-${label}.json`, provider: "claude", id, label, fetched_at: at, windows: [w("5 hour", five, fiveIn), w("7 day", seven, sevenIn), w("Fable", fable, sevenIn)] });
  return { available: true, fetched_at: at, refreshing: false, accounts: [
    acct("a1b2c3d4", "octocat@acme.com-team", 73, 86, 67, 2.1, 65), acct("e5f6a7b8", "mona@acme.com", 25, 64, 100, 3.5, 112),
    acct("c9d0e1f2", "hubot@acme.com", 0, 100, 71, 0, 7), acct("13579bdf", "octocat@acme.com", 19, 13, 20, 4, 118),
    { file: "codex-2468ace0-octocat@acme.com-pro.json", provider: "codex", id: "2468ace0", label: "octocat@acme.com-pro", fetched_at: at, windows: [w("5 hour", 42, 1.5), w("7 day", 15, 150)], resets: { available: 3, expires_at: hours(130) } } ] };
}
