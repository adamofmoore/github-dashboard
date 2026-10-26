// Which activity request a load should wait on. Loaded as a classic script by
// index.html (exposes window.Loads) and required by test/loads.test.js under Node.
// A forced refresh can take a minute. A plain load of the same range started during it
// (say a preset change, since presets share one fetch range) waits for that refresh
// rather than asking separately: a plain load answers at once from the cache, and,
// being newer, would win over the refresh and hide its result and warnings.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.Loads = api;
})(this, function () {
  function refreshSharing(fetch) {
    const refreshing = new Map(); // range -> the newest forced refresh of it still in flight
    return function load(key, force) {
      if (!force && refreshing.has(key)) return refreshing.get(key);
      const answer = fetch(key, force);
      if (force) {
        refreshing.set(key, answer);
        answer.then(() => {}, () => {}).then(() => { if (refreshing.get(key) === answer) refreshing.delete(key); });
      }
      return answer;
    };
  }
  // Every activity answer is folded into what the page already holds, so picking another
  // tile, the timed poll or a Refresh never hides numbers that are already known. Each day
  // keeps the newest request's counts: an older request answering late can only fill days
  // the newer one didn't fetch. `seq` is the request's order; `at` maps day -> its seq.
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
  const holds = (held, days) => Boolean(held) && days.every((d) => d in held.at);
  return { refreshSharing, hold, holds };
});
