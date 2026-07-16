/**
 * Loop runner first-tick test (ADR-0002 + ADR-0056 executable proof — loops-phase-c-05)
 *
 * Proves the first-tick guard: the runner's diff algorithm must NOT fire
 * on_transition rules when the prior snapshot is absent (first tick) — with
 * exactly one exception (ADR-0056): a rule declaring fire_on_baseline: true
 * fires on an absent prior iff the observed value equals the rule's `to:`.
 *
 * This test uses the schema's LoopDefinition type and simulates the diff
 * algorithm described in /canon:loop-tick Step 5. Since the runner is an
 * agentic markdown skill (not TypeScript), we test the *schema* invariant that
 * supports the guard, plus a pure function that models the diff logic.
 *
 * ADR-0002 semantics (default, unchanged for every rule that does not opt in):
 * - Tick 1 (no prior): ALL fields have absent prior → zero rules fire → baseline captured
 * - Tick 2+ (prior present): rules fire normally on change
 *
 * ADR-0056 semantics (opt-in exception, schema-admissible only on to:-only,
 * non-append, non-from: rules — see loop-schema-fire-on-baseline.test.ts):
 * - Tick 1: a fire_on_baseline: true rule fires iff observed value === rule.to
 * - Tick 2+: the SAME rule follows the ordinary diff path with no special casing
 *   — BEHIND → BEHIND is not a change, so it does not re-fire (once-only, dc-03)
 *
 * AC #5 (from task-plan loops-phase-c-05 Brief Coverage row 5):
 * Tick 1 → zero surfaced rules + baseline written; Tick 2 with changed tick_count → rule fires.
 */

import { describe, expect, it } from "vitest";
import { parseLoopDefinition } from "../loop-schema.ts";

// ── Pure diff algorithm (models loop-tick.md Step 5) ─────────────────────────

type SnapshotValues = Record<string, string | number | boolean | null>;

type TransitionRule = {
  field: string;
  from?: string;
  to?: string;
  message: string;
  terminate?: boolean;
  fire_on_baseline?: boolean;
};

/**
 * Models the loop-tick Step 5 diff algorithm with first-tick guard (ADR-0002).
 *
 * Returns the list of fired rules.
 * A rule fires only when the prior value for the field is PRESENT (not absent/undefined).
 */
function diffSnapshot(
  prior: SnapshotValues | null,
  current: SnapshotValues,
  rules: TransitionRule[],
): TransitionRule[] {
  const fired: TransitionRule[] = [];
  for (const rule of rules) {
    // Absent prior: either the whole snapshot is absent (first tick, prior === null)
    // or this specific field is missing from a partial prior snapshot. Both are the
    // same condition ("no known prior value for this field") and are treated identically.
    const priorVal = prior === null ? undefined : prior[rule.field];
    const currentVal = current[rule.field];

    if (priorVal === undefined) {
      // ADR-0002 default: not a transition — zero rules fire.
      // ADR-0056 exception: a rule declaring fire_on_baseline: true fires on an
      // absent prior IFF the observed value equals the rule's `to:`. The schema
      // guarantees such a rule has `to` set, `from` unset, and is not `append` —
      // no other shape can carry the flag, so the any-change and append/flood
      // shapes never reach this branch with fire_on_baseline true (of these,
      // ADR-0002 names only the flood shape as noise; any-change is barred as
      // a matter of this opt-in's own design). A to:-matching false-fire (e.g. a hypothetical
      // to: "failure" rule) is NOT barred here — that sub-class is admissible
      // by the schema and governed by author judgment plus review, not by this
      // guard (see ADR-0056 § Consequences, corrected post-review).
      if (
        rule.fire_on_baseline === true &&
        rule.to !== undefined &&
        String(currentVal) === rule.to
      ) {
        fired.push(rule);
      }
      continue;
    }

    // Compare: field must have changed
    if (priorVal === currentVal) continue;
    // Optional from: match prior value
    if (rule.from !== undefined && String(priorVal) !== rule.from) continue;
    // Optional to: match new value
    if (rule.to !== undefined && String(currentVal) !== rule.to) continue;
    fired.push(rule);
  }
  return fired;
}

// ── Test fixture: self-paced probe definition ─────────────────────────────────

const selfPacedProbeFrontmatter = {
  id: "_probe-self-paced",
  title: "Self-Paced Probe",
  status: "active",
  trigger: {
    fired_by: "orchestrator",
    lifecycle_hook: "session-start",
    firing_posture: {
      autonomous: "disabled",
      "light-touch": "disabled",
      supervised: "opt-in",
    },
  },
  mode: "self-paced",
  schedule: {
    cadence_hint: { active: "1m", idle: "5m" },
    max_wall: "0",
  },
  state: {
    scope: "session",
    path: "${WORKSPACE}/_probe-self-paced-state.json",
    snapshot: ["tick_count"],
  },
  observe: { tools: [], mcp: [], shell_commands: [] },
  surface: {
    on_transition: [
      { field: "tick_count", to: "3", message: "Probe tick 3 reached.", terminate: true },
    ],
  },
  terminate: { when: ["max_wall_reached"] },
  guardrails: {
    mutates_build: false,
    forbidden_tools: ["Edit", "Write", "get_next_escalation_strategy"],
  },
};

describe("first-tick guard (ADR-0002) — pure diff algorithm", () => {
  const rules: TransitionRule[] = [
    { field: "tick_count", to: "3", message: "Tick 3 reached.", terminate: true },
  ];

  it("tick 1: prior is null (absent state file) → zero rules fire (baseline captured)", () => {
    const prior: SnapshotValues | null = null;
    const current: SnapshotValues = { tick_count: 1 };
    const fired = diffSnapshot(prior, current, rules);
    expect(fired).toHaveLength(0);
  });

  it("tick 2: prior present but tick_count is 2, not 3 → rule does not fire", () => {
    const prior: SnapshotValues = { tick_count: 1 };
    const current: SnapshotValues = { tick_count: 2 };
    const fired = diffSnapshot(prior, current, rules);
    expect(fired).toHaveLength(0);
  });

  it("tick 3: prior present, tick_count transitions to 3 → rule fires (ADR-0002 proof)", () => {
    const prior: SnapshotValues = { tick_count: 2 };
    const current: SnapshotValues = { tick_count: 3 };
    const fired = diffSnapshot(prior, current, rules);
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toContain("Tick 3");
    expect(fired[0].terminate).toBe(true);
  });

  it("tick 1 with already-true condition → still zero rules fire (eliminates false-fires)", () => {
    // Even if current value matches 'to: "3"', tick-1 guard prevents firing
    const prior: SnapshotValues | null = null;
    const current: SnapshotValues = { tick_count: 3 }; // already at 3 at arm time
    const fired = diffSnapshot(prior, current, rules);
    expect(fired).toHaveLength(0);
  });

  it("field with absent prior in partial snapshot → not a transition", () => {
    // prior has tick_count but not a new field added later
    const prior: SnapshotValues = { tick_count: 1 };
    const current: SnapshotValues = { tick_count: 1, new_field: "something" };
    const newFieldRule: TransitionRule[] = [{ field: "new_field", message: "New field appeared." }];
    const fired = diffSnapshot(prior, current, newFieldRule);
    expect(fired).toHaveLength(0); // new_field absent in prior → not a transition
  });

  it("any-change rule (no from/to) still respects absent-prior guard", () => {
    const anyChangeRule: TransitionRule[] = [
      { field: "tick_count", message: "Tick changed." }, // no from, no to
    ];
    // Tick 1: prior absent → zero fires
    const fired1 = diffSnapshot(null, { tick_count: 1 }, anyChangeRule);
    expect(fired1).toHaveLength(0);
    // Tick 2: prior present, value changed → fires
    const fired2 = diffSnapshot({ tick_count: 1 }, { tick_count: 2 }, anyChangeRule);
    expect(fired2).toHaveLength(1);
  });
});

describe("fire_on_baseline (ADR-0056) — pure diff algorithm", () => {
  const mergeStateRules: TransitionRule[] = [
    {
      field: "merge_state",
      to: "BEHIND",
      fire_on_baseline: true,
      message: "PR branch is behind main.",
    },
  ];

  it("tick 1: fire_on_baseline rule, observed equals `to` → fires (dc-03)", () => {
    const prior: SnapshotValues | null = null;
    const current: SnapshotValues = { merge_state: "BEHIND" };
    const fired = diffSnapshot(prior, current, mergeStateRules);
    expect(fired).toHaveLength(1);
    expect(fired[0].message).toContain("behind main");
  });

  it("tick 2: same rule, BEHIND → BEHIND unchanged → does not re-fire (dc-03 once-only)", () => {
    const prior: SnapshotValues = { merge_state: "BEHIND" };
    const current: SnapshotValues = { merge_state: "BEHIND" };
    const fired = diffSnapshot(prior, current, mergeStateRules);
    expect(fired).toHaveLength(0);
  });

  it("tick 1: fire_on_baseline rule, observed does NOT equal `to` (healthy) → fires nothing (dc-04)", () => {
    const prior: SnapshotValues | null = null;
    const current: SnapshotValues = { merge_state: "CLEAN" };
    const fired = diffSnapshot(prior, current, mergeStateRules);
    expect(fired).toHaveLength(0);
  });

  it("tick 1: all-healthy snapshot, mixed opted-in + normal rules → zero rules fire (dc-04)", () => {
    const mixedRules: TransitionRule[] = [
      { field: "merge_state", to: "BEHIND", fire_on_baseline: true, message: "Behind." },
      { field: "ci_conclusion", from: "pending", to: "failure", message: "CI failed." },
      { field: "release_tag", message: "Tag changed." }, // any-change, no flag
    ];
    const prior: SnapshotValues | null = null;
    const current: SnapshotValues = {
      merge_state: "CLEAN",
      ci_conclusion: "success",
      release_tag: "v1.0.0",
    };
    const fired = diffSnapshot(prior, current, mixedRules);
    expect(fired).toHaveLength(0);
  });

  it("tick 1: rule WITHOUT the flag, already-true condition → fires nothing (existing case, must still pass)", () => {
    const noFlagRule: TransitionRule[] = [
      { field: "merge_state", to: "BEHIND", message: "Behind (no flag)." },
    ];
    const prior: SnapshotValues | null = null;
    const current: SnapshotValues = { merge_state: "BEHIND" };
    const fired = diffSnapshot(prior, current, noFlagRule);
    expect(fired).toHaveLength(0);
  });

  it("tick 2+: opted-in rule, genuine CLEAN → BEHIND transition → fires (normal path unaffected)", () => {
    const prior: SnapshotValues = { merge_state: "CLEAN" };
    const current: SnapshotValues = { merge_state: "BEHIND" };
    const fired = diffSnapshot(prior, current, mergeStateRules);
    expect(fired).toHaveLength(1);
  });
});

describe("first-tick guard — _probe-self-paced schema valid (AC #5 precondition)", () => {
  it("_probe-self-paced definition parses successfully (schema → runner proof prerequisite)", () => {
    const result = parseLoopDefinition(selfPacedProbeFrontmatter, {
      idFromFilename: "_probe-self-paced",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.mode).toBe("self-paced");
      expect(result.definition.guardrails.mutates_build).toBe(false);
    }
  });

  it("_probe-self-paced forbidden tools are NOT in observe (guardrail-passing, not bypassing)", () => {
    const result = parseLoopDefinition(selfPacedProbeFrontmatter, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const observeSet = new Set([
        ...result.definition.observe.tools,
        ...result.definition.observe.mcp,
      ]);
      for (const tool of result.definition.guardrails.forbidden_tools) {
        expect(observeSet.has(tool)).toBe(false);
      }
    }
  });
});
