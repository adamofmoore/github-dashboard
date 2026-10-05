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
