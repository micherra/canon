import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertLeadModeEnabled,
  deriveTaskListId,
  isLeadModeEnabled,
  LEAD_MODE_ENV_VAR,
  loadAndPlan,
  loadRunbook,
  parseRunbook,
  planRun,
  RunbookError,
  writeTaskArtifactState,
  type Runbook,
  type SpawnDescriptor,
} from "../lead-mode.ts";

const VALID_RUNBOOK_YAML = `
name: fast-path
description: Bug fix or small change, 1–3 files
tier: small
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
    artifact_path: plans/SUMMARY.md
    hitl: false
    required_artifacts:
      - research_synthesis
      - plan_index
  - role: canon-reviewer
    task_type: review
    artifact: review
    artifact_path: reviews/REVIEW.md
    hitl: after_if_verdict_not_clean
    required_artifacts:
      - implementation_summary
`;

describe("isLeadModeEnabled / assertLeadModeEnabled", () => {
  it("returns false when the flag is unset", () => {
    expect(isLeadModeEnabled({})).toBe(false);
  });

  it("returns false when the flag is off", () => {
    expect(isLeadModeEnabled({ [LEAD_MODE_ENV_VAR]: "off" })).toBe(false);
  });

  it("returns true only for explicit 'on'", () => {
    expect(isLeadModeEnabled({ [LEAD_MODE_ENV_VAR]: "on" })).toBe(true);
    expect(isLeadModeEnabled({ [LEAD_MODE_ENV_VAR]: "ON" })).toBe(false);
    expect(isLeadModeEnabled({ [LEAD_MODE_ENV_VAR]: "1" })).toBe(false);
    expect(isLeadModeEnabled({ [LEAD_MODE_ENV_VAR]: "true" })).toBe(false);
  });

  it("assertLeadModeEnabled throws when the flag is off", () => {
    expect(() => assertLeadModeEnabled({})).toThrow(/must be set to "on"/);
  });

  it("assertLeadModeEnabled is silent when the flag is on", () => {
    expect(() =>
      assertLeadModeEnabled({ [LEAD_MODE_ENV_VAR]: "on" }),
    ).not.toThrow();
  });
});

describe("parseRunbook", () => {
  it("parses the Phase 1 fast-path runbook", () => {
    const rb = parseRunbook(VALID_RUNBOOK_YAML);
    expect(rb.name).toBe("fast-path");
    expect(rb.tier).toBe("small");
    expect(rb.steps).toHaveLength(4);
    expect(rb.steps[0]!.role).toBe("canon-researcher");
    expect(rb.steps[1]!.hitl).toBe("after");
    expect(rb.steps[3]!.hitl).toBe("after_if_verdict_not_clean");
    expect(rb.steps[2]!.required_artifacts).toEqual([
      "research_synthesis",
      "plan_index",
    ]);
  });

  it("throws on non-object top level", () => {
    expect(() => parseRunbook("42")).toThrow(RunbookError);
    expect(() => parseRunbook("- one\n- two")).toThrow(RunbookError);
  });

  it("throws on missing name", () => {
    expect(() =>
      parseRunbook(
        `description: x\ntier: small\nsteps:\n  - role: canon-researcher\n    task_type: research\n    artifact: research_synthesis\n    artifact_path: research/SYNTHESIS.md\n    hitl: false\n`,
      ),
    ).toThrow(/missing a string "name"/);
  });

  it("throws on invalid tier", () => {
    const bad = VALID_RUNBOOK_YAML.replace("tier: small", "tier: huge");
    expect(() => parseRunbook(bad)).toThrow(/invalid tier/);
  });

  it("throws on empty steps list", () => {
    expect(() =>
      parseRunbook(`name: t\ndescription: t\ntier: small\nsteps: []`),
    ).toThrow(/must declare at least one step/);
  });

  it("throws on unknown role", () => {
    const bad = VALID_RUNBOOK_YAML.replace(
      "role: canon-researcher",
      "role: canon-unknown",
    );
    expect(() => parseRunbook(bad)).toThrow(/unknown role/);
  });

  it("throws on invalid hitl value", () => {
    const bad = VALID_RUNBOOK_YAML.replace("hitl: false", "hitl: sometimes");
    expect(() => parseRunbook(bad)).toThrow(/invalid hitl/);
  });
});

describe("loadRunbook", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "canon-lead-mode-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads a runbook from <pluginDir>/skills/canon/runbooks/<name>.yaml", async () => {
    const runbookDir = join(tmp, "skills", "canon", "runbooks");
    await mkdir(runbookDir, { recursive: true });
    await writeFile(join(runbookDir, "fast-path.yaml"), VALID_RUNBOOK_YAML);

    const rb = await loadRunbook(tmp, "fast-path");
    expect(rb.name).toBe("fast-path");
    expect(rb.steps).toHaveLength(4);
  });

  it("throws RunbookError when the file does not exist", async () => {
    await expect(loadRunbook(tmp, "nope")).rejects.toThrow(RunbookError);
  });

  it("reads the real Phase 1 fast-path runbook from the repo", async () => {
    // The real file sits at <repo>/skills/canon/runbooks/fast-path.yaml.
    // The tests run from mcp-server/, so the plugin dir is one level up.
    const pluginDir = join(__dirname, "..", "..", "..", "..", "..");
    const rb = await loadRunbook(pluginDir, "fast-path");
    expect(rb.name).toBe("fast-path");
    expect(rb.steps.length).toBeGreaterThan(0);
  });
});

describe("planRun", () => {
  const runbook: Runbook = parseRunbook(VALID_RUNBOOK_YAML);

  it("produces one descriptor per step in order", () => {
    const descriptors = planRun({
      runbook,
      workspace_id: "ws-1",
      target_files: ["src/foo.ts"],
    });
    expect(descriptors.map((d) => d.role)).toEqual([
      "canon-researcher",
      "canon-architect",
      "canon-implementor",
      "canon-reviewer",
    ]);
  });

  it("assembles a prompt that embeds the workspace id and target files", () => {
    const [first] = planRun({
      runbook,
      workspace_id: "ws-xyz",
      target_files: ["a.ts", "b.ts"],
    });
    expect(first!.spawn_prompt).toContain("Workspace: `ws-xyz`");
    expect(first!.spawn_prompt).toContain("`a.ts`");
    expect(first!.spawn_prompt).toContain("`b.ts`");
  });

  it("resolves upstream artifact refs for downstream steps", () => {
    const descriptors = planRun({
      runbook,
      workspace_id: "ws-1",
      target_files: [],
    });
    const reviewerStep = descriptors.find(
      (d) => d.role === "canon-reviewer",
    ) as SpawnDescriptor;
    expect(reviewerStep.spawn_prompt).toContain("plans/SUMMARY.md");
    expect(reviewerStep.spawn_prompt).toContain("produced by `canon-implementor`");
  });

  it("assigns stable task ids", () => {
    const descriptors = planRun({
      runbook,
      workspace_id: "ws-1",
      target_files: [],
    });
    expect(descriptors[0]!.task_id).toBe("fast-path-00-canon-researcher");
    expect(descriptors[3]!.task_id).toBe("fast-path-03-canon-reviewer");
  });

  it("throws when a required artifact is not produced upstream", () => {
    const broken = parseRunbook(
      VALID_RUNBOOK_YAML.replace("research_synthesis\n      - plan_index", "totally_unknown\n      - plan_index"),
    );
    expect(() =>
      planRun({ runbook: broken, workspace_id: "ws", target_files: [] }),
    ).toThrow(/required artifact "totally_unknown"/);
  });

  it("throws when a step declares an artifact_path that disagrees with the canonical role contract", () => {
    const cloned: Runbook = JSON.parse(JSON.stringify(runbook));
    cloned.steps[0]!.artifact_path = "wrong/PATH.md";
    expect(() =>
      planRun({ runbook: cloned, workspace_id: "ws", target_files: [] }),
    ).toThrow(/does not match canonical contract/);
  });
});

describe("writeTaskArtifactState", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "canon-lead-mode-state-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes task and teammate state files under agent-teams/", async () => {
    const runbook = parseRunbook(VALID_RUNBOOK_YAML);
    const descriptors = planRun({
      runbook,
      workspace_id: "ws-xyz",
      target_files: [],
    });

    const paths = writeTaskArtifactState(tmp, descriptors);

    expect(paths.task_state_path).toContain("/agent-teams/task-artifacts.json");
    expect(paths.teammate_state_path).toContain(
      "/agent-teams/teammate-artifacts.json",
    );

    const taskState = JSON.parse(await readFile(paths.task_state_path, "utf8"));
    const teammateState = JSON.parse(
      await readFile(paths.teammate_state_path, "utf8"),
    );

    expect(taskState["fast-path-00-canon-researcher"]).toEqual({
      role: "canon-researcher",
      artifact: "research_synthesis",
      artifact_path: "research/SYNTHESIS.md",
    });
    expect(teammateState["canon-reviewer"]).toEqual({
      role: "canon-reviewer",
      artifact: "review",
      artifact_path: "reviews/REVIEW.md",
    });
  });
});

describe("deriveTaskListId", () => {
  it("prefixes the workspace id", () => {
    expect(deriveTaskListId("ws-xyz")).toBe("canon-ws-xyz");
  });

  it("is deterministic", () => {
    expect(deriveTaskListId("foo")).toBe(deriveTaskListId("foo"));
  });
});

describe("loadAndPlan", () => {
  let tmp: string;
  let prevFlag: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "canon-lead-mode-load-"));
    const runbookDir = join(tmp, "skills", "canon", "runbooks");
    await mkdir(runbookDir, { recursive: true });
    await writeFile(join(runbookDir, "fast-path.yaml"), VALID_RUNBOOK_YAML);
    prevFlag = process.env[LEAD_MODE_ENV_VAR];
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    if (prevFlag === undefined) delete process.env[LEAD_MODE_ENV_VAR];
    else process.env[LEAD_MODE_ENV_VAR] = prevFlag;
  });

  it("throws when the flag is off", async () => {
    delete process.env[LEAD_MODE_ENV_VAR];
    await expect(
      loadAndPlan(tmp, "fast-path", {
        workspace_id: "ws",
        target_files: [],
      }),
    ).rejects.toThrow(/must be set to "on"/);
  });

  it("returns runbook + descriptors when the flag is on", async () => {
    process.env[LEAD_MODE_ENV_VAR] = "on";
    const result = await loadAndPlan(tmp, "fast-path", {
      workspace_id: "ws",
      target_files: ["src/x.ts"],
    });
    expect(result.runbook.name).toBe("fast-path");
    expect(result.descriptors).toHaveLength(4);
    expect(result.descriptors[0]!.spawn_prompt).toContain("src/x.ts");
  });
});
