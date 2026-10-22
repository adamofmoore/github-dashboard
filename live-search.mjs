// Pages through GitHub's GraphQL `search` for the live lists (assigned issues, my open
// PRs, review requests). No I/O here: server.mjs passes in the request, and
// test/live-search.test.js pins the behaviour.
//
// Small pages: GitHub rejects a whole page with "Something went wrong while executing
// your query" once that page carries too much work. With bodyText and
// closedByPullRequestsReferences on every issue, a page of 66 assigned issues succeeded
// and the full 71 failed every time (2026-10-22). Pages of 25 leave headroom as the list
// grows, and a page GitHub still rejects is retried at half the size.
//
// Doubted empty answers: the same search sometimes answers `issueCount: 0, nodes: []`
// with no error. Believed as-is, that blanks a list silently. So an empty first page is
// asked again before it is believed, an empty later page (after GitHub said there was
// more) is an error, and a list that had results is believed empty only once a second
// fetch agrees (createLiveSearch).

export const PAGE_SIZE = 25;
export const MIN_PAGE_SIZE = 5;
export const EMPTY_RETRIES = 2;
export const RESULT_LIMIT = 1000; // GitHub search never returns more results than this

// client.graphql throws this, so the retry below can read GitHub's errors without
// parsing the message.
export function graphqlError(errors) {
  return Object.assign(new Error(JSON.stringify(errors)), { graphqlErrors: errors });
}

// True only when every error is GitHub's own failure to run a valid query. Bad queries,
// missing permissions or rate limits are not, because a smaller page would not fix them.
export function isGitHubQueryFailure(err) {
  const errors = err?.graphqlErrors;
  return Boolean(errors?.length) && errors.every((e) => /^Something went wrong while executing your query/.test(e?.message || ""));
}

// fetchPage(after, first) resolves to GraphQL's `search` object:
// { issueCount, pageInfo: { hasNextPage, endCursor }, nodes }.
// Returns every node, or throws. It never returns a partial list. `log` hears about
// each GitHub failure a retry worked around. Confirming a list that really is empty
// is not logged, because that happens on every poll. `lastCount` is how many results
// the previous fetch of this list returned.
export async function paginateSearch(fetchPage, { q, pageSize = PAGE_SIZE, minPageSize = MIN_PAGE_SIZE, emptyRetries = EMPTY_RETRIES, lastCount = 0, log = () => {} }) {
  const fail = (msg, cause) => new Error(`GitHub search "${q}" ${msg}`, cause ? { cause } : undefined);
  const out = [], seen = new Set();
  let after = null, size = pageSize, expected = null, empties = 0, dropped = 0;
  for (;;) {
    let page;
    try { page = await fetchPage(after, size); }
    catch (e) {
      // Anything else passes through untouched: server.mjs reads e.code === 401 to sign the user out.
      if (!isGitHubQueryFailure(e)) throw e;
      if (size <= minPageSize) throw fail(`failed at page size ${size}: ${e.message}`, e);
      const smaller = Math.max(minPageSize, Math.floor(size / 2));
      log(`GitHub could not run a page of ${size}; retrying that page at ${smaller}`);
      size = smaller;
      continue;
    }
    if (page.nodes.length === 0) {
      if (empties < emptyRetries) { empties++; continue; }
      if (after === null && page.issueCount === 0) {
        if (lastCount === 0) return out;
        throw Object.assign(fail(`found nothing ${emptyRetries + 1} times, but found ${lastCount} last time; an empty list is believed once the next fetch agrees`), { doubtedEmpty: true });
      }
      throw fail(`returned an empty page ${emptyRetries + 1} times after ${out.length + dropped} of ${expected ?? page.issueCount} results`);
    }
    if (empties) log(`GitHub returned ${empties} empty page${empties > 1 ? "s" : ""} at result ${out.length + dropped + 1} before this one; asking again recovered it`);
    empties = 0;
    expected ??= page.issueCount;
    for (const n of page.nodes) {
      // A node the token cannot see comes back null; it still counts toward issueCount.
      if (!n?.number) { dropped++; continue; }
      if (!seen.has(n.url)) { seen.add(n.url); out.push(n); }
    }
    const { hasNextPage, endCursor } = page.pageInfo;
    if (!hasNextPage || out.length + dropped >= RESULT_LIMIT) break;
    if (!endCursor || endCursor === after) throw fail(`did not advance past cursor ${after}`);
    after = endCursor;
  }
  const want = Math.min(expected, RESULT_LIMIT);
  if (out.length + dropped !== want) throw fail(`returned ${out.length + dropped} distinct results but reported ${want}`);
  if (expected > RESULT_LIMIT) log(`GitHub reports ${expected} results but search stops at ${RESULT_LIMIT}; the rest are not shown`);
  return out;
}

// Remembers how many results each list returned last time, so a list that had results
// is not blanked by one fetch's run of empty answers. The thrown error keeps the page on
// its last good list. If the next fetch is empty too, the list is believed empty.
export function createLiveSearch() {
  const last = new Map();
  return async (key, fetchPage, options) => {
    try {
      const nodes = await paginateSearch(fetchPage, { ...options, lastCount: last.get(key) ?? 0 });
      last.set(key, nodes.length);
      return nodes;
    } catch (e) {
      if (e.doubtedEmpty) last.set(key, 0);
      throw e;
    }
  };
}
