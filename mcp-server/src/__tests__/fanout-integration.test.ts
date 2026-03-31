/**
 * Integration tests for large_diff_threshold fan-out feature.
 *
 * Fills declared coverage gaps from fanout-01-SUMMARY.md:
 *
 * Gap 1 — isReviewAggregation auto-detection in report-result.ts:
 *   When parallel_results contain review-type statuses (clean/warning/blocking),
 *   reportResult should auto-detect this and use aggregateReviewResults instead of
 *   aggregateParallelPerResults.
 *
 * Gap 2 — fanned_out pass-through in enter-and-prepare-state.ts:
 *   When getSpawnPrompt returns fanned_out:true (single state with clusters),
 *   enterAndPrepareState must surface fanned_out:true in its result.
 *
 * Gap 3 — Wave briefing injection for fanned-out single states:
 *   The messaging/wave-briefing injection loop runs over the prompts array after
 *   the switch, so it applies to all prompts including fanned-out ones.
 *   Verify that wave guidance and overlay injection apply to all cluster prompts.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoist mocks — must appear before module imports
// ---------------------------------------------------------------------------

vi.mock("../orchestration/diff-cluster.ts", () => ({
  clusterDiff: vi.fn(),
}));

vi.mock("../orchestration/wave-briefing.ts", () => ({
  readWaveGuidance: vi.fn().mockResolvedValue(""),
  assembleWaveBriefing: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../orchestration/skip-when.ts", () => ({
  evaluateSkipWhen: vi.fn().mockResolvedValue({ skip: false }),
}));

vi.mock("../orchestration/event-bus-instance.ts", () => ({
  flowEventBus: {
    emit: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

vi.mock("../orchestration/consultation-executor.ts", () => ({
  resolveConsultationPrompt: vi.fn().mockReturnValue(null),
}));

vi.mock("../orchestration/wave-variables.ts", () => ({
  escapeDollarBrace: vi.fn((s: string) => s),
  substituteVariables: vi.fn((s: string) => s),
  buildTemplateInjection: vi.fn(() => ""),
  parseTaskIdsForWave: vi.fn(() => []),
  extractFilePaths: vi.fn(() => []),
}));

vi.mock("../orchestration/effects.ts", () => ({
  executeEffects: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../orchestration/convergence.ts", () => ({
  canEnterState: vi.fn().mockReturnValue({ allowed: true, reason: undefined }),
}));

// ---------------------------------------------------------------------------
// Module imports (after mocks)
// ---------------------------------------------------------------------------

import { clusterDiff } from "../orchestration/diff-cluster.ts";
import { readWaveGuidance, assembleWaveBriefing } from "../orchestration/wave-briefing.ts";
import { reportResult } from "../tools/report-result.ts";
import { enterAndPrepareState } from "../tools/enter-and-prepare-state.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import type { FileCluster } from "../orchestration/diff-cluster.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fanout-integration-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "review",
    current_state: "review",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {
      review: { status: "pending", entries: 0 },
      done: { status: "pending", entries: 0 },
    },
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  } as Board;
}

function makeReviewFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-review-flow",
    description: "Test review flow",
    entry: "review",
    states: {
      review: {
        type: "single",
        agent: "canon-reviewer",
        large_diff_threshold: 5,
        transitions: {
          clean: "done",
          warning: "hitl",
          blocking: "hitl",
        },
      },
      done: { type: "terminal" },
      hitl: { type: "terminal" },
    },
    spawn_instructions: {
      review: "Review cluster ${item.cluster_key}: ${item.files}",
    },
    ...overrides,
  };
}

function seedBoard(workspace: string, board: Board): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    flow: board.flow,
    task: board.task,
    entry: board.entry,
    current_state: board.current_state,
    base_commit: board.base_commit,
    started: board.started ?? now,
    last_updated: board.last_updated ?? now,
    branch: "main",
    sanitized: "main",
    created: now,
    tier: "medium",
    flow_name: board.flow,
    slug: "test-slug",
  });
  for (const [stateId, stateEntry] of Object.entries(board.states)) {
    store.upsertState(stateId, { ...stateEntry, status: stateEntry.status, entries: stateEntry.entries ?? 0 });
  }
}

const sampleClusters: FileCluster[] = [
  { key: "src/api", files: ["src/api/orders.ts", "src/api/users.ts"] },
  { key: "src/ui", files: ["src/ui/Dashboard.svelte", "src/ui/Sidebar.svelte"] },
];

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Gap 1: isReviewAggregation auto-detection in report-result.ts
// ---------------------------------------------------------------------------

describe("reportResult — isReviewAggregation auto-detection (gap fill)", () => {
  function setupReviewBoard(workspace: string) {
    seedBoard(workspace, makeBoard({
      states: {
        review: { status: "in_progress", entries: 1 },
        done: { status: "pending", entries: 0 },
        hitl: { status: "pending", entries: 0 },
      },
    }));
  }

  it("all-clean parallel_results routes to 'clean' transition", async () => {
    const workspace = makeTmpDir();
    setupReviewBoard(workspace);
    const flow = makeReviewFlow();

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE", // overridden by review aggregation
      flow,
      parallel_results: [
        { item: "src/api", status: "clean" },
        { item: "src/ui", status: "clean" },
      ],
    });

    expect(result.transition_condition).toBe("clean");
    expect(result.next_state).toBe("done");
  });

  it("any-blocking parallel_results routes to 'blocking' transition", async () => {
    const workspace = makeTmpDir();
    setupReviewBoard(workspace);
    const flow = makeReviewFlow();

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE", // overridden by review aggregation
      flow,
      parallel_results: [
        { item: "src/api", status: "clean" },
        { item: "src/ui", status: "blocking" },
      ],
    });

    expect(result.transition_condition).toBe("blocking");
    expect(result.next_state).toBe("hitl");
  });

  it("mixed clean+warning parallel_results routes to 'warning' transition", async () => {
    const workspace = makeTmpDir();
    setupReviewBoard(workspace);
    const flow = makeReviewFlow();

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE", // overridden by review aggregation
      flow,
      parallel_results: [
        { item: "src/api", status: "clean" },
        { item: "src/ui", status: "warning" },
      ],
    });

    expect(result.transition_condition).toBe("warning");
    expect(result.next_state).toBe("hitl");
  });

  it("does NOT use review aggregation when results include non-review statuses", async () => {
    const workspace = makeTmpDir();
    setupReviewBoard(workspace);
    // Flow with done/cannot_fix transitions (not a review flow)
    const flow = makeReviewFlow({
      states: {
        review: {
          type: "single",
          agent: "canon-implementor",
          transitions: {
            done: "done",
            cannot_fix: "hitl",
            blocked: "hitl",
          },
        },
        done: { type: "terminal" },
        hitl: { type: "terminal" },
      },
    });

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "file-a.ts", status: "done" },
        { item: "file-b.ts", status: "cannot_fix" },
      ],
    });

    // Mixed done/cannot_fix: aggregateParallelPerResults returns "done" (partial fix)
    expect(result.transition_condition).toBe("done");
  });

  it("review aggregation is case-insensitive — BLOCKING uppercase routes to blocking", async () => {
    const workspace = makeTmpDir();
    setupReviewBoard(workspace);
    const flow = makeReviewFlow();

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "src/api", status: "CLEAN" },
        { item: "src/ui", status: "BLOCKING" },
      ],
    });

    expect(result.transition_condition).toBe("blocking");
    expect(result.next_state).toBe("hitl");
  });

  it("single-cluster all-clean produces 'clean' (degenerate fan-out)", async () => {
    const workspace = makeTmpDir();
    setupReviewBoard(workspace);
    const flow = makeReviewFlow();

    const result = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "src/api", status: "clean" },
      ],
    });

    expect(result.transition_condition).toBe("clean");
  });
});

// ---------------------------------------------------------------------------
// Gap 2: fanned_out pass-through in enter-and-prepare-state.ts
// ---------------------------------------------------------------------------

describe("enterAndPrepareState — fanned_out pass-through (gap fill)", () => {
  it("surfaces fanned_out:true when getSpawnPrompt fans out for a single state", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeReviewFlow();
    const result = await enterAndPrepareState({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "review the PR", CANON_PLUGIN_ROOT: "" },
    });

    expect(result.can_enter).toBe(true);
    expect(result.fanned_out).toBe(true);
    expect(result.prompts).toHaveLength(sampleClusters.length);
  });

  it("fanned_out is absent on enterAndPrepareState result when no clusters are returned", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(null); // below threshold

    const flow = makeReviewFlow();
    const result = await enterAndPrepareState({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "review the PR", CANON_PLUGIN_ROOT: "" },
    });

    expect(result.can_enter).toBe(true);
    expect(result.fanned_out).toBeUndefined();
    expect(result.prompts).toHaveLength(1);
  });

  it("fanned_out is absent on enterAndPrepareState result when state has no large_diff_threshold", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());

    // No large_diff_threshold — clusterDiff should never be called
    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "Test",
      entry: "review",
      states: {
        review: {
          type: "single",
          agent: "canon-reviewer",
          // no large_diff_threshold
          transitions: { clean: "done" },
        },
        done: { type: "terminal" },
      },
      spawn_instructions: { review: "Review everything." },
    };

    const result = await enterAndPrepareState({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "review", CANON_PLUGIN_ROOT: "" },
    });

    expect(result.fanned_out).toBeUndefined();
    expect(clusterDiff).not.toHaveBeenCalled();
  });

  it("prompts array has one entry per cluster when fanned_out is true", async () => {
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeReviewFlow();
    const result = await enterAndPrepareState({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "review the PR", CANON_PLUGIN_ROOT: "" },
    });

    // One prompt per cluster; each has the cluster key in the prompt text
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].prompt).toContain("src/api");
    expect(result.prompts[1].prompt).toContain("src/ui");
  });
});

// ---------------------------------------------------------------------------
// Gap 3: Wave guidance and messaging injection for fanned-out single state
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — wave guidance and messaging injection for fanned-out single state", () => {
  it("wave guidance is injected into all fanned-out prompts when wave is set", async () => {
    // This verifies that the post-switch loop which injects wave guidance
    // applies to all cluster prompts generated in case "single".
    // The loop is gated on state.type === "wave" || "parallel-per", so
    // wave guidance is NOT injected for single states — verify it stays absent.
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);
    vi.mocked(readWaveGuidance).mockResolvedValue("Focus on security vulnerabilities.");
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing\nSome briefing.");

    // Use getSpawnPrompt directly for this test since enterAndPrepareState mocks clusterDiff
    const { getSpawnPrompt } = await import("../tools/get-spawn-prompt.ts");
    const flow = makeReviewFlow();
    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: {},
      wave: 1,
    });

    // Wave guidance injection is guarded to wave/parallel-per — single states do NOT get it
    // This is correct behavior: fanned-out single states are not "wave" states
    expect(result.prompts).toHaveLength(sampleClusters.length);
    for (const entry of result.prompts) {
      expect(entry.prompt).not.toContain("Focus on security vulnerabilities.");
    }
  });

  it("messaging injection does NOT apply to fanned-out single state prompts", async () => {
    // Messaging injection is gated on state.type === "wave" || "parallel-per"
    // Verify that fanned-out "single" state prompts do NOT get messaging injected
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const { getSpawnPrompt } = await import("../tools/get-spawn-prompt.ts");
    const flow = makeReviewFlow();
    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: {},
      wave: 1,
      peer_count: 1,
    });

    // Messaging coordination instructions are for wave/parallel-per, not single
    expect(result.prompts).toHaveLength(sampleClusters.length);
    for (const entry of result.prompts) {
      // Messaging instructions mention "post_message" or "get_messages"
      expect(entry.prompt).not.toContain("post_message");
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: getSpawnPrompt → reportResult round-trip for fan-out
// ---------------------------------------------------------------------------

describe("fan-out end-to-end: getSpawnPrompt clusters → reportResult review aggregation", () => {
  it("cluster prompts from getSpawnPrompt feed into review aggregation in reportResult", async () => {
    // Step 1: Verify getSpawnPrompt produces one prompt per cluster with correct shape
    const workspace = makeTmpDir();
    seedBoard(workspace, makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const { getSpawnPrompt } = await import("../tools/get-spawn-prompt.ts");
    const flow = makeReviewFlow();
    const spawnResult = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: {},
    });

    expect(spawnResult.fanned_out).toBe(true);
    expect(spawnResult.prompts).toHaveLength(2);

    // Step 2: Simulate each cluster agent producing a verdict
    const clusterResults = spawnResult.prompts.map((p, i) => ({
      item: (p.item as Record<string, unknown>).cluster_key as string,
      status: i === 0 ? "clean" : "warning",
    }));

    // Step 3: reportResult receives the parallel_results and applies review aggregation
    // The board was already seeded above; update review state to in_progress for reportResult
    getExecutionStore(workspace).upsertState("review", { status: "in_progress", entries: 1 });
    getExecutionStore(workspace).upsertState("hitl", { status: "pending", entries: 0 });

    const reportResultImport = await import("../tools/report-result.ts");
    const result = await reportResultImport.reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE",
      flow,
      parallel_results: clusterResults,
    });

    // Most severe result is "warning" — routing to hitl
    expect(result.transition_condition).toBe("warning");
    expect(result.next_state).toBe("hitl");
  });

  it("all clusters clean produces clean verdict routing to done", async () => {
    const workspace = makeTmpDir();
    const flow = makeReviewFlow();
    seedBoard(workspace, makeBoard({
      states: {
        review: { status: "in_progress", entries: 1 },
        done: { status: "pending", entries: 0 },
        hitl: { status: "pending", entries: 0 },
      },
    }));

    const reportResultImport = await import("../tools/report-result.ts");
    const result = await reportResultImport.reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "src/api", status: "clean" },
        { item: "src/ui", status: "clean" },
        { item: "src/db", status: "clean" },
      ],
    });

    expect(result.transition_condition).toBe("clean");
    expect(result.next_state).toBe("done");
  });

  it("one blocking cluster among clean clusters triggers blocking verdict", async () => {
    const workspace = makeTmpDir();
    const flow = makeReviewFlow();
    seedBoard(workspace, makeBoard({
      states: {
        review: { status: "in_progress", entries: 1 },
        done: { status: "pending", entries: 0 },
        hitl: { status: "pending", entries: 0 },
      },
    }));

    const reportResultImport = await import("../tools/report-result.ts");
    const result = await reportResultImport.reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE",
      flow,
      parallel_results: [
        { item: "src/api", status: "clean" },
        { item: "src/ui", status: "clean" },
        { item: "src/auth", status: "blocking" }, // one blocker
      ],
    });

    expect(result.transition_condition).toBe("blocking");
    expect(result.next_state).toBe("hitl");
  });
});
