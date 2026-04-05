/**
 * Tests for artifact validation (ADR-010).
 *
 * Unit tests for validateRequiredArtifacts function and integration tests
 * for reportResult behavior when required_artifacts is declared on a state.
 *
 * Canon principles applied:
 * - errors-are-values: validates returns toolError/null, never throws
 * - no-silent-failures: missing/malformed artifacts produce explicit INVALID_INPUT errors
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import type { RequiredArtifact, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { assertOk } from "../shared/lib/tool-result.ts";
import { reportResult, validateRequiredArtifacts } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifact-validation-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

async function writeMetaJson(
  dir: string,
  name: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.meta.json`), JSON.stringify(meta), "utf-8");
}

function makeFlow(requiredArtifacts?: RequiredArtifact[]): ResolvedFlow {
  const stateDef = requiredArtifacts
    ? {
        required_artifacts: requiredArtifacts,
        transitions: { done: "terminal" },
        type: "single" as const,
      }
    : {
        transitions: { done: "terminal" },
        type: "single" as const,
      };
  return {
    description: "Artifact validation test flow",
    entry: "implement",
    name: "test-flow",
    spawn_instructions: { implement: "Implement." },
    states: {
      implement: stateDef,
      terminal: { type: "terminal" as const },
    },
  };
}

function setupWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc1234",
    branch: "main",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "main",
    slug: "test-slug",
    started: now,
    task: "task",
    tier: "medium",
  });
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
    if ("max_iterations" in stateDef && stateDef.max_iterations !== undefined) {
      store.upsertIteration(stateId, {
        cannot_fix: [],
        count: 0,
        history: [],
        max: stateDef.max_iterations,
      });
    }
  }
}

// Unit tests: validateRequiredArtifacts

describe("validateRequiredArtifacts", () => {
  it("returns null when required array is empty", async () => {
    const workspace = makeTmpWorkspace();
    const result = await validateRequiredArtifacts(workspace, [], []);
    expect(result).toBeNull();
  });

  it("returns null when required artifact .meta.json exists with correct _type", async () => {
    const workspace = makeTmpWorkspace();
    await writeMetaJson(join(workspace, "reviews"), "REVIEW", {
      _type: "review",
      _version: 1,
      verdict: "clean",
    });

    // Artifact not in reported list — validates by searching reviews/
    const result = await validateRequiredArtifacts(
      workspace,
      ["some-other-artifact.md"],
      [{ name: "REVIEW", type: "review" }],
    );
    expect(result).toBeNull();
  });

  it("returns null when .meta.json in artifacts list has correct _type", async () => {
    const workspace = makeTmpWorkspace();
    const metaPath = join(workspace, "REVIEW.meta.json");
    await writeFile(metaPath, JSON.stringify({ _type: "review", _version: 1 }), "utf-8");

    const result = await validateRequiredArtifacts(
      workspace,
      [metaPath], // reported as absolute path
      [{ name: "REVIEW", type: "review" }],
    );
    expect(result).toBeNull();
  });

  it("returns INVALID_INPUT when .meta.json is missing from all locations", async () => {
    const workspace = makeTmpWorkspace();

    const result = await validateRequiredArtifacts(
      workspace,
      ["plans/task/IMPLEMENTATION-SUMMARY.md"],
      [{ name: "IMPLEMENTATION-SUMMARY", type: "implementation_summary" }],
    );

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.error_code).toBe("INVALID_INPUT");
    expect(result?.message).toContain("IMPLEMENTATION-SUMMARY");
    // Primary artifact .md is matched, but its sidecar .meta.json is missing — reports "not readable"
    expect(result?.message).toContain("not readable");
  });

  it("returns INVALID_INPUT when .meta.json has wrong _type", async () => {
    const workspace = makeTmpWorkspace();
    await writeMetaJson(join(workspace, "reviews"), "REVIEW", {
      _type: "test_report", // wrong type
      _version: 1,
    });

    const result = await validateRequiredArtifacts(
      workspace,
      [],
      [{ name: "REVIEW", type: "review" }],
    );

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.error_code).toBe("INVALID_INPUT");
    expect(result?.message).toContain("test_report");
    expect(result?.message).toContain("review");
  });

  it("returns INVALID_INPUT when .meta.json is malformed JSON", async () => {
    const workspace = makeTmpWorkspace();
    await mkdir(join(workspace, "reviews"), { recursive: true });
    await writeFile(join(workspace, "reviews", "REVIEW.meta.json"), "not valid json {{{", "utf-8");

    const result = await validateRequiredArtifacts(
      workspace,
      [],
      [{ name: "REVIEW", type: "review" }],
    );

    // Malformed JSON in reviews/ means it can't be parsed — falls through as "not found"
    // unless we find a valid one elsewhere; since there's no valid one, returns not found
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.error_code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when .meta.json path in artifacts list is not readable", async () => {
    const workspace = makeTmpWorkspace();
    // Report the .meta.json path directly, but don't create the file on disk
    const missingMetaPath = join(workspace, "reviews", "REVIEW.meta.json");
    const result = await validateRequiredArtifacts(
      workspace,
      [missingMetaPath], // .meta.json reported but doesn't exist on disk
      [{ name: "REVIEW", type: "review" }],
    );

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.error_code).toBe("INVALID_INPUT");
    expect(result?.message).toContain("not readable");
  });

  it("searches plans/ subdirectories for .meta.json", async () => {
    const workspace = makeTmpWorkspace();
    const taskSlug = "my-task-slug";
    await writeMetaJson(join(workspace, "plans", taskSlug), "IMPLEMENTATION-SUMMARY", {
      _type: "implementation_summary",
      _version: 1,
    });

    const result = await validateRequiredArtifacts(
      workspace,
      [],
      [{ name: "IMPLEMENTATION-SUMMARY", type: "implementation_summary" }],
    );
    expect(result).toBeNull();
  });

  it("returns INVALID_INPUT for wrong _type in plans/ subdirectory", async () => {
    const workspace = makeTmpWorkspace();
    const taskSlug = "my-task-slug";
    await writeMetaJson(join(workspace, "plans", taskSlug), "IMPLEMENTATION-SUMMARY", {
      _type: "review", // wrong type
      _version: 1,
    });

    const result = await validateRequiredArtifacts(
      workspace,
      [],
      [{ name: "IMPLEMENTATION-SUMMARY", type: "implementation_summary" }],
    );

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.error_code).toBe("INVALID_INPUT");
    expect(result?.message).toContain("review");
    expect(result?.message).toContain("implementation_summary");
  });

  it("validates multiple required artifacts — fails on first missing", async () => {
    const workspace = makeTmpWorkspace();
    // Only provide the first artifact
    await writeMetaJson(join(workspace, "reviews"), "REVIEW", {
      _type: "review",
      _version: 1,
    });
    // IMPLEMENTATION-SUMMARY is missing

    const result = await validateRequiredArtifacts(
      workspace,
      [],
      [
        { name: "REVIEW", type: "review" },
        { name: "IMPLEMENTATION-SUMMARY", type: "implementation_summary" },
      ],
    );

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.error_code).toBe("INVALID_INPUT");
    expect(result?.message).toContain("IMPLEMENTATION-SUMMARY");
  });
});

// Integration tests: reportResult with required_artifacts on state definition

describe("reportResult with required_artifacts", () => {
  it("returns INVALID_INPUT when required artifact is missing — board NOT mutated", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow([{ name: "REVIEW", type: "review" }]);
    setupWorkspace(workspace, flow);

    const store = getExecutionStore(workspace);
    const boardBefore = store.getBoard();

    const result = await reportResult({
      artifacts: ["plans/task/some-plan.md"], // no REVIEW.meta.json
      flow,
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("REVIEW");
    }

    // Board state must NOT be mutated
    const boardAfter = store.getBoard();
    expect(boardAfter?.states.implement?.status).toBe(boardBefore?.states.implement?.status);
    expect(boardAfter?.states.implement?.result).toBeUndefined();
  });

  it("succeeds when required artifact .meta.json exists with correct type", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow([{ name: "REVIEW", type: "review" }]);
    setupWorkspace(workspace, flow);

    // Write the required .meta.json sidecar in reviews/
    await writeMetaJson(join(workspace, "reviews"), "REVIEW", {
      _type: "review",
      _version: 1,
      verdict: "clean",
    });

    const result = await reportResult({
      artifacts: ["reviews/REVIEW.md"],
      flow,
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
    });

    assertOk(result);
    expect(result.transition_condition).toBe("done");
  });

  it("skips validation when required_artifacts is absent — backward compat", async () => {
    const workspace = makeTmpWorkspace();
    // Flow with NO required_artifacts on the state
    const flow = makeFlow(); // no required_artifacts
    setupWorkspace(workspace, flow);

    // No .meta.json files present at all — validation should be skipped
    const result = await reportResult({
      artifacts: ["some-output.md"],
      flow,
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
    });

    assertOk(result);
    expect(result.transition_condition).toBe("done");
  });

  it("validates even when artifacts is absent — required_artifacts triggers validation with empty list", async () => {
    const workspace = makeTmpWorkspace();
    // required_artifacts declared but caller passes no artifacts
    const flow = makeFlow([{ name: "REVIEW", type: "review" }]);
    setupWorkspace(workspace, flow);

    // No artifacts array — validation still runs (empty list passed to validateRequiredArtifacts)
    const result = await reportResult({
      flow,
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
      // artifacts: undefined — absent, but validation still runs
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("REVIEW");
    }
  });

  it("returns INVALID_INPUT when .meta.json has wrong _type — board NOT mutated", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeFlow([{ name: "REVIEW", type: "review" }]);
    setupWorkspace(workspace, flow);

    // Write .meta.json with WRONG type
    await writeMetaJson(join(workspace, "reviews"), "REVIEW", {
      _type: "test_report", // wrong
      _version: 1,
    });

    const result = await reportResult({
      artifacts: ["reviews/REVIEW.md"],
      flow,
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("test_report");
      expect(result.message).toContain("review");
    }

    // Board NOT mutated
    const store = getExecutionStore(workspace);
    const board = store.getBoard();
    expect(board?.states.implement?.status).toBe("pending");
    expect(board?.states.implement?.result).toBeUndefined();
  });
});
