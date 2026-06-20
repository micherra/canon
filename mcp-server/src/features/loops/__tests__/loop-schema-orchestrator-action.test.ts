/**
 * loop-schema orchestrator_action field tests (AC1 — Phase B+)
 *
 * Proves the optional `orchestrator_action` field on TransitionRuleSchema:
 * - Both valid vocabulary members parse correctly (derive-from-const)
 * - Unknown value is rejected fail-closed
 * - Omitted field is accepted (backward compat)
 *
 * Placed in a separate file to keep loop-schema.test.ts under the 600-line Biome limit.
 */

import { describe, expect, it } from "vitest";
import { parseLoopDefinition } from "../loop-schema.ts";

// Minimal valid interval loop definition (same base shape as loop-schema.test.ts)
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

describe("parseLoopDefinition — orchestrator_action field (AC1)", () => {
  it("[orch-action] 'auto-triage-fix' is a valid orchestrator_action value", () => {
    const good = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            to: "3",
            message: "Probe tick 3 reached.",
            terminate: true,
            orchestrator_action: "auto-triage-fix",
          },
        ],
      },
    };
    const result = parseLoopDefinition(good, { idFromFilename: "_probe" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rule = result.definition.surface.on_transition[0];
      expect(rule.orchestrator_action).toBe("auto-triage-fix");
    }
  });

  it("[orch-action] 'auto-plugin-update' is a valid orchestrator_action value", () => {
    const good = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            message: "Release tag cut.",
            orchestrator_action: "auto-plugin-update",
          },
        ],
      },
    };
    const result = parseLoopDefinition(good, { idFromFilename: "_probe" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rule = result.definition.surface.on_transition[0];
      expect(rule.orchestrator_action).toBe("auto-plugin-update");
    }
  });

  it("[orch-action] unknown value is rejected (fail-closed)", () => {
    const bad = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "tick_count",
            message: "Should fail.",
            orchestrator_action: "delete-everything",
          },
        ],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/orchestrator_action|delete-everything|Invalid/i);
    }
  });

  it("[orch-action] omitted orchestrator_action field is accepted (backward compat)", () => {
    // The existing validIntervalFrontmatter has no orchestrator_action — must still parse
    const result = parseLoopDefinition(validIntervalFrontmatter, { idFromFilename: "_probe" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rule = result.definition.surface.on_transition[0];
      expect(rule.orchestrator_action).toBeUndefined();
    }
  });
});
