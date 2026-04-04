import { describe, expect, it } from "vitest";
import {
  type ConsultationInput,
  executeConsultations,
  resolveConsultationPrompt,
} from "../orchestration/consultation-executor.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    consultations: {
      "perf-check": {
        agent: "canon:canon-researcher",
        fragment: "perf-check",
        role: "researcher",
      },
      "security-check": {
        agent: "canon:canon-security",
        description: "Security review consultation",
        fragment: "security-check",
        role: "security",
        timeout: "5m",
      },
    },
    description: "Test flow",
    entry: "start",
    name: "test-flow",
    spawn_instructions: {
      "perf-check": "Run performance check.",
      "security-check": "Run security audit for ${task}.",
    },
    states: {
      start: { type: "terminal" },
    },
    ...overrides,
  };
}

// executeConsultations

describe("executeConsultations", () => {
  it("returns pending results for valid consultations", async () => {
    const input: ConsultationInput = {
      breakpoint: "before",
      consultationNames: ["security-check", "perf-check"],
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
      breakpoint: "before",
      consultationNames: ["missing-consultation"],
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
          agent: "canon:canon-security",
          fragment: "orphan-consult",
          role: "security",
        },
      },
      // spawn_instructions does NOT include "orphan-consult"
      spawn_instructions: {},
    });

    const input: ConsultationInput = {
      breakpoint: "before",
      consultationNames: ["orphan-consult"],
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
      breakpoint: "before",
      consultationNames: [],
      flow: makeFlow(),
      variables: {},
    };

    const output = await executeConsultations(input);

    expect(output.warnings).toHaveLength(0);
    expect(output.results).toEqual({});
  });

  it("processes valid entries and warns for invalid entries in the same call", async () => {
    const input: ConsultationInput = {
      breakpoint: "between",
      consultationNames: ["security-check", "nonexistent"],
      flow: makeFlow(),
      variables: {},
    };

    const output = await executeConsultations(input);

    expect(output.results["security-check"]).toEqual({ status: "pending" });
    expect(output.results.nonexistent).toBeUndefined();
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain("nonexistent");
  });
});

// resolveConsultationPrompt

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
          agent: "canon:canon-security",
          fragment: "no-spawn",
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

  it("returns timeout when fragment declares it", () => {
    const flow = makeFlow();
    // "security-check" fixture has timeout: "5m"
    const result = resolveConsultationPrompt("security-check", flow, {});

    expect(result).not.toBeNull();
    expect(result!.timeout).toBe("5m");
  });

  it("returns section when fragment declares it", () => {
    const flow = makeFlow({
      consultations: {
        "section-check": {
          agent: "canon:canon-security",
          fragment: "section-check",
          role: "security",
          section: "## Security Review",
        },
      },
      spawn_instructions: {
        "section-check": "Run section check.",
      },
    });
    const result = resolveConsultationPrompt("section-check", flow, {});

    expect(result).not.toBeNull();
    expect(result!.section).toBe("## Security Review");
  });

  it("omits timeout and section when fragment does not declare them", () => {
    const flow = makeFlow();
    // "perf-check" fixture has no timeout or section
    const result = resolveConsultationPrompt("perf-check", flow, {});

    expect(result).not.toBeNull();
    expect("timeout" in result!).toBe(false);
    expect("section" in result!).toBe(false);
  });
});
