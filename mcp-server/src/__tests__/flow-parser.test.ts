import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseFlowYaml, validateFlow, loadFlows, loadFlow } from "../flow/parser.js";

describe("parseFlowYaml", () => {
  it("parses a simple flow with two steps", () => {
    const yaml = `
name: quick-fix
description: Fast fix with review
steps:
  - id: implement
    agent: canon-implementor
    input: task_description
  - id: review
    agent: canon-reviewer
    input: git_diff
`;
    const flow = parseFlowYaml(yaml);
    expect(flow.name).toBe("quick-fix");
    expect(flow.description).toBe("Fast fix with review");
    expect(flow.steps).toHaveLength(2);
    expect(flow.steps[0].id).toBe("implement");
    expect(flow.steps[0].agent).toBe("canon-implementor");
    expect(flow.steps[1].id).toBe("review");
    expect(flow.steps[1].agent).toBe("canon-reviewer");
  });

  it("parses a flow with loop_until and max_iterations", () => {
    const yaml = `
name: ralph
description: Build-review-fix loop
steps:
  - id: build
    command: canon:build
    passthrough_flags: true
  - id: review-loop
    agent: canon-reviewer
    loop_until: verdict == "CLEAN"
    max_iterations: 3
`;
    const flow = parseFlowYaml(yaml);
    expect(flow.steps).toHaveLength(2);
    expect(flow.steps[0].command).toBe("canon:build");
    expect(flow.steps[0].passthrough_flags).toBe(true);
    expect(flow.steps[1].loop_until).toBe('verdict == "CLEAN"');
    expect(flow.steps[1].max_iterations).toBe(3);
  });

  it("parses a flow with on_violation sub-steps", () => {
    const yaml = `
name: ralph-loop
description: Review with auto-fix
steps:
  - id: review
    agent: canon-reviewer
    loop_until: verdict == "CLEAN"
    max_iterations: 3
    on_violation:
      - agent: canon-refactorer
        parallel_per: violation_group
`;
    const flow = parseFlowYaml(yaml);
    expect(flow.steps[0].on_violation).toBeDefined();
    expect(flow.steps[0].on_violation).toHaveLength(1);
    expect(flow.steps[0].on_violation![0].agent).toBe("canon-refactorer");
    expect(flow.steps[0].on_violation![0].parallel_per).toBe("violation_group");
  });

  it("parses parallel arrays", () => {
    const yaml = `
name: research-flow
description: Parallel research
steps:
  - id: research
    agent: canon-researcher
    parallel: [codebase, domain, risk]
`;
    const flow = parseFlowYaml(yaml);
    expect(flow.steps[0].parallel).toEqual(["codebase", "domain", "risk"]);
  });

  it("parses global max_iterations", () => {
    const yaml = `
name: bounded
description: Bounded flow
max_iterations: 5
steps:
  - id: step1
    agent: canon-reviewer
`;
    const flow = parseFlowYaml(yaml);
    expect(flow.max_iterations).toBe(5);
  });

  it("skips comments and blank lines", () => {
    const yaml = `
# This is a comment
name: commented

# Another comment
description: Has comments

steps:
  # Step comment
  - id: step1
    agent: canon-reviewer
`;
    const flow = parseFlowYaml(yaml);
    expect(flow.name).toBe("commented");
    expect(flow.steps).toHaveLength(1);
  });
});

describe("validateFlow", () => {
  it("validates a correct flow", () => {
    const result = validateFlow({
      name: "test",
      description: "Test flow",
      steps: [
        { id: "s1", agent: "canon-reviewer" },
        { id: "s2", agent: "canon-refactorer" },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects flow without name", () => {
    const result = validateFlow({
      name: "",
      description: "",
      steps: [{ id: "s1", agent: "canon-reviewer" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "name")).toBe(true);
  });

  it("rejects flow without steps", () => {
    const result = validateFlow({
      name: "empty",
      description: "",
      steps: [],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects duplicate step IDs", () => {
    const result = validateFlow({
      name: "dupes",
      description: "",
      steps: [
        { id: "s1", agent: "canon-reviewer" },
        { id: "s1", agent: "canon-refactorer" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Duplicate"))).toBe(
      true
    );
  });

  it("rejects step without agent or command", () => {
    const result = validateFlow({
      name: "no-agent",
      description: "",
      steps: [{ id: "s1" }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects goto to unknown step", () => {
    const result = validateFlow({
      name: "bad-goto",
      description: "",
      steps: [{ id: "s1", agent: "canon-reviewer", goto: "nonexistent" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "goto")).toBe(true);
  });

  it("detects simple cycles", () => {
    const result = validateFlow({
      name: "cycle",
      description: "",
      steps: [
        { id: "s1", agent: "canon-reviewer", goto: "s2" },
        { id: "s2", agent: "canon-refactorer", goto: "s1" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Cycle"))).toBe(true);
  });

  it("warns about loop_until without max_iterations", () => {
    const result = validateFlow({
      name: "warn",
      description: "",
      steps: [
        { id: "s1", agent: "canon-reviewer", loop_until: 'verdict == "CLEAN"' },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("loadFlows / loadFlow", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-flows-test-"));
    await mkdir(join(tmpDir, ".canon", "flows"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads flows from project directory", async () => {
    await writeFile(
      join(tmpDir, ".canon", "flows", "test.yaml"),
      `name: test\ndescription: Test\nsteps:\n  - id: s1\n    agent: canon-reviewer\n`
    );

    const flows = await loadFlows(tmpDir, "/nonexistent");
    expect(flows).toHaveLength(1);
    expect(flows[0].name).toBe("test");
  });

  it("loads a single flow by name", async () => {
    await writeFile(
      join(tmpDir, ".canon", "flows", "my-flow.yaml"),
      `name: my-flow\ndescription: My flow\nsteps:\n  - id: s1\n    agent: canon-reviewer\n`
    );

    const flow = await loadFlow("my-flow", tmpDir, "/nonexistent");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("my-flow");
  });

  it("returns null for nonexistent flow", async () => {
    const flow = await loadFlow("nonexistent", tmpDir, "/nonexistent");
    expect(flow).toBeNull();
  });

  it("returns empty for missing directories", async () => {
    const flows = await loadFlows("/nonexistent", "/also-nonexistent");
    expect(flows).toEqual([]);
  });
});
