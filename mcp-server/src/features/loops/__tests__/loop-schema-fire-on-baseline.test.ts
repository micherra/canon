/**
 * fire_on_baseline admissibility guard (ADR-0056).
 *
 * Split out of loop-schema.test.ts to keep both files under the 600-line lint cap
 * (noExcessiveLinesPerFile) rather than suppress the rule — see loop-schema.test.ts
 * for the general parseLoopDefinition test suite this complements.
 *
 * fire_on_baseline: true is valid iff `to` is set AND `from` is unset AND `append`
 * is not true. Any other combination is a parse-time rejection (fail-closed-by-default) —
 * this is the whole safety story that lets ADR-0002's default stand while the blindness
 * it named is fixed. See DESIGN.md § What makes this safe.
 */

import { describe, expect, it } from "vitest";
import { parseLoopDefinition } from "../loop-schema.ts";

// Minimal valid interval loop definition (the _probe shape, mirrors loop-schema.test.ts).
const validIntervalFrontmatter = {
  id: "_probe",
  title: "Loop Framework Probe",
  status: "active",
  trigger: {
    fired_by: "orchestrator",
    lifecycle_hook: "post-ship",
    firing_posture: {
      autonomous: "disabled",
      "light-touch": "disabled",
      supervised: "opt-in",
    },
  },
  mode: "interval",
  schedule: {
    interval: "1m",
    max_ticks: 3,
  },
  state: {
    scope: "workspace",
    path: "${WORKSPACE}/_probe-state.json",
    snapshot: ["tick_count"],
  },
  observe: {
    tools: [],
    mcp: [],
  },
  surface: {
    on_transition: [
      {
        field: "tick_count",
        to: "3",
        message: "Probe tick 3 reached — framework path proven.",
        terminate: true,
      },
    ],
  },
  terminate: {
    when: ["max_ticks_reached"],
  },
  guardrails: {
    mutates_build: false,
    forbidden_tools: [],
  },
};

describe("fire_on_baseline admissibility (ADR-0056)", () => {
  it("fire_on_baseline: true on a to-only rule → accepted", () => {
    const good = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            to: "BEHIND",
            fire_on_baseline: true,
            message: "State already alerting at baseline.",
          },
        ],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
  });

  it("fire_on_baseline omitted on a to-only rule → accepted (backward compat, undefined)", () => {
    const good = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            to: "BEHIND",
            message: "State already alerting at baseline.",
            // fire_on_baseline intentionally omitted
          },
        ],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rule = result.definition.surface.on_transition[0] as { fire_on_baseline?: boolean };
      expect(rule.fire_on_baseline).toBeUndefined();
    }
  });

  it("fire_on_baseline: false on a to-only rule → accepted (explicit opt-out)", () => {
    const good = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            to: "BEHIND",
            fire_on_baseline: false,
            message: "State already alerting at baseline.",
          },
        ],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rule = result.definition.surface.on_transition[0] as { fire_on_baseline?: boolean };
      expect(rule.fire_on_baseline).toBe(false);
    }
  });

  it("fire_on_baseline: true with no `to` (any-change rule) → rejected", () => {
    const bad = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            fire_on_baseline: true,
            message: "Any change.",
          },
        ],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/fire_on_baseline/i);
      expect(result.error).toMatch(/to/i);
    }
  });

  it("fire_on_baseline: true with append: true (flood/append class) → rejected", () => {
    const bad = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            to: "BEHIND",
            append: true,
            fire_on_baseline: true,
            message: "Append rule.",
          },
        ],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/fire_on_baseline/i);
      expect(result.error).toMatch(/append/i);
    }
  });

  it("fire_on_baseline: true with from: set (edge rule; baseline has no prior) → rejected", () => {
    const bad = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            from: "pending",
            to: "failure",
            fire_on_baseline: true,
            message: "Edge rule.",
          },
        ],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/fire_on_baseline/i);
      expect(result.error).toMatch(/from/i);
    }
  });

  it("fire_on_baseline: true with terminate: true (a baseline-fired rule would terminate the loop before it establishes a watch) → rejected", () => {
    const bad = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            to: "failure",
            fire_on_baseline: true,
            terminate: true,
            message: "Terminates on baseline.",
          },
        ],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/fire_on_baseline/i);
      expect(result.error).toMatch(/terminate/i);
    }
  });

  it("fire_on_baseline: true with no `to` AND append: true (both reasons) → rejected", () => {
    const bad = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            append: true,
            fire_on_baseline: true,
            message: "Both violations.",
          },
        ],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/fire_on_baseline/i);
    }
  });

  it("fire_on_baseline: true on a to-only rule → the field SURVIVES parse (dead-affordance guard, inverse of Probe 1's silent-strip finding)", () => {
    const good = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            to: "BEHIND",
            fire_on_baseline: true,
            message: "State already alerting at baseline.",
          },
        ],
      },
    };
    const result = parseLoopDefinition(good, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rule = result.definition.surface.on_transition[0];
      expect("fire_on_baseline" in rule).toBe(true);
      expect((rule as { fire_on_baseline?: boolean }).fire_on_baseline).toBe(true);
    }
  });

  it("every rejection flows through the parseLoopDefinition({ ok: false }) path (errors-as-values, never throws)", () => {
    const bad = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            append: true,
            fire_on_baseline: true,
            message: "Both violations.",
          },
        ],
      },
    };
    expect(() => parseLoopDefinition(bad, {})).not.toThrow();
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
  });
});
