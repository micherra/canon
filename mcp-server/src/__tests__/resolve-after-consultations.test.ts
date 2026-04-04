import { describe, expect, it } from "vitest";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { resolveAfterConsultations } from "../tools/resolve-after-consultations.ts";

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    consultations: {
      "perf-check": {
        agent: "canon:canon-researcher",
        fragment: "perf-check",
        role: "researcher",
        section: "## Performance",
      },
      "post-review-check": {
        agent: "canon:canon-security",
        fragment: "post-review-check",
        role: "security",
        timeout: "5m",
      },
    },
    description: "Test flow",
    entry: "review",
    name: "test-flow",
    spawn_instructions: {
      "perf-check": "Run performance check.",
      "post-review-check": "Run post-review check for ${task}.",
    },
    states: {
      review: {
        agent: "canon:canon-reviewer",
        consultations: {
          after: ["post-review-check"],
        },
        type: "single",
      },
    },
    ...overrides,
  };
}

// resolveAfterConsultations

describe("resolveAfterConsultations", () => {
  it("returns consultation prompts for valid after consultations", () => {
    const flow = makeFlow();
    const result = resolveAfterConsultations({
      flow,
      state_id: "review",
      variables: { task: "my-feature" },
      workspace: "/tmp/ws",
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
          agent: "canon:canon-reviewer",
          type: "single",
          // no consultations key at all
        },
      },
    });

    const result = resolveAfterConsultations({
      flow,
      state_id: "review",
      variables: {},
      workspace: "/tmp/ws",
    });

    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns empty array when state has consultations but no after array", () => {
    const flow = makeFlow({
      states: {
        review: {
          agent: "canon:canon-reviewer",
          consultations: {
            before: ["post-review-check"],
            // no "after" key
          },
          type: "single",
        },
      },
    });

    const result = resolveAfterConsultations({
      flow,
      state_id: "review",
      variables: {},
      workspace: "/tmp/ws",
    });

    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns warnings for consultation names not found in flow.consultations", () => {
    const flow = makeFlow({
      states: {
        review: {
          consultations: {
            after: ["missing-consultation"],
          },
          type: "single",
        },
      },
    });

    const result = resolveAfterConsultations({
      flow,
      state_id: "review",
      variables: {},
      workspace: "/tmp/ws",
    });

    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("missing-consultation");
  });

  it("returns warnings for consultation names without spawn instructions", () => {
    const flow = makeFlow({
      consultations: {
        "orphan-consult": {
          agent: "canon:canon-security",
          fragment: "orphan-consult",
          role: "security",
        },
      },
      spawn_instructions: {
        // "orphan-consult" intentionally missing
      },
      states: {
        review: {
          consultations: {
            after: ["orphan-consult"],
          },
          type: "single",
        },
      },
    });

    const result = resolveAfterConsultations({
      flow,
      state_id: "review",
      variables: {},
      workspace: "/tmp/ws",
    });

    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("orphan-consult");
  });

  it("includes timeout and section from consultation fragment when declared", () => {
    const flow = makeFlow({
      states: {
        review: {
          consultations: {
            after: ["perf-check"],
          },
          type: "single",
        },
      },
    });

    const result = resolveAfterConsultations({
      flow,
      state_id: "review",
      variables: {},
      workspace: "/tmp/ws",
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
      flow,
      state_id: "review",
      variables: { task: "substituted-value" },
      workspace: "/tmp/ws",
    });

    expect(result.consultation_prompts).toHaveLength(1);
    expect(result.consultation_prompts[0].prompt).toBe(
      "Run post-review check for substituted-value.",
    );
  });

  it("handles mixed valid and invalid consultation names (partial success)", () => {
    const flow = makeFlow({
      states: {
        review: {
          consultations: {
            after: ["post-review-check", "nonexistent"],
          },
          type: "single",
        },
      },
    });

    const result = resolveAfterConsultations({
      flow,
      state_id: "review",
      variables: { task: "mixed-test" },
      workspace: "/tmp/ws",
    });

    expect(result.consultation_prompts).toHaveLength(1);
    expect(result.consultation_prompts[0].name).toBe("post-review-check");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nonexistent");
  });

  it("returns empty when state_id not found in flow.states", () => {
    const flow = makeFlow();

    const result = resolveAfterConsultations({
      flow,
      state_id: "nonexistent-state",
      variables: {},
      workspace: "/tmp/ws",
    });

    expect(result.consultation_prompts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
