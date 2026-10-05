// Local-day math for the activity tiles. Loaded as a classic script by index.html
// (exposes window.Dates) and required by test/dates.test.js under Node.
// Every key is a local `YYYY-MM-DD`; nothing here reads a clock time, so a DST
// transition cannot move a day key.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.Dates = api;
})(this, function () {
  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const shift = (key, n) => { const [y,m,d] = key.split("-").map(Number); return dayKey(new Date(y, m-1, d+n)); };
  const today = () => dayKey(new Date());
  const daysBetween = (a, b) => { const out = []; for (let d = a; d <= b; d = shift(d, 1)) out.push(d); return out; };

  // The work week is Monday to Thursday.
  const isWorkDay = (key) => { const [y,m,d] = key.split("-").map(Number); const dow = new Date(y, m-1, d).getDay(); return dow >= 1 && dow <= 4; };

  // The day a tile compares against. With the work week on, that is the previous
  // *work* day, so Monday looks back to the previous week's Thursday. At most
  // three extra steps back (Mon -> Sun -> Sat -> Fri -> Thu).
  const prevDay = (key, workWeek) => { let d = shift(key, -1); if (workWeek) while (!isWorkDay(d)) d = shift(d, -1); return d; };

  return { pad, dayKey, shift, today, daysBetween, isWorkDay, prevDay };
});
