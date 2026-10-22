// Reading every page of a GitHub search without believing its false empty answers.
// Search sometimes replies 200 with nothing found and nothing flagged for a query that
// has hundreds of results: 15 of 66 paced replies across three probes on 2026-10-22,
// sometimes two or more in a row, on every query shape tried, advanced_search included.
// Saving one would zero that range in the cache for good, so an empty answer needs
// corroboration. A reply GitHub itself flags incomplete_results (it timed out) is asked
// again too.

export const EMPTY_TRIES = 3;
// GitHub kept answering wrong; the caller keeps what it had for this range.
const unreliable = (msg) => Object.assign(new Error(msg), { code: "UNRELIABLE" });

// `splittable`: an oversized first page (over 1000 results) is only used to split the
// range into smaller searches, so it need not be complete.
async function complete(page, p, label, splittable = false) {
  for (let tries = 1; ; tries++) {
    const r = await page(p);
    if (!r.incomplete_results || (splittable && r.total_count > 1000)) return r;
    if (tries >= EMPTY_TRIES) throw unreliable(`GitHub search timed out on page ${p} ${EMPTY_TRIES} times for ${label}`);
  }
}

// An empty first page is believed once every item we already had in the range is shown
// to have left it (read directly, outside search). When that cannot be told it is
// returned after two empty answers in a row, marked `unconfirmed` so the caller can
// hold off settling it. `stillThere` resolves true / false / null (cannot tell), and is
// itself null when nothing is known.
export async function firstPage(page, stillThere, label, splittable = false) {
  let still;
  for (let asks = 1; ; asks++) {
    const r = await complete(page, 1, label, splittable);
    if (r.total_count) return r;
    if (still === undefined) still = stillThere ? await stillThere() : null;
    if (still === false) return r;
    if (still === null) { if (asks >= 2) return { ...r, unconfirmed: true }; continue; }
    if (asks >= EMPTY_TRIES) throw unreliable(`GitHub search kept answering with no results for ${label}, though items known to be in it are still there`);
  }
}

// The rest of the pages, up to GitHub's 1000-result cap. A later page that comes back
// empty while the first promised more is the same glitch and is asked again. A page
// whose total differs from the first's may mean the results changed underneath; if a
// fresh first page confirms the new total, the pages already read are out of date
// (items left, or shifted between pages), so paging starts over from that fresh page.
export async function restPages(page, first, label) {
  let items = first.items, total = first.total_count, pages = Math.min(10, Math.ceil(total / 100)), restarts = 0;
  for (let p = 2; p <= pages; p++) {
    for (let tries = 1; ; tries++) {
      const r = await complete(page, p, label);
      if (r.items.length && r.total_count === total) { items = items.concat(r.items); break; }
      const now = await complete(page, 1, label);
      if (now.total_count && now.total_count !== total) {
        if (++restarts > EMPTY_TRIES) throw unreliable(`GitHub search kept changing while paging for ${label}`);
        // Past the cap the range would have been split; capping it here would drop items.
        if (total <= 1000 && now.total_count > 1000) throw unreliable(`GitHub search grew past 1000 results while paging for ${label}`);
        items = now.items; total = now.total_count; pages = Math.min(10, Math.ceil(total / 100)); p = 1;
        break;
      }
      // The first page still shows the same total, so this page was the odd one; a false
      // empty first page confirms nothing, so that is asked again.
      if (r.items.length && now.total_count === total) { items = items.concat(r.items); break; }
      if (tries >= EMPTY_TRIES) throw unreliable(`GitHub search answered page ${p} of ${pages} wrongly ${EMPTY_TRIES} times for ${label}`);
    }
  }
  // The pages can still disagree among themselves (a short page while the first keeps its
  // total, or page edges that shifted so one item shows twice and another not at all);
  // what they add up to has to be what GitHub said there was, each once, or nothing is saved.
  if (items.length !== Math.min(total, 1000)) throw unreliable(`GitHub search returned ${items.length} of ${total} results for ${label}`);
  if (new Set(items.map((i) => i.id)).size !== items.length) throw unreliable(`GitHub search returned the same item on two pages for ${label}`);
  return items;
}
