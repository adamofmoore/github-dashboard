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

  // Rolling ranges the Custom tile offers besides picking dates, beyond the fixed tiles
  // (today, yesterday, 7 and 30 days). Each is worked out from today, so a saved choice
  // stays "the past 3 months" tomorrow too. Months count back by calendar month; from
  // the 31st into a shorter month lands on that month's last day.
  const addMonths = (key, n) => { const [y,m,d] = key.split("-").map(Number); const last = new Date(y, m-1+n+1, 0).getDate(); return dayKey(new Date(y, m-1+n, Math.min(d, last))); };
  const monthStart = (key) => key.slice(0, 8) + "01";
  const PRESETS = [
    ["14d", "Past 2 weeks", (t) => [shift(t, -13), t]],
    ["thisMonth", "This month", (t) => [monthStart(t), t]],
    ["lastMonth", "Last month", (t) => [addMonths(monthStart(t), -1), shift(monthStart(t), -1)]],
    ["3m", "Past 3 months", (t) => [shift(addMonths(t, -3), 1), t]],
    ["6m", "Past 6 months", (t) => [shift(addMonths(t, -6), 1), t]],
    ["thisYear", "This year", (t) => [t.slice(0, 4) + "-01-01", t]],
    ["1y", "Past year", (t) => [shift(addMonths(t, -12), 1), t]],
  ];
  // The longest range the server fetches: a leap year plus the four days fetchRange
  // reaches below a window for the work-week baseline (server.mjs shares this).
  const MAX_RANGE_DAYS = 370;
  const presetRange = (id, t) => { const p = PRESETS.find(([key]) => key === id); if (!p) return null; const [from, to] = p[2](t); return { from, to }; };

  return { pad, dayKey, shift, today, daysBetween, isWorkDay, prevDay, addMonths, PRESETS, presetRange, MAX_RANGE_DAYS };
});
