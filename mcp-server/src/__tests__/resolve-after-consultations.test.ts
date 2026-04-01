import { describe, expect, it } from "vitest";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { resolveAfterConsultations } from "../tools/resolve-after-consultations.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "review",
    states: {
      review: {
        type: "single",
        agent: "canon:canon-reviewer",
        consultations: {
          after: ["post-review-check"],
        },
      },
    },
    spawn_instructions: {
      "post-review-check": "Run post-review check for ${task}.",
      "perf-check": "Run performance check.",
    },
    consultations: {
      "post-review-check": {
        fragment: "post-review-check",
        agent: "canon:canon-security",
        role: "security",
        timeout: "5m",
      },
      "perf-check": {
        fragment: "perf-check",
        agent: "canon:canon-researcher",
        role: "researcher",
        section: "## Performance",
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveAfterConsultations
// ---------------------------------------------------------------------------

describe("resolveAfterConsultations", () => {
  it("returns consultation prompts for valid after consultations", () => {
    const flow = makeFlow();
    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "review",
      flow,
      variables: { task: "my-feature" },
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.consultation_prompts).toHaveLength(1);
    expect(result.consultation_prompts[0].name).toBe("post-review-check");
    expect(result.consultation_prompts[0].agent).toBe("canon:canon-security");
    expect(result.consultation_prompts[0].role).toBe("security");
    expect(result.consultation_prompts[0].prompt).toBe("Run post-review check for my-feature.");
  });

  it("returns empty array when state has no consultations defined", () => {
    const flow = makeFlow({
      states: {
        review: {
          type: "single",
          agent: "canon:canon-reviewer",
          // no consultations key at all
        },
      },
    });

    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "review",
      flow,
      variables: {},
    });

    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns empty array when state has consultations but no after array", () => {
    const flow = makeFlow({
      states: {
        review: {
          type: "single",
          agent: "canon:canon-reviewer",
          consultations: {
            before: ["post-review-check"],
            // no "after" key
          },
        },
      },
    });

    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "review",
      flow,
      variables: {},
    });

    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns warnings for consultation names not found in flow.consultations", () => {
    const flow = makeFlow({
      states: {
        review: {
          type: "single",
          consultations: {
            after: ["missing-consultation"],
          },
        },
      },
    });

    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "review",
      flow,
      variables: {},
    });

    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("missing-consultation");
  });

  it("returns warnings for consultation names without spawn instructions", () => {
    const flow = makeFlow({
      states: {
        review: {
          type: "single",
          consultations: {
            after: ["orphan-consult"],
          },
        },
      },
      consultations: {
        "orphan-consult": {
          fragment: "orphan-consult",
          agent: "canon:canon-security",
          role: "security",
        },
      },
      spawn_instructions: {
        // "orphan-consult" intentionally missing
      },
    });

    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "review",
      flow,
      variables: {},
    });

    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("orphan-consult");
  });

  it("includes timeout and section from consultation fragment when declared", () => {
    const flow = makeFlow({
      states: {
        review: {
          type: "single",
          consultations: {
            after: ["perf-check"],
          },
        },
      },
    });

    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "review",
      flow,
      variables: {},
    });

    expect(result.consultation_prompts).toHaveLength(1);
    const entry = result.consultation_prompts[0];
    expect(entry.section).toBe("## Performance");
    // perf-check has no timeout in makeFlow
    expect("timeout" in entry).toBe(false);
  });

  it("substitutes variables in spawn instruction prompt text", () => {
    const flow = makeFlow();
    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "review",
      flow,
      variables: { task: "substituted-value" },
    });

    expect(result.consultation_prompts).toHaveLength(1);
    expect(result.consultation_prompts[0].prompt).toBe("Run post-review check for substituted-value.");
  });

  it("handles mixed valid and invalid consultation names (partial success)", () => {
    const flow = makeFlow({
      states: {
        review: {
          type: "single",
          consultations: {
            after: ["post-review-check", "nonexistent"],
          },
        },
      },
    });

    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "review",
      flow,
      variables: { task: "mixed-test" },
    });

    expect(result.consultation_prompts).toHaveLength(1);
    expect(result.consultation_prompts[0].name).toBe("post-review-check");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nonexistent");
  });

  it("returns empty when state_id not found in flow.states", () => {
    const flow = makeFlow();

    const result = resolveAfterConsultations({
      workspace: "/tmp/ws",
      state_id: "nonexistent-state",
      flow,
      variables: {},
    });

    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
