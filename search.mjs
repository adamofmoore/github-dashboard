// Reading every page of a GitHub search without believing its false empty answers.
// Search sometimes replies 200 with nothing found and nothing flagged for a query that
// has hundreds of results: 15 of 66 paced replies across three probes on 2026-10-22,
// sometimes two or more in a row, on every query shape tried, advanced_search included.
// Saving one would zero that range in the cache for good, so an empty answer needs
// corroboration.

export const EMPTY_TRIES = 3;

// An empty first page is believed once every item we already had in the range is shown
// to have left it (read directly, outside search), or, when that cannot be told, once
// two answers in a row agree. `stillThere` resolves true / false / null (cannot tell),
// and is itself null when nothing is known.
export async function firstPage(page, stillThere, label) {
  let still;
  for (let asks = 1; ; asks++) {
    const r = await page(1);
    if (r.total_count) return r;
    if (still === undefined) still = stillThere ? await stillThere() : null;
    if (still === false) return r;
    if (still === null) { if (asks >= 2) return r; continue; }
    if (asks >= EMPTY_TRIES) throw new Error(`GitHub search kept answering with no results for ${label}, though items known to be in it are still there`);
  }
}

// The rest of the pages, up to GitHub's 1000-result cap. A later page that comes back
// empty while the first promised more is the same glitch, and is asked again.
export async function restPages(page, first, label) {
  let items = first.items;
  const pages = Math.min(10, Math.ceil(first.total_count / 100));
  for (let p = 2; p <= pages; p++) {
    for (let tries = 1; ; tries++) {
      const r = await page(p);
      if (r.items.length) { items = items.concat(r.items); break; }
      if (tries >= EMPTY_TRIES) throw new Error(`GitHub search answered page ${p} of ${pages} with nothing ${EMPTY_TRIES} times for ${label}`);
    }
  }
  return items;
}
