import { describe, expect, it } from "vitest";
import { parseLoopDefinition } from "../loop-schema.ts";

// Minimal valid interval loop definition (the _probe shape)
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

describe("parseLoopDefinition", () => {
  it("parses a valid interval definition successfully", () => {
    const result = parseLoopDefinition(validIntervalFrontmatter, { idFromFilename: "_probe" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.id).toBe("_probe");
      expect(result.definition.mode).toBe("interval");
      expect(result.definition.status).toBe("active");
    }
  });

  it("rejects when required schedule.max_ticks is missing on interval mode", () => {
    const bad = {
      ...validIntervalFrontmatter,
      schedule: { interval: "1m" }, // missing max_ticks
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/max_ticks|schedule/i);
    }
  });

  it("rejects when required schedule.interval is missing on interval mode", () => {
    const bad = {
      ...validIntervalFrontmatter,
      schedule: { max_ticks: 3 }, // missing interval
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
  });

  // dc-05 guardrail: self-paced + mutates_build:true must be rejected
  it("guardrail: rejects self-paced loop with mutates_build: true", () => {
    const bad = {
      ...validIntervalFrontmatter,
      mode: "self-paced",
      schedule: {
        cadence_hint: { active: "5m", idle: "30m" },
      },
      guardrails: {
        mutates_build: true, // VIOLATION
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/self-paced.*mutates_build|mutates_build.*false/i);
    }
  });

  // dc-05 guardrail: mutates_build:false + forbidden tool in observe must be rejected
  it("guardrail: rejects mutates_build:false with a forbidden tool in observe", () => {
    const bad = {
      ...validIntervalFrontmatter,
      observe: {
        tools: ["Edit"], // Edit is a build-mutating tool
        mcp: [],
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: ["Edit", "Write", "Bash"],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Edit|forbidden/i);
    }
  });

  // Cross-field: on_transition.field not in state.snapshot
  it("rejects when transition field is absent from state.snapshot", () => {
    const bad = {
      ...validIntervalFrontmatter,
      surface: {
        on_transition: [
          {
            field: "non_existent_field", // NOT in snapshot
            message: "Missing field transition",
          },
        ],
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/non_existent_field|snapshot/i);
    }
  });

  // id mismatch vs idFromFilename
  it("rejects when id does not match idFromFilename", () => {
    const result = parseLoopDefinition(validIntervalFrontmatter, { idFromFilename: "other-id" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/_probe|other-id|filename stem/i);
    }
  });

  // Scalar-where-list: snapshot given as a string, not array
  it("rejects scalar where list is required (snapshot as string)", () => {
    const bad = {
      ...validIntervalFrontmatter,
      state: {
        ...validIntervalFrontmatter.state,
        snapshot: "tick_count", // should be an array
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/list|array|snapshot/i);
    }
  });

  // Valid self-paced with mutates_build:false (reserved for Phase C, schema accepts it)
  it("accepts a valid self-paced definition with mutates_build: false", () => {
    const selfPaced = {
      ...validIntervalFrontmatter,
      mode: "self-paced",
      schedule: {
        cadence_hint: { active: "5m", idle: "30m" },
      },
      guardrails: {
        mutates_build: false,
        forbidden_tools: [],
      },
    };
    const result = parseLoopDefinition(selfPaced, {});
    expect(result.ok).toBe(true);
  });

  // Default status applied when omitted
  it("defaults status to 'active' when omitted", () => {
    const { status: _omitted, ...withoutStatus } = validIntervalFrontmatter;
    const result = parseLoopDefinition(withoutStatus, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.status).toBe("active");
    }
  });

  // on_transition scalar rejection (terminate.when as string)
  it("rejects scalar where list is required (terminate.when as string)", () => {
    const bad = {
      ...validIntervalFrontmatter,
      terminate: {
        when: "max_ticks_reached", // should be array
      },
    };
    const result = parseLoopDefinition(bad, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/list|array|when/i);
    }
  });
});
