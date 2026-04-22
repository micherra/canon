/**
 * Integration tests for Canon MCP harness features — lifecycle, skip_when, deferred-fields,
 * backward compatibility, and store round-trip.
 *
 * Split from integration-harness.test.ts. Covers:
 * - get-spawn-prompt with both skip_when AND inject_context on the same state
 * - get-spawn-prompt deferred-field warning path (harness-04 declared gap)
 * - Backward compatibility: board.json without new fields still parses
 * - store_pr_review → DriftStore round-trip with pr_number filtering
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist spawnSync mock to file level so vitest can hoist it before module imports.
// Controls git diff output for skip_when integration tests.
type SpawnSyncResult = { stdout: string; status: number; error?: Error };
let execSyncImpl: (() => SpawnSyncResult) | null = null;

vi.mock("node:child_process", () => ({
  spawnSync: (..._args: unknown[]) => {
    if (execSyncImpl) return execSyncImpl();
    // Default behavior: return error to simulate no git — fail-open means skip=false
    return { error: new Error("spawnSync not configured in test"), status: 1, stdout: "" };
  },
}));

import { BoardSchema } from "@domains/flows/board-state-schemas.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { flowEventBus } from "@domains/messages/event-bus-instance.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-lifecycle-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  flowEventBus.removeAllListeners();
  execSyncImpl = null; // reset git mock after each test
});

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
    if (stateDef.max_iterations !== undefined) {
      store.upsertIteration(stateId, {
        cannot_fix: [],
        count: 0,
        history: [],
        max: stateDef.max_iterations,
      });
    }
  }
}

// get-spawn-prompt with both skip_when AND inject_context on same state
// (harness-04 + harness-06 combined)

describe("getSpawnPrompt — skip_when evaluated before inject_context", () => {
  beforeEach(() => {
    execSyncImpl = null;
  });

  it("returns skip_reason (skip_when met) without evaluating inject_context", async () => {
    // skip_when: no_contract_changes → skip if only internal files changed
    execSyncImpl = () => ({ status: 0, stdout: "src/internal/helper.ts\n" }); // no contract files

    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "type-check",
      name: "test-flow",
      spawn_instructions: {
        "type-check": "Check types with context: ${PRIOR}",
      },
      states: {
        prior: { type: "terminal" },
        ship: { type: "terminal" },
        "type-check": {
          agent: "reviewer",
          inject_context: [{ as: "PRIOR", from: "prior" }],
          skip_when: "no_contract_changes",
          transitions: { done: "ship" },
          type: "single",
        },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "type-check",
      variables: {},
      workspace,
    });

    // Should skip — not attempt inject_context
    expect(result.prompts).toHaveLength(0);
    expect(result.skip_reason).toContain("no_contract_changes");
  });

  it("falls through to inject_context when skip_when is NOT met", async () => {
    // skip_when: no_contract_changes → don't skip if contract file changed
    execSyncImpl = () => ({ status: 0, stdout: "src/api/users.ts\n" }); // contract file changed

    const workspace = makeTmpWorkspace();
    const artifactPath = join(workspace, "context.md");
    await writeFile(artifactPath, "Important context here.");

    const flow: ResolvedFlow = {
      description: "test",
      entry: "review",
      name: "test-flow",
      spawn_instructions: {
        review: "Review with context: ${CONTEXT}",
      },
      states: {
        prior: { type: "terminal" },
        review: {
          agent: "reviewer",
          inject_context: [{ as: "CONTEXT", from: "prior" }],
          skip_when: "no_contract_changes",
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);
    const store = getExecutionStore(workspace);
    store.upsertState("prior", { artifacts: [artifactPath], entries: 1, status: "done" });

    const result = await getSpawnPrompt({
      flow,
      state_id: "review",
      variables: {},
      workspace,
    });

    // Not skipped — inject_context runs and populates CONTEXT
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].prompt).toContain("Important context here.");
    expect(result.skip_reason).toBeUndefined();
  });
});

// get-spawn-prompt — deferred-field warnings (harness-04 declared gap)

describe("getSpawnPrompt — deferred-field warnings", () => {
  it("does NOT emit deferred-field warning for 'gate' field (gate is now implemented)", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "build",
      name: "test-flow",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          agent: "implementor",
          gate: "some-gate-condition",
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "build",
      variables: {},
      workspace,
    });

    expect(result.prompts).toHaveLength(1); // still produces prompt
    // gate is implemented — no deferred warning should be emitted for it
    const gateWarnings =
      result.warnings?.filter((w) => w.includes("gate") && w.includes("not yet implemented")) ?? [];
    expect(gateWarnings).toHaveLength(0);
  });

  it("does not emit deferred-field warning for 'consultations' or 'gate'", async () => {
    // consultations and gate are now implemented — they should NOT produce deferred warnings.
    // The remaining deferred fields are: large_diff_threshold, cluster_by, timeout.
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "build",
      name: "test-flow",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          agent: "implementor",
          gate: "some-gate-condition",
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "build",
      variables: {},
      workspace,
    });

    const deferredWarnings =
      result.warnings?.filter((w) => w.includes("not yet implemented")) ?? [];
    // Neither gate nor consultations should appear as deferred warnings
    expect(deferredWarnings.some((w) => w.includes("gate"))).toBe(false);
    // consultations is not a field that can be set on a single-agent state in this schema,
    // but if it were present it would not produce a deferred warning either.
  });

  it("returns timeout_ms when state has valid 'timeout' field", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "build",
      name: "test-flow",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          agent: "implementor",
          timeout: "30m",
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "build",
      variables: {},
      workspace,
    });

    expect(result.timeout_ms).toBe(1800000); // 30 minutes
    // No deferred warning for timeout — it's now implemented
    const deferredWarnings =
      result.warnings?.filter((w) => w.includes("not yet implemented")) ?? [];
    expect(deferredWarnings.some((w) => w.includes("timeout"))).toBe(false);
  });

  it("no deferred-field warnings when timeout, large_diff_threshold, and gate are all set", async () => {
    const workspace = makeTmpWorkspace();

    const flow: ResolvedFlow = {
      description: "test",
      entry: "build",
      name: "test-flow",
      spawn_instructions: { build: "Build the feature." },
      states: {
        build: {
          agent: "implementor",
          gate: "some-gate",
          large_diff_threshold: 500,
          timeout: "15m",
          transitions: { done: "ship" },
          type: "single",
        },
        ship: { type: "terminal" },
      },
    };

    setupWorkspace(workspace, flow);

    const result = await getSpawnPrompt({
      flow,
      state_id: "build",
      variables: {},
      workspace,
    });

    // All three fields are now implemented — no deferred warnings
    const fieldWarnings = result.warnings?.filter((w) => w.includes("not yet implemented")) ?? [];
    expect(fieldWarnings.length).toBe(0);
    // timeout_ms should be set
    expect(result.timeout_ms).toBe(900000); // 15 minutes
  });
});

// Backward compatibility: board.json without new optional fields still parses

describe("backward compatibility: board.json without new fields", () => {
  it("board without parallel_results in state entries still parses and reads correctly", () => {
    // Write a board JSON that lacks the parallel_results field (old format)
    const legacyBoard = {
      base_commit: "oldsha123",
      blocked: null,
      concerns: [],
      current_state: "build",
      entry: "build",
      flow: "test-flow",
      iterations: {},
      last_updated: new Date().toISOString(),
      skipped: [],
      started: new Date().toISOString(),
      states: {
        build: {
          entries: 1,
          result: "done",
          status: "done",
          // No parallel_results field — legacy format
        },
        ship: {
          entries: 0,
          status: "pending",
        },
      },
      task: "legacy task",
    };

    // Should parse without error via BoardSchema
    const board = BoardSchema.parse(legacyBoard);
    expect(board.states.build.status).toBe("done");
    expect(board.states.build.parallel_results).toBeUndefined();
    expect(board.current_state).toBe("build");
  });

  it("board without concerns and skipped arrays is rejected by schema (they are required)", () => {
    // Board missing required fields
    const malformedBoard = {
      base_commit: "sha",
      blocked: null,
      current_state: "build",
      entry: "build",
      flow: "test-flow",
      iterations: {},
      last_updated: new Date().toISOString(),
      started: new Date().toISOString(),
      states: {},
      task: "task",
      // Missing concerns and skipped
    };

    // BoardSchema.safeParse should fail since these fields are required
    const result = BoardSchema.safeParse(malformedBoard);
    expect(result.success).toBe(false);
  });

  it("BoardSchema validates a board with new optional fields alongside existing fields", () => {
    const boardWithNewFields = {
      base_commit: "sha123",
      blocked: null,
      concerns: [],
      current_state: "build",
      entry: "build",
      flow: "test-flow",
      iterations: {
        build: {
          cannot_fix: [{ file_path: "a.ts", principle_id: "p1" }],
          count: 2,
          history: [],
          max: 3,
        },
      },
      last_updated: new Date().toISOString(),
      skipped: [],
      started: new Date().toISOString(),
      states: {
        build: {
          entries: 2,
          parallel_results: [
            { item: "task-a", status: "done" },
            { artifacts: ["report.md"], item: "task-b", status: "cannot_fix" },
          ],
          status: "done",
        },
      },
      task: "task",
    };

    const parsed = BoardSchema.safeParse(boardWithNewFields);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.states.build.parallel_results).toHaveLength(2);
      expect(parsed.data.iterations.build.cannot_fix).toHaveLength(1);
    }
  });
});

// Integration: store_pr_review → DriftStore round-trip with pr_number filtering
// (harness-01 gap: store + retrieve with filter)

describe("store_pr_review — get_pr_review_data round-trip", () => {
  it("storing multiple reviews and retrieving by pr_number returns only matching ones", async () => {
    const workspace = makeTmpWorkspace();
    await mkdir(join(workspace, ".canon"), { recursive: true });

    const { storePrReview } = await import("@features/pr-review/tools/store-pr-review.js");
    const { DriftStore } = await import("@platform/storage/drift/store.js");

    // Store two reviews for PR #1 and one for PR #2
    await storePrReview(
      {
        files: ["a.ts"],
        honored: [],
        pr_number: 1,
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        verdict: "WARNING",
        violations: [],
      },
      workspace,
    );
    await storePrReview(
      {
        files: ["a.ts"],
        honored: [],
        pr_number: 1,
        score: {
          conventions: { passed: 1, total: 1 },
          opinions: { passed: 1, total: 1 },
          rules: { passed: 1, total: 1 },
        },
        verdict: "CLEAN",
        violations: [],
      },
      workspace,
    );
    await storePrReview(
      {
        files: ["b.ts"],
        honored: [],
        pr_number: 2,
        score: {
          conventions: { passed: 0, total: 0 },
          opinions: { passed: 0, total: 0 },
          rules: { passed: 0, total: 1 },
        },
        verdict: "BLOCKING",
        violations: [{ principle_id: "p1", severity: "rule" }],
      },
      workspace,
    );

    const store = new DriftStore(workspace);
    const pr1Reviews = await store.getReviews({ prNumber: 1 });
    const pr2Reviews = await store.getReviews({ prNumber: 2 });
    const allReviews = await store.getReviews();

    expect(pr1Reviews).toHaveLength(2);
    expect(pr2Reviews).toHaveLength(1);
    expect(pr2Reviews[0].verdict).toBe("BLOCKING");
    expect(allReviews).toHaveLength(3);

    // All have unique IDs
    const ids = allReviews.map((r) => r.review_id);
    expect(new Set(ids).size).toBe(3);
  });
});
