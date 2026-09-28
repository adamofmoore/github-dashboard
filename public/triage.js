// Pickup-order classifier. Loaded as a classic script by index.html (exposes window.Triage)
// and required by test/triage.test.js under Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.Triage = api;
})(this, function () {
  const ZONES = [
    { z: "P", name: "Flagged high priority", color: "var(--zp)", blurb: "Labelled high priority on GitHub. Sits above everything else until the label comes off." },
    { z: "Z6", name: "Critical", color: "var(--z6)", blurb: "A user hits it, the whole team is blocked, or a secret is exposed. These come off the pile first." },
    { z: "Z5", name: "Broken instruments", color: "var(--z5)", blurb: "Gates, tests and tools that report the wrong thing. Every hour they stay red costs trust in every other result." },
    { z: "Z4", name: "Correctness debt", color: "var(--z4)", blurb: "Real defects with a bounded blast radius. The bulk of the pile, and where steady progress shows." },
    { z: "Z3", name: "Accessibility", color: "var(--z3)", blurb: "Keyboard, focus and screen-reader work, plus the primitives underneath them." },
    { z: "Z2", name: "Decisions and cleanup", color: "var(--z2)", blurb: "Policy calls, sequencing waits and dead code. Cheap to close, or not yours to decide alone." },
    { z: "Z1", name: "Plans and features", color: "var(--z1)", blurb: "Tracking issues, roadmaps and new capability. Nothing is broken; pick these up when the pile above is quiet." },
  ];
  const P = 0, Z6 = 1, Z5 = 2, Z4 = 3, Z3 = 4, Z2 = 5, Z1 = 6;
  const PRIORITY_LABELS = ["high priority", "high-priority", "priority: high", "priority/high", "p0", "p1", "urgent", "blocker"];

  // Each rule: zone, labels that force it, a title regex, and whether the regex may also match the body.
  // Order is precedence within a pass. Tracking issues and explicit decisions go first so a "crash" mentioned
  // inside "Tracking: crash audit" or "Decide whether the lane retries" does not outrank the issue's own framing.
  const RULES = [
    { zone: Z1, labels: ["tracking", "epic", "roadmap", "enhancement", "feature", "feature request", "product design team"],
      re: /\b(tracking|master (plan|list|issue)|roadmap|epic|milestone plan)\b|^tracking:/i, body: false },
    { zone: Z2, labels: [], re: /\b(decide|decision|should we|policy)\b/i, body: false },
    { zone: Z6, labels: ["critical", "sev1", "security"],
      re: /\b(crash(es|ing)?|data loss|outage|prod(uction)? (down|broken)|blocks? (the )?(team|release)|security|secret|(token|cookie|key|credential)s? (is |are )?(leak\w*|exposed)|leak\w* (the |a )?(\w+ )?(token|cookie|key|secret|credential)|credential|vulnerab\w*|cannot (log ?in|sign ?in)|critical|sev ?1)\b|api[ _-]?key|admin key/i, body: true },
    { zone: Z5, labels: ["flaky", "ci", "test-infra", "infra"],
      re: /\b(flaky|flake|intermittent(ly)?|false (green|red|pass|negative)|lane|ci|teamcity|burn-?in|gate|instrument|cannot see|reports? (green|the wrong)|test(s)? (fail|pass)|exits? 0|reds? clean)\b/i, body: true },
    { zone: Z3, labels: ["a11y", "accessibility"], re: /\b(a11y|accessib\w*|keyboard|focus|screen ?reader|aria|contrast|tab order)\b/i, body: true },
    { zone: Z2, labels: ["question", "decision", "cleanup", "chore", "docs", "documentation", "p3", "low priority", "nice to have", "dependencies"],
      re: /\b(cleanup|clean up|dead code|unused|remove|decommission|rename|bump|docs?|documentation|follow-?ups?|chore|tidy|housekeeping|deprecat\w*|question|design|pending|blocked on|sequenced after|record of)\b|^chore\b/i, body: false },
  ];

  function zoneFor(issue) {
    const labels = (issue.labels || []).map((l) => String(l.name || l).toLowerCase());
    if (labels.some((l) => PRIORITY_LABELS.includes(l))) return P;
    const title = issue.title || "", body = issue.why || "";
    for (const r of RULES) if (r.labels.some((l) => labels.includes(l))) return r.zone;
    for (const r of RULES) if (r.re.test(title)) return r.zone;
    for (const r of RULES) if (r.body && r.re.test(body)) return r.zone;
    return Z4;
  }

  return { ZONES, PRIORITY_LABELS, zoneFor };
});
