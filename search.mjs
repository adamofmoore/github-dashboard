// Reading every page of a GitHub search without believing its false empty answers.
// Search sometimes replies 200 with nothing found and nothing flagged for a query that
// has hundreds of results: about one reply in four on 2026-10-22, often several in a
// row, for every query shape tried, advanced_search included. Saving one would zero
// that range in the cache for good, so an empty answer needs corroboration.

export const EMPTY_TRIES = 3;

// An empty first page is believed once an item we already had in the range is shown to
// have left it (read directly, outside search), or, with nothing known, once two answers
// in a row agree. `stillThere` is null when nothing is known.
export async function firstPage(page, stillThere, label) {
  let still;
  for (let asks = 1; ; asks++) {
    const r = await page(1);
    if (r.total_count) return r;
    if (!stillThere) { if (asks >= 2) return r; continue; }
    still ??= await stillThere();
    if (!still) return r;
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
