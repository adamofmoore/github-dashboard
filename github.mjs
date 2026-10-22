// Per-token GitHub clients with rate-limit awareness. REST searches share one paced
// lane per GitHub login (ratelimit.mjs), since GitHub limits the account, not the token;
// other calls go through a per-token gate that remembers a rate limit and holds later
// calls until it ends. A secondary limit or retry-after penalises the whole account, so
// both paths share one penalty record per login.
import { searchLane, apiGate, accountPenalty } from "./ratelimit.mjs";
import { API } from "./activity.mjs";
import { graphqlError } from "./live-search.mjs";

export function createGitHub({ fetch = globalThis.fetch, log = () => {} } = {}) {
  const lanes = new Map(), penalties = new Map(), clients = new Map();
  function penaltyFor(login) {
    if (!penalties.has(login)) penalties.set(login, accountPenalty());
    return penalties.get(login);
  }
  function laneFor(login) {
    if (!lanes.has(login)) lanes.set(login, searchLane({ log: (m) => log(`[${login}] ${m}`), penalty: penaltyFor(login) }));
    return lanes.get(login);
  }
  function client(token) {
    if (clients.has(token)) return clients.get(token);
    let lookup = null;
    const c = {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "github-dashboard-local" },
      login: null,
      gate: apiGate({ log: (m) => log(`[${c.login || "?"}] ${m}`), account: () => (c.login ? penaltyFor(c.login) : null) }),
      async gh(url, init = {}, prio = { background: false }) {
        const send = () => fetch(url, { ...init, headers: { ...c.headers, ...(init.headers || {}) } });
        const { pathname } = new URL(url);
        const { res, body } = pathname.startsWith("/search/") ? await laneFor(await c.me()).request(send, prio) : await c.gate.request(send, pathname, pathname === "/graphql" ? "graphql" : "core");
        if (res.status === 401) { const e = new Error("GitHub rejected the token"); e.code = 401; throw e; }
        if (!res.ok) { const e = new Error(`${res.status} ${res.statusText}: ${body}`); e.status = res.status; throw e; }
        return JSON.parse(body);
      },
      // Concurrent callers share one lookup, so a rate limit it hits is seen by all of
      // them rather than one racing past it on a second lookup; a failed one is retried.
      async me() {
        if (c.login) return c.login;
        lookup ||= c.gh(`${API}/user`).then((u) => (c.login = u.login)).finally(() => { lookup = null; });
        return lookup;
      },
      async graphql(query, variables) {
        const r = await c.gh(`${API}/graphql`, { method: "POST", body: JSON.stringify({ query, variables }) });
        if (r.errors) throw graphqlError(r.errors);
        return r.data;
      },
    };
    clients.set(token, c);
    return c;
  }
  return { client, laneFor };
}
