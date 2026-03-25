import { describe, it, expect } from "vitest";
import {
  executeConsultations,
  resolveConsultationPrompt,
  type ConsultationInput,
} from "../orchestration/consultation-executor.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "start",
    states: {
      start: { type: "terminal" },
    },
    spawn_instructions: {
      "security-check": "Run security audit for ${task}.",
      "perf-check": "Run performance check.",
    },
    consultations: {
      "security-check": {
        fragment: "security-check",
        agent: "canon:canon-security",
        role: "security",
        description: "Security review consultation",
        timeout: "5m",
      },
      "perf-check": {
        fragment: "perf-check",
        agent: "canon:canon-researcher",
        role: "researcher",
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// executeConsultations
// ---------------------------------------------------------------------------

describe("executeConsultations", () => {
  it("returns pending results for valid consultations", async () => {
    const input: ConsultationInput = {
      consultationNames: ["security-check", "perf-check"],
      breakpoint: "before",
      flow: makeFlow(),
      variables: { task: "my-task" },
    };

    const output = await executeConsultations(input);

    expect(output.warnings).toHaveLength(0);
    expect(output.results["security-check"]).toEqual({ status: "pending" });
    expect(output.results["perf-check"]).toEqual({ status: "pending" });
  });

  it("warns and skips unknown consultation names", async () => {
    const input: ConsultationInput = {
      consultationNames: ["missing-consultation"],
      breakpoint: "before",
      flow: makeFlow(),
      variables: {},
    };

    const output = await executeConsultations(input);

    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain("missing-consultation");
    expect(output.warnings[0]).toContain("not found in flow.consultations");
    expect(Object.keys(output.results)).toHaveLength(0);
  });

  it("warns when spawn instruction is missing", async () => {
    const flow = makeFlow({
      consultations: {
        "orphan-consult": {
          fragment: "orphan-consult",
          agent: "canon:canon-security",
          role: "security",
        },
      },
      // spawn_instructions does NOT include "orphan-consult"
      spawn_instructions: {},
    });

    const input: ConsultationInput = {
      consultationNames: ["orphan-consult"],
      breakpoint: "before",
      flow,
      variables: {},
    };

    const output = await executeConsultations(input);

    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain("orphan-consult");
    expect(output.warnings[0]).toContain("not found in flow.spawn_instructions");
    expect(Object.keys(output.results)).toHaveLength(0);
  });

  it("handles empty consultationNames array", async () => {
    const input: ConsultationInput = {
      consultationNames: [],
      breakpoint: "before",
      flow: makeFlow(),
      variables: {},
    };

    const output = await executeConsultations(input);

    expect(output.warnings).toHaveLength(0);
    expect(output.results).toEqual({});
  });

  it("processes valid entries and warns for invalid entries in the same call", async () => {
    const input: ConsultationInput = {
      consultationNames: ["security-check", "nonexistent"],
      breakpoint: "between",
      flow: makeFlow(),
      variables: {},
    };

    const output = await executeConsultations(input);

    expect(output.results["security-check"]).toEqual({ status: "pending" });
    expect(output.results["nonexistent"]).toBeUndefined();
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain("nonexistent");
  });
});

// ---------------------------------------------------------------------------
// resolveConsultationPrompt
// ---------------------------------------------------------------------------

describe("resolveConsultationPrompt", () => {
  it("substitutes variables in spawn instruction", () => {
    const flow = makeFlow();
    const result = resolveConsultationPrompt("security-check", flow, {
      task: "my-feature",
    });

    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("Run security audit for my-feature.");
  });

  it("returns null for unknown consultation", () => {
    const flow = makeFlow();
    const result = resolveConsultationPrompt("unknown-consult", flow, {});

    expect(result).toBeNull();
  });

  it("returns null when spawn instruction is missing", () => {
    const flow = makeFlow({
      consultations: {
        "no-spawn": {
          fragment: "no-spawn",
          agent: "canon:canon-security",
          role: "security",
        },
      },
      spawn_instructions: {},
    });

    const result = resolveConsultationPrompt("no-spawn", flow, {});

    expect(result).toBeNull();
  });

  it("includes correct agent from consultation fragment", () => {
    const flow = makeFlow();
    const result = resolveConsultationPrompt("security-check", flow, {});

    expect(result).not.toBeNull();
    expect(result!.agent).toBe("canon:canon-security");
  });

  it("includes correct role from consultation fragment", () => {
    const flow = makeFlow();
    const result = resolveConsultationPrompt("perf-check", flow, {});

    expect(result).not.toBeNull();
    expect(result!.role).toBe("researcher");
  });

  it("leaves unresolved variable patterns unchanged", () => {
    const flow = makeFlow();
    // Provide no variables — ${task} should remain literal
    const result = resolveConsultationPrompt("security-check", flow, {});

    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("Run security audit for ${task}.");
  });
});
