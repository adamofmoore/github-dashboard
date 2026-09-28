const test = require("node:test");
const assert = require("node:assert/strict");
const { ZONES, zoneFor } = require("../public/triage.js");

const Z = Object.fromEntries(ZONES.map((z, i) => [z.z, i]));
const issue = (title, why = "", labels = []) => ({ title, why, labels: labels.map((name) => ({ name })) });
const cases = [
  ["P", issue("Anything at all", "", ["High Priority"])],
  ["P", issue("Anything at all", "", ["p1"])],
  ["Z6", issue("Protect TR_API_KEY: production environment + branch protection on main", "Any collaborator can read the global admin key")],
  ["Z6", issue("Login form", "Users cannot sign in after the token refresh")],
  ["Z6", issue("Sync job", "Leaks the session cookie into the log")],
  ["Z6", issue("Chart tooltip misaligned", "", ["security"])],
  ["Z5", issue("ViewEvents.spec.tsx is a load-dependent flake on the PR Build lane")],
  ["Z5", issue("Shared jest: sweep interval leaks across spec files and fails an unrelated test", "The shared jest suite intermittently fails SurveyResponseService.spec.ts")],
  ["Z5", issue("yarn test exits 0 whatever testAll returns")],
  ["Z5", issue("Sweep interval keeps running", "", ["flaky"])],
  ["Z3", issue("List view: touch-only admins have no pointer path to the day menu", "", ["a11y"])],
  ["Z3", issue("Modal traps keyboard focus on open")],
  ["Z2", issue("Decide the survey-submit contract: should a clicked Save survive a pre-Commit close")],
  ["Z2", issue("Unit_Test_Playwright_Project inherits retries: 2; decide whether a deterministic lane should retry at all")],
  ["Z2", issue("chore(i18n): yarn extract on master is not a no-op")],
  ["Z2", issue("Decommission the unused GitHub OAuth App after #36")],
  ["Z2", issue("Bump pinned Sveltia CMS 0.171.0 to latest")],
  ["Z2", issue("Logging: give the drop notice a tag disjoint from FileLogger (sequenced after TrainerRoadElectron#14200)")],
  ["Z2", issue("Four no-explicit-any sites carry a scoped disable pending a shared-contract narrowing")],
  ["Z2", issue("Per-PR staff previews on a staging forum (design, verified)")],
  ["Z2", issue("Gamepad navigation is D-pad-only", "", ["Needs Design Review", "P3"])],
  ["Z1", issue("Tracking: continuous gameplay, quality and performance audit")],
  ["Z1", issue("TrainNow: React Doctor audit master list (baseline 84/100, target 100/100)")],
  ["Z1", issue("🚀 Production master plan: web beta → paid launch → stores → marketing")],
  ["Z1", issue("Leaderboard on Mobile Workout Player", "", ["Workout Player", "Product Design Team"])],
  ["Z1", issue("Dark mode for the calendar", "", ["enhancement"])],
  ["Z4", issue("FTP-change handlers stage NeedsAdaptation after their only Commit(), so it is dropped")],
  ["Z4", issue("Power Ranking phenotype reports All-Rounder for a member missing one duration")],
  ["Z4", issue("Crashed-ride repair skips a ride whose workout metadata row is missing", "Found while working on #14312. Routed out because it is a separate concern.")],
];

for (const [zone, i] of cases) test(`${zone}: ${i.title}`, () => assert.equal(ZONES[zoneFor(i)].z, zone));

test("label beats title, title beats body", () => {
  assert.equal(ZONES[zoneFor(issue("Decide whether the lane retries", "", ["flaky"]))].z, "Z5");
  assert.equal(ZONES[zoneFor(issue("Tracking: crash audit", "Riders crash on every ride"))].z, "Z1");
  assert.equal(ZONES[zoneFor(issue("Rename the helper", "The old name is a security risk"))].z, "Z2");
});
test("tolerates missing fields", () => { assert.equal(ZONES[zoneFor({ title: "x" })].z, "Z4"); assert.equal(ZONES[zoneFor({ title: "", why: "", labels: [] })].z, "Z4"); });
