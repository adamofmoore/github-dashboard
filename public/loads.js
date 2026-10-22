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
  return { refreshSharing };
});
