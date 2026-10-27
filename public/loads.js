// How the activity tiles load. Loaded as a classic script by index.html (exposes
// window.Loads) and required by test/loads.test.js under Node.
//
// A load (a "round": the page opening, Refresh, or the timed poll) asks for the days
// each window needs one piece at a time, in the page's order — Today first — so each
// tile fills in as soon as its own days land instead of waiting on the whole range.
// Pieces never overlap. Refresh re-searches only the first window's (Today's) days, the
// ones that can still change; the server serves settled days from its cache, and
// forcing them cost a search per metric per piece, enough to trip GitHub's rate limit.
// The order is read again before every piece, so picking Custom mid-load moves it up.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.Loads = api;
})(this, function () {
  // Every answer is folded into what the page already holds. Each day keeps the newest
  // request's counts: an older request answering late can only fill days the newer one
  // didn't fetch. `seq` is the request's order; `at` maps day -> its seq.
  function hold(held, answer, seq) {
    const out = { metrics: {}, at: { ...held?.at } };
    for (const m of new Set([...Object.keys(held?.metrics || {}), ...Object.keys(answer.metrics)])) out.metrics[m] = { ...held?.metrics[m] };
    for (const d of answer.days) {
      if (out.at[d] > seq) continue;
      out.at[d] = seq;
      for (const m of Object.keys(answer.metrics)) out.metrics[m][d] = answer.metrics[m][d] || [];
    }
    return out;
  }
  // Whether every day is held from a request numbered `since` or later.
  const holds = (held, days, since = 0) => Boolean(held) && days.every((d) => held.at[d] >= since);

  // Splits windows (each an ascending run of day keys, most wanted first) into the
  // pieces to ask for: each day goes to the first window that needs it, days in `skip`
  // are left out, and what is left of a window comes back as contiguous runs.
  function plan(windows, skip) {
    const taken = new Set(skip), pieces = [];
    for (const days of windows) {
      let run = null;
      for (const d of days) {
        if (taken.has(d)) { run = null; continue; }
        taken.add(d);
        if (!run) pieces.push((run = []));
        run.push(d);
      }
    }
    return pieces;
  }

  // The order the tiles load in: Today, Yesterday, then the wider windows. A picked Custom
  // tile goes next after Yesterday; the other picks keep this order. The 30-day window
  // also covers the lists' closed and merged history.
  const tileOrder = (picked) => (picked === "custom" ? ["today", "yesterday", "custom", "7d", "30d"] : ["today", "yesterday", "7d", "30d", "custom"]);

  // fetch(from, to, force) answers { days, metrics, stale, pending }; windows() lists the
  // windows in the order they should load; onAnswer runs after each piece lands and
  // onStatus when a round starts or finishes asking.
  function createLoader({ fetch, windows, onAnswer = () => {}, onStatus = () => {} }) {
    let held = null, seq = 0, round = null;
    // A quiet round (the timed poll) keeps showing what is held while it checks for news;
    // any other round shows a day only once this round has loaded it, so a number on
    // screen is never one the load in progress is about to replace.
    function state(days) {
      if (!round) return "loading";
      if (holds(held, days, round.quiet ? 0 : round.first)) return "ready";
      if (days.some((d) => round.failed.has(d))) return holds(held, days) ? "old" : "failed";
      return "loading";
    }
    async function pump(r) {
      if (r.running) return;
      r.running = true; onStatus(r);
      while (round === r) {
        const done = Object.keys(held?.at || {}).filter((d) => held.at[d] >= r.first);
        const ws = windows(), [piece] = plan(ws, [...done, ...r.failed]);
        if (!piece) break;
        const s = ++seq, live = new Set(ws[0]);
        try {
          const a = await fetch(piece[0], piece[piece.length - 1], r.force && piece.some((d) => live.has(d)));
          held = hold(held, a, s);
          r.stale.push(...(a.stale || [])); r.pending.push(...(a.pending || []));
          onAnswer(a);
        } catch (e) {
          // Not asked again this round, or a refused piece would be retried forever.
          r.error = e; for (const d of piece) r.failed.add(d);
          onAnswer(null);
        }
      }
      r.running = false;
      if (round === r) onStatus(r);
    }
    return {
      start({ force = false, quiet = false } = {}) {
        round = { first: seq + 1, force, quiet, running: false, failed: new Set(), stale: [], pending: [], error: null };
        pump(round);
      },
      // The windows changed (a tile or range was picked): load what they now need.
      nudge() { if (round) pump(round); },
      busy: () => Boolean(round?.running),
      state,
      get held() { return held; },
    };
  }
  return { hold, holds, plan, createLoader, tileOrder };
});
