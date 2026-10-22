const test = require("node:test");
const assert = require("node:assert/strict");
const { shift, daysBetween, isWorkDay, prevDay } = require("../public/dates.js");

// 2026-10-05 is a Monday, so this week runs Mon 05 .. Sun 11.
const MON = "2026-10-05", TUE = "2026-10-06", WED = "2026-10-07", THU = "2026-10-08";
const FRI = "2026-10-09", SAT = "2026-10-10", SUN = "2026-10-11";

test("the work week is Monday to Thursday", () => {
  assert.deepEqual([MON, TUE, WED, THU].map(isWorkDay), [true, true, true, true]);
  assert.deepEqual([FRI, SAT, SUN].map(isWorkDay), [false, false, false]);
});

test("without normalizing, the previous day is the previous calendar day", () => {
  for (const [day, expected] of [[MON, "2026-10-04"], [TUE, MON], [SAT, FRI], [SUN, SAT]])
    assert.equal(prevDay(day, false), expected, day);
});

test("normalizing, Monday looks back to the previous week's Thursday", () => {
  assert.equal(prevDay(MON, true), "2026-10-01");
  assert.equal(isWorkDay(prevDay(MON, true)), true);
});

test("normalizing, every day looks back to a work day", () => {
  const expected = { [MON]: "2026-10-01", [TUE]: MON, [WED]: TUE, [THU]: WED, [FRI]: THU, [SAT]: THU, [SUN]: THU };
  for (const [day, want] of Object.entries(expected)) assert.equal(prevDay(day, true), want, day);
});

test("the look-back never reaches more than four days", () => {
  let day = "2026-01-01", worst = 0;
  for (let i = 0; i < 400; i++) {
    worst = Math.max(worst, daysBetween(prevDay(day, true), day).length - 1);
    day = shift(day, 1);
  }
  assert.equal(worst, 4);
});

test("a day key survives both daylight-saving transitions", () => {
  assert.equal(prevDay("2026-03-09", true), "2026-03-05"); // spring forward, Mon -> Thu
  assert.equal(prevDay("2026-11-02", true), "2026-10-29"); // fall back, Mon -> Thu
  assert.equal(shift("2026-03-08", -1), "2026-03-07");
  assert.equal(shift("2026-11-01", -1), "2026-10-31");
});

// Mirrors fetchRange() in index.html: the fetched window must contain the day every
// single-day tile compares against, or that baseline silently counts as zero.
const fetchFrom = (today, customFrom, workWeek) => {
  const floor = shift(today, -29);
  return prevDay(customFrom < floor ? customFrom : floor, workWeek);
};

test("the fetched window always covers the day a tile compares against", () => {
  let today = "2026-01-01";
  for (let i = 0; i < 400; i++) {
    for (const workWeek of [false, true]) {
      const floor = shift(today, -29);
      for (const customFrom of daysBetween(floor, today)) {
        const from = fetchFrom(today, customFrom, workWeek);
        for (const tile of [today, prevDay(today, workWeek), customFrom])
          assert.ok(prevDay(tile, workWeek) >= from, `${today} ${customFrom} ${tile} ${workWeek}`);
      }
    }
    today = shift(today, 1);
  }
});

// ---------- Custom tile quick picks ----------
const { PRESETS, presetRange, addMonths, MAX_RANGE_DAYS } = require("../public/dates.js");
const range = (id, t) => { const r = presetRange(id, t); return `${r.from}..${r.to}`; };

test("each quick pick is a rolling range ending today, except last month", () => {
  const T = "2026-10-22";
  assert.equal(range("14d", T), "2026-10-09..2026-10-22", "14 days, today included");
  assert.equal(range("thisMonth", T), "2026-10-01..2026-10-22");
  assert.equal(range("lastMonth", T), "2026-09-01..2026-09-30");
  assert.equal(range("3m", T), "2026-07-23..2026-10-22");
  assert.equal(range("6m", T), "2026-04-23..2026-10-22");
  assert.equal(range("thisYear", T), "2026-01-01..2026-10-22");
  assert.equal(range("1y", T), "2025-10-23..2026-10-22");
  assert.equal(daysBetween(...range("1y", T).split("..")).length, 365);
  assert.equal(presetRange("nope", T), null);
});

test("quick picks cross year ends and short months correctly", () => {
  assert.equal(range("lastMonth", "2026-01-15"), "2025-12-01..2025-12-31");
  assert.equal(range("lastMonth", "2024-03-31"), "2024-02-01..2024-02-29", "leap February");
  assert.equal(range("3m", "2026-05-31"), "2026-03-01..2026-05-31", "Feb has no 31st: back to Feb 28, then the day after");
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(range("thisMonth", "2026-10-01"), "2026-10-01..2026-10-01", "the 1st is a one-day month so far");
  assert.equal(range("1y", "2024-02-29"), "2023-03-01..2024-02-29");
});

test("no quick pick duplicates a fixed tile, and every one fits a server request, leap years included", () => {
  for (const T of ["2026-10-22", "2024-02-29"]) {
  const fixed = new Set([1, 7, 30].map((n) => `${shift(T, 1 - n)}..${T}`));
  for (const [id] of PRESETS) {
    assert.ok(!fixed.has(range(id, T)), `${id} repeats a fixed tile`);
    // fetchRange reaches up to four days below the window for the work-week baseline.
    assert.ok(daysBetween(...range(id, T).split("..")).length + 4 <= MAX_RANGE_DAYS, `${id} is too long to fetch`);
  }
  }
});
