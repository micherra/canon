import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseRunbook,
  planRun,
  RunbookError,
  writeTaskArtifactState,
  type Runbook,
  type SpawnDescriptor,
} from "../lead-mode.ts";

/**
 * Phase 2 sibling tests for the wave extensions to lead-mode.
 *
 * These tests live next to the Phase 1 lead-mode.test.ts so that the
 * Phase 1 regression suite stays frozen and the Phase 2 extensions are
 * covered in isolation. Every new code path in planRun / parseRunbook
 * is exercised here: wave parsing, wave expansion, wave-to-wave
 * upstream resolution, flat-to-wave upstream resolution, wave-to-flat
 * rejection, template shape validation, and writeTaskArtifactState
 * key conventions for wave teammates.
 */

const WAVE_RUNBOOK_YAML = `
name: phase-2-wave-smoke
description: Synthetic wave runbook for Phase 2 tests
tier: medium
steps:
  - role: canon-researcher
    task_type: research
    artifact: research_synthesis
    artifact_path: research/SYNTHESIS.md
    hitl: false
    required_artifacts: []
  - role: canon-architect
    task_type: design
    artifact: plan_index
    artifact_path: plans/INDEX.md
    hitl: after
    required_artifacts:
      - research_synthesis
  - role: canon-implementor
    task_type: implement
    artifact: implementation_summary
    artifact_path: plans/<slug>/<task_id>-SUMMARY.md
    hitl: false
    wave: true
    required_artifacts:
      - plan_index
  - role: canon-reviewer
    task_type: review
    artifact: review
    artifact_path: plans/<slug>/<task_id>-REVIEW.md
    hitl: after_if_verdict_not_clean
    wave: true
    required_artifacts:
      - implementation_summary
`;

describe("parseRunbook — wave steps", () => {
  it("parses a runbook with a mix of flat and wave steps", () => {
    const rb = parseRunbook(WAVE_RUNBOOK_YAML);
    expect(rb.steps).toHaveLength(4);
    expect(rb.steps[0]!.wave).toBeUndefined();
    expect(rb.steps[1]!.wave).toBeUndefined();
    expect(rb.steps[2]!.wave).toBe(true);
    expect(rb.steps[3]!.wave).toBe(true);
  });

  it("defaults wave to undefined (byte-compat with Phase 1 runbooks)", () => {
    const yaml = `
name: flat-only
description: All flat
tier: small
steps:
  - role: canon-researcher
    task_type: research
    artifact: research_synthesis
    artifact_path: research/SYNTHESIS.md
    hitl: false
    required_artifacts: []
`;
    const rb = parseRunbook(yaml);
    expect(rb.steps[0]!.wave).toBeUndefined();
  });

  it("rejects non-boolean wave values", () => {
    const bad = WAVE_RUNBOOK_YAML.replace("wave: true", "wave: yes");
    expect(() => parseRunbook(bad)).toThrow(/wave must be a boolean/);
  });

  it("rejects wave: true on a single-agent role", () => {
    const yaml = `
name: bad-wave
description: wave on a single-agent role
tier: small
steps:
  - role: canon-guide
    task_type: explore
    artifact: guide_response
    artifact_path: decisions/GUIDE.md
    hitl: false
    wave: true
    required_artifacts: []
`;
    expect(() => parseRunbook(yaml)).toThrow(/not wave-compatible/);
  });
});

describe("planRun — wave expansion", () => {
  let runbook: Runbook;
  beforeEach(() => {
    runbook = parseRunbook(WAVE_RUNBOOK_YAML);
  });

  it("emits flat descriptors for non-wave steps and N descriptors per wave step", () => {
    const descriptors = planRun({
      runbook,
      workspace_id: "ws-smoke",
      target_files: [],
      wave_context: { slug: "fix-bug", task_ids: ["t1", "t2", "t3"] },
    });
    // 1 researcher + 1 architect + 3 implementors + 3 reviewers = 8
    expect(descriptors).toHaveLength(8);
    expect(descriptors.filter((d) => d.role === "canon-researcher")).toHaveLength(1);
    expect(descriptors.filter((d) => d.role === "canon-architect")).toHaveLength(1);
    expect(descriptors.filter((d) => d.role === "canon-implementor")).toHaveLength(3);
    expect(descriptors.filter((d) => d.role === "canon-reviewer")).toHaveLength(3);
  });

  it("resolves each wave implementor to its own per-task path", () => {
    const descriptors = planRun({
      runbook,
      workspace_id: "ws",
      target_files: [],
      wave_context: { slug: "fix-bug", task_ids: ["alpha", "beta"] },
    });
    const implementors = descriptors.filter(
      (d) => d.role === "canon-implementor",
    );
    const paths = implementors.map((d) => d.artifact_path).sort();
    expect(paths).toEqual([
      "plans/fix-bug/alpha-SUMMARY.md",
      "plans/fix-bug/beta-SUMMARY.md",
    ]);
  });

  it("uses the expanded task id convention for wave descriptors", () => {
    const descriptors = planRun({
      runbook,
      workspace_id: "ws",
      target_files: [],
      wave_context: { slug: "fix-bug", task_ids: ["t1", "t2"] },
    });
    const implementors = descriptors.filter(
      (d) => d.role === "canon-implementor",
    );
    expect(implementors.map((d) => d.task_id).sort()).toEqual([
      "phase-2-wave-smoke-fix-bug-t1-canon-implementor",
      "phase-2-wave-smoke-fix-bug-t2-canon-implementor",
    ]);
  });

  it("keeps the Phase 1 flat task id shape for non-wave steps", () => {
    const descriptors = planRun({
      runbook,
      workspace_id: "ws",
      target_files: [],
      wave_context: { slug: "fix-bug", task_ids: ["t1"] },
    });
    const researcher = descriptors.find((d) => d.role === "canon-researcher");
    expect(researcher?.task_id).toBe("phase-2-wave-smoke-00-canon-researcher");
    const architect = descriptors.find((d) => d.role === "canon-architect");
    expect(architect?.task_id).toBe("phase-2-wave-smoke-01-canon-architect");
  });

  it("attaches wave_context to wave descriptors only", () => {
    const descriptors = planRun({
      runbook,
      workspace_id: "ws",
      target_files: [],
      wave_context: { slug: "fix-bug", task_ids: ["t1", "t2"] },
    });
    const waveDs = descriptors.filter((d) => d.wave_context !== undefined);
    const flatDs = descriptors.filter((d) => d.wave_context === undefined);
    expect(waveDs).toHaveLength(4);
    expect(flatDs).toHaveLength(2);
    for (const d of waveDs) {
      expect(d.wave_context?.slug).toBe("fix-bug");
      expect(["t1", "t2"]).toContain(d.wave_context?.task_id);
    }
  });

  it("renders per-task wave-scoped paths in the spawn prompts", () => {
    const descriptors = planRun({
      runbook,
      workspace_id: "ws",
      target_files: [],
      wave_context: { slug: "fix-bug", task_ids: ["t1", "t2"] },
    });
    const imp1 = descriptors.find(
      (d) =>
        d.role === "canon-implementor" && d.wave_context?.task_id === "t1",
    ) as SpawnDescriptor;
    const imp2 = descriptors.find(
      (d) =>
        d.role === "canon-implementor" && d.wave_context?.task_id === "t2",
    ) as SpawnDescriptor;
    expect(imp1.spawn_prompt).toContain("plans/fix-bug/t1-SUMMARY.md");
    expect(imp2.spawn_prompt).toContain("plans/fix-bug/t2-SUMMARY.md");
    expect(imp1.spawn_prompt).not.toContain("plans/fix-bug/t2-SUMMARY.md");
  });
});

describe("planRun — upstream ref resolution for waves", () => {
  const waveRunbook = parseRunbook(WAVE_RUNBOOK_YAML);

  it("resolves flat upstreams (plan_index) to the same path for every wave task", () => {
    const descriptors = planRun({
      runbook: waveRunbook,
      workspace_id: "ws",
      target_files: [],
      wave_context: { slug: "fix-bug", task_ids: ["t1", "t2"] },
    });
    const implementors = descriptors.filter(
      (d) => d.role === "canon-implementor",
    );
    for (const imp of implementors) {
      expect(imp.spawn_prompt).toContain("plans/INDEX.md");
      expect(imp.spawn_prompt).toContain("produced by `canon-architect`");
    }
  });

  it("resolves wave upstreams (implementation_summary → reviewer) one-to-one by task id", () => {
    const descriptors = planRun({
      runbook: waveRunbook,
      workspace_id: "ws",
      target_files: [],
      wave_context: { slug: "fix-bug", task_ids: ["t1", "t2"] },
    });
    const r1 = descriptors.find(
      (d) => d.role === "canon-reviewer" && d.wave_context?.task_id === "t1",
    ) as SpawnDescriptor;
    const r2 = descriptors.find(
      (d) => d.role === "canon-reviewer" && d.wave_context?.task_id === "t2",
    ) as SpawnDescriptor;

    // Each reviewer sees ONLY its matching implementor's summary.
    expect(r1.spawn_prompt).toContain("plans/fix-bug/t1-SUMMARY.md");
    expect(r1.spawn_prompt).not.toContain("plans/fix-bug/t2-SUMMARY.md");
    expect(r2.spawn_prompt).toContain("plans/fix-bug/t2-SUMMARY.md");
    expect(r2.spawn_prompt).not.toContain("plans/fix-bug/t1-SUMMARY.md");
  });

  it("rejects flat steps that try to reference wave outputs", () => {
    // Append a flat step that tries to consume the wave implementor output.
    const yaml = `
name: bad-flat-after-wave
description: flat step after a wave
tier: medium
steps:
  - role: canon-architect
    task_type: design
    artifact: plan_index
    artifact_path: plans/INDEX.md
    hitl: false
    required_artifacts: []
  - role: canon-implementor
    task_type: implement
    artifact: implementation_summary
    artifact_path: plans/<slug>/<task_id>-SUMMARY.md
    hitl: false
    wave: true
    required_artifacts:
      - plan_index
  - role: canon-shipper
    task_type: ship
    artifact: ship_notes
    artifact_path: plans/SHIP.md
    hitl: false
    required_artifacts:
      - implementation_summary
`;
    const rb = parseRunbook(yaml);
    expect(() =>
      planRun({
        runbook: rb,
        workspace_id: "ws",
        target_files: [],
        wave_context: { slug: "s", task_ids: ["t1", "t2"] },
      }),
    ).toThrow(/flat steps cannot reference wave outputs/);
  });
});

describe("planRun — wave_context validation", () => {
  let waveRunbook: Runbook;
  beforeEach(() => {
    waveRunbook = parseRunbook(WAVE_RUNBOOK_YAML);
  });

  it("rejects wave runbooks with no wave_context at plan time", () => {
    expect(() =>
      planRun({
        runbook: waveRunbook,
        workspace_id: "ws",
        target_files: [],
      }),
    ).toThrow(/no wave_context\.task_ids were provided/);
  });

  it("rejects wave_context with empty task_ids", () => {
    expect(() =>
      planRun({
        runbook: waveRunbook,
        workspace_id: "ws",
        target_files: [],
        wave_context: { slug: "s", task_ids: [] },
      }),
    ).toThrow(/no wave_context\.task_ids/);
  });

  it("rejects invalid slug characters", () => {
    expect(() =>
      planRun({
        runbook: waveRunbook,
        workspace_id: "ws",
        target_files: [],
        wave_context: { slug: "bad slug", task_ids: ["t1"] },
      }),
    ).toThrow(/wave_context\.slug/);
  });

  it("rejects invalid task_id characters", () => {
    expect(() =>
      planRun({
        runbook: waveRunbook,
        workspace_id: "ws",
        target_files: [],
        wave_context: { slug: "s", task_ids: ["bad id"] },
      }),
    ).toThrow(/invalid id/);
  });

  it("rejects wave artifact_path that is not a valid template", () => {
    const yaml = WAVE_RUNBOOK_YAML.replace(
      "artifact_path: plans/<slug>/<task_id>-SUMMARY.md",
      "artifact_path: plans/SUMMARY.md",
    );
    const rb = parseRunbook(yaml);
    expect(() =>
      planRun({
        runbook: rb,
        workspace_id: "ws",
        target_files: [],
        wave_context: { slug: "s", task_ids: ["t1"] },
      }),
    ).toThrow(/must be of the template form/);
  });

  it("rejects wave artifact_path whose shape disagrees with the canonical role suffix", () => {
    // Implementor's canonical wave suffix is -SUMMARY.md, not -WRONG.md
    const yaml = WAVE_RUNBOOK_YAML.replace(
      "artifact_path: plans/<slug>/<task_id>-SUMMARY.md",
      "artifact_path: plans/<slug>/<task_id>-WRONG.md",
    );
    const rb = parseRunbook(yaml);
    expect(() =>
      planRun({
        runbook: rb,
        workspace_id: "ws",
        target_files: [],
        wave_context: { slug: "s", task_ids: ["t1"] },
      }),
    ).toThrow(/does not match the canonical wave shape/);
  });

  it("ignores wave_context on flat-only runbooks (no-op)", () => {
    const flat = parseRunbook(`
name: flat-only
description: All flat
tier: small
steps:
  - role: canon-researcher
    task_type: research
    artifact: research_synthesis
    artifact_path: research/SYNTHESIS.md
    hitl: false
    required_artifacts: []
`);
    // Supplying wave_context for a flat runbook is tolerated, not an error.
    const descriptors = planRun({
      runbook: flat,
      workspace_id: "ws",
      target_files: [],
      wave_context: { slug: "s", task_ids: ["t1"] },
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]!.task_id).toBe("flat-only-00-canon-researcher");
    expect(descriptors[0]!.wave_context).toBeUndefined();
  });
});

describe("writeTaskArtifactState — wave keying", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "canon-lead-wave-state-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("keys task-artifacts.json and teammate-artifacts.json by expanded ids for wave descriptors", async () => {
    const rb = parseRunbook(WAVE_RUNBOOK_YAML);
    const descriptors = planRun({
      runbook: rb,
      workspace_id: "ws",
      target_files: [],
      wave_context: { slug: "fix-bug", task_ids: ["t1", "t2"] },
    });
    const paths = writeTaskArtifactState(tmp, descriptors);

    const taskState = JSON.parse(await readFile(paths.task_state_path, "utf8"));
    const teammateState = JSON.parse(
      await readFile(paths.teammate_state_path, "utf8"),
    );

    // Flat entries for the researcher + architect use the Phase 1 shape.
    expect(taskState["phase-2-wave-smoke-00-canon-researcher"]).toEqual({
      role: "canon-researcher",
      artifact: "research_synthesis",
      artifact_path: "research/SYNTHESIS.md",
    });
    expect(teammateState["canon-researcher"]).toBeDefined();
    expect(teammateState["canon-architect"]).toBeDefined();

    // Wave entries use the expanded shape in BOTH files.
    expect(
      taskState["phase-2-wave-smoke-fix-bug-t1-canon-implementor"],
    ).toEqual({
      role: "canon-implementor",
      artifact: "implementation_summary",
      artifact_path: "plans/fix-bug/t1-SUMMARY.md",
    });
    expect(
      teammateState["phase-2-wave-smoke-fix-bug-t1-canon-implementor"],
    ).toBeDefined();
    expect(
      teammateState["phase-2-wave-smoke-fix-bug-t2-canon-implementor"],
    ).toBeDefined();
    expect(
      teammateState["phase-2-wave-smoke-fix-bug-t1-canon-reviewer"],
    ).toBeDefined();

    // Wave teammates do NOT overwrite the flat role key, since multiple
    // descriptors share the role and last-writer-wins would be misleading.
    expect(teammateState["canon-implementor"]).toBeUndefined();
    expect(teammateState["canon-reviewer"]).toBeUndefined();
  });
});

describe("Wave parsing edge cases", () => {
  it("accepts wave: false explicitly as a Phase 1 byte-compat flat step", () => {
    const yaml = `
name: explicit-flat
description: explicit wave:false
tier: small
steps:
  - role: canon-researcher
    task_type: research
    artifact: research_synthesis
    artifact_path: research/SYNTHESIS.md
    hitl: false
    wave: false
    required_artifacts: []
`;
    const rb = parseRunbook(yaml);
    expect(rb.steps[0]!.wave).toBe(false);
    const descriptors = planRun({
      runbook: rb,
      workspace_id: "ws",
      target_files: [],
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]!.wave_context).toBeUndefined();
  });

  it("accepts -TEST-REPORT.md (multi-hyphen suffix) for canon-tester wave steps", () => {
    const yaml = `
name: test-wave
description: wave tester
tier: small
steps:
  - role: canon-architect
    task_type: design
    artifact: plan_index
    artifact_path: plans/INDEX.md
    hitl: false
    required_artifacts: []
  - role: canon-tester
    task_type: test
    artifact: test_report
    artifact_path: plans/<slug>/<task_id>-TEST-REPORT.md
    hitl: false
    wave: true
    required_artifacts:
      - plan_index
`;
    const rb = parseRunbook(yaml);
    const descriptors = planRun({
      runbook: rb,
      workspace_id: "ws",
      target_files: [],
      wave_context: { slug: "s", task_ids: ["t1"] },
    });
    const tester = descriptors.find((d) => d.role === "canon-tester");
    expect(tester?.artifact_path).toBe("plans/s/t1-TEST-REPORT.md");
  });
});
