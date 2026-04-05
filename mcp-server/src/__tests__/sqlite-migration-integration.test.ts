/**
 * Integration tests for ADR-001: SQLite migration
 *
 * Covers:
 * 1. Full lifecycle: init workspace → enter state → report result → enter next state → complete flow
 * 2. Progress entries accumulate correctly through store
 * 3. Messages round-trip through store (post → get)
 * 4. Wave events lifecycle (inject → apply / inject → reject)
 * 5. DriftStore → DriftDb delegation round-trip (append review, query with filters)
 * 6. Concurrent report_result calls from parallel wave agents (busy_timeout)
 * 7. event log entries written to SQLite events table (no log.jsonl created)
 * 8. assertWorkspacePath validation (guards bad paths, passes good paths)
 * 9. jsonl-store.ts has zero production importers
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkspacePath,
  clearStoreCache,
  getExecutionStore,
} from "../orchestration/execution-store.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import { DriftStore } from "../platform/storage/drift/store.ts";
import { assertOk } from "../shared/lib/tool-result.ts";
import type { ReviewEntry } from "../shared/schema.ts";
import { getMessages } from "../tools/get-messages.ts";
import { postMessage } from "../tools/post-message.ts";
import { reportResult } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(prefix = "sqlite-integ-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A canonical three-state flow: build → review → ship */
function makeThreeStateFlow(): ResolvedFlow {
  return {
    description: "Build, review, ship",
    entry: "build",
    name: "fast-path",
    spawn_instructions: {},
    states: {
      build: {
        transitions: { done: "review", failed: "hitl" },
        type: "single",
      },
      hitl: { type: "terminal" },
      review: {
        transitions: { done: "ship", failed: "hitl" },
        type: "single",
      },
      ship: { type: "terminal" },
    },
  };
}

/** Seed a workspace store with minimal execution data for a given flow. */
function seedWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "deadbeef",
    branch: "feat/test",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "feat-test",
    slug: "integration-test-task",
    started: now,
    status: "active",
    task: "integration test task",
    tier: "small",
  });

  // Create pending state entries and iteration records for each non-terminal state
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    if (stateDef.type === "terminal") continue;
    store.upsertState(stateId, { entries: 0, status: "pending" });
    store.upsertIteration(stateId, { cannot_fix: [], count: 0, history: [], max: 3 });
  }
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// 1. Full lifecycle: init → enter state → report result → next state → complete flow

describe("full SQLite lifecycle: init → report_result → complete_flow", () => {
  it("board state advances from build → review → ship via report_result", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    // Verify initial state
    const initialBoard = getExecutionStore(workspace).getBoard()!;
    expect(initialBoard.current_state).toBe("build");
    expect(initialBoard.states.build.status).toBe("pending");

    // Agent reports build done
    const buildResult = await reportResult({
      artifacts: ["src/fix.ts"],
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    assertOk(buildResult);
    expect(buildResult.transition_condition).toBe("done");
    expect(buildResult.next_state).toBe("review");
    expect(buildResult.stuck).toBe(false);
    expect(buildResult.hitl_required).toBe(false);

    // Board persisted: current_state is now "review", build is done
    const midBoard = getExecutionStore(workspace).getBoard()!;
    expect(midBoard.current_state).toBe("review");
    expect(midBoard.states.build.status).toBe("done");
    expect(midBoard.states.build.result).toBe("done");
    expect(midBoard.states.build.artifacts).toEqual(["src/fix.ts"]);

    // Agent reports review done
    const reviewResult = await reportResult({
      flow,
      state_id: "review",
      status_keyword: "DONE",
      workspace,
    });

    assertOk(reviewResult);
    expect(reviewResult.next_state).toBe("ship");

    // Verify ship state is the next state in the board
    const finalBoard = getExecutionStore(workspace).getBoard()!;
    expect(finalBoard.current_state).toBe("ship");
    expect(finalBoard.states.review.status).toBe("done");
  });

  it("progress_line from report_result accumulates in SQLite, not in log.jsonl", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    await reportResult({
      flow,
      progress_line: "Build completed: 3 files changed",
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    await reportResult({
      flow,
      progress_line: "Review passed: no violations",
      state_id: "review",
      status_keyword: "DONE",
      workspace,
    });

    const store = getExecutionStore(workspace);
    const progress = store.getProgress();

    expect(progress).toContain("Build completed: 3 files changed");
    expect(progress).toContain("Review passed: no violations");

    // Verify log.jsonl was NOT created (events go to SQLite events table now)
    const logPath = join(workspace, "log.jsonl");
    expect(existsSync(logPath)).toBe(false);
  });

  it("events emitted by report_result are stored in the SQLite events table", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });

    // Read events from SQLite directly
    const store = getExecutionStore(workspace);
    const db = (store as any).db;
    const events = db.prepare("SELECT * FROM events ORDER BY id ASC").all() as Array<{
      id: number;
      type: string;
      payload: string;
      timestamp: string;
    }>;

    // state_completed and transition_evaluated should be recorded
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("state_completed");
    expect(eventTypes).toContain("transition_evaluated");

    // state_completed payload should reference the correct state
    const completedEvent = events.find((e) => e.type === "state_completed")!;
    const completedPayload = JSON.parse(completedEvent.payload);
    expect(completedPayload.stateId).toBe("build");
    expect(completedPayload.result).toBe("done");
  });

  it("concern_text from done_with_concerns is persisted to board.concerns", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    await reportResult({
      concern_text: "TypeScript strict mode violations remain in legacy files",
      flow,
      state_id: "build",
      status_keyword: "DONE_WITH_CONCERNS",
      workspace,
    });

    const board = getExecutionStore(workspace).getBoard()!;
    expect(board.concerns).toHaveLength(1);
    expect(board.concerns[0].message).toBe(
      "TypeScript strict mode violations remain in legacy files",
    );
    expect(board.concerns[0].state_id).toBe("build");
  });

  it("quality signals (gate_results, test_results) are persisted to board state metrics", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    const gateResults = [
      { command: "npm test", exitCode: 0, gate: "npm-test", output: "All passed", passed: true },
    ];
    const testResults = { failed: 0, passed: 42, skipped: 2 };

    await reportResult({
      files_changed: 5,
      flow,
      gate_results: gateResults,
      metrics: { duration_ms: 1500, model: "claude-3", spawns: 1 },
      state_id: "build",
      status_keyword: "DONE",
      test_results: testResults,
      workspace,
    });

    const board = getExecutionStore(workspace).getBoard()!;
    const buildState = board.states.build;
    expect(buildState.gate_results).toEqual(gateResults);
    expect(buildState.metrics?.test_results).toEqual(testResults);
    expect(buildState.metrics?.files_changed).toBe(5);
    expect(buildState.metrics?.duration_ms).toBe(1500);
  });
});

// 2. Messages round-trip through store

describe("messages round-trip through SQLite store", () => {
  it("postMessage persists to store; getMessages retrieves in order", async () => {
    const workspace = makeTmpWorkspace();
    seedWorkspace(workspace, makeThreeStateFlow());

    await postMessage({ channel: "main", content: "Hello", from: "orchestrator", workspace });
    await postMessage({ channel: "main", content: "Working on it", from: "agent", workspace });
    await postMessage({ channel: "notes", content: "Side note", from: "orchestrator", workspace });

    const mainMessages = await getMessages({ channel: "main", workspace });
    expect(mainMessages.messages).toHaveLength(2);
    expect(mainMessages.messages[0].content).toBe("Hello");
    expect(mainMessages.messages[1].content).toBe("Working on it");

    // Different channel is isolated
    const notesMessages = await getMessages({ channel: "notes", workspace });
    expect(notesMessages.messages).toHaveLength(1);
    expect(notesMessages.messages[0].content).toBe("Side note");
  });

  it("getMessages with include_events returns wave events as well", async () => {
    const workspace = makeTmpWorkspace();
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      base_commit: "abc",
      branch: "main",
      created: now,
      current_state: "implement",
      entry: "implement",
      flow: "test",
      flow_name: "test",
      last_updated: now,
      sanitized: "main",
      slug: "task",
      started: now,
      task: "task",
      tier: "small",
    });
    store.upsertState("implement", { entries: 1, status: "in_progress", wave: 1 });

    // Post a message and inject a wave event
    await postMessage({ channel: "main", content: "Hi", from: "orchestrator", workspace });
    store.postWaveEvent({
      id: "evt-test-001",
      payload: { description: "Added authentication" },
      status: "pending",
      timestamp: new Date().toISOString(),
      type: "guidance",
    });

    const result = await getMessages({ channel: "main", include_events: true, workspace });
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.events).toBeDefined();
    expect(result.events!.some((e) => e.id === "evt-test-001")).toBe(true);
  });
});

// 3. Wave events lifecycle

describe("wave events lifecycle through SQLite store", () => {
  it("wave event transitions from pending → applied, clearing pending count", async () => {
    const workspace = makeTmpWorkspace();
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      base_commit: "abc",
      branch: "main",
      created: now,
      current_state: "implement",
      entry: "implement",
      flow: "test",
      flow_name: "test",
      last_updated: now,
      sanitized: "main",
      slug: "task",
      started: now,
      task: "task",
      tier: "small",
    });

    const eventId = "evt-apply-001";
    store.postWaveEvent({
      id: eventId,
      payload: { description: "Scope expanded" },
      status: "pending",
      timestamp: now,
      type: "guidance",
    });

    // Apply the event
    store.updateWaveEvent(eventId, {
      applied_at: new Date().toISOString(),
      resolution: { decision: "accepted" },
      status: "applied",
    });

    const allEvents = store.getWaveEvents();
    const evt = allEvents.find((e) => e.id === eventId)!;
    expect(evt.status).toBe("applied");
    expect(evt.resolution).toEqual({ decision: "accepted" });

    // No more pending events
    const pending = store.getWaveEvents({ status: "pending" });
    expect(pending).toHaveLength(0);
  });

  it("wave event transitions from pending → rejected with reason", async () => {
    const workspace = makeTmpWorkspace();
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      base_commit: "abc",
      branch: "main",
      created: now,
      current_state: "implement",
      entry: "implement",
      flow: "test",
      flow_name: "test",
      last_updated: now,
      sanitized: "main",
      slug: "task",
      started: now,
      task: "task",
      tier: "small",
    });

    const eventId = "evt-reject-001";
    store.postWaveEvent({
      id: eventId,
      payload: { description: "Unrelated change" },
      status: "pending",
      timestamp: now,
      type: "guidance",
    });

    store.updateWaveEvent(eventId, {
      rejection_reason: "Out of scope for this iteration",
      status: "rejected",
    });

    const evt = store.getWaveEvents().find((e) => e.id === eventId)!;
    expect(evt.status).toBe("rejected");
    expect(evt.rejection_reason).toBe("Out of scope for this iteration");
  });

  it("resolve-wave-event stores event in SQLite events table (not log.jsonl)", async () => {
    const workspace = makeTmpWorkspace();
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      base_commit: "abc",
      branch: "main",
      created: now,
      current_state: "implement",
      entry: "implement",
      flow: "test",
      flow_name: "test",
      last_updated: now,
      sanitized: "main",
      slug: "task",
      started: now,
      task: "task",
      tier: "small",
    });
    store.upsertState("implement", { entries: 1, status: "in_progress", wave: 1 });

    const { resolveWaveEvent } = await import("../tools/resolve-wave-event.ts");
    const { injectWaveEvent } = await import("../tools/inject-wave-event.ts");

    const injected = await injectWaveEvent({
      payload: { description: "Test change" },
      type: "guidance",
      workspace,
    });

    await resolveWaveEvent({
      action: "apply",
      event_id: injected.event.id,
      workspace,
    });

    // log.jsonl should not exist — events go to SQLite
    const logPath = join(workspace, "log.jsonl");
    expect(existsSync(logPath)).toBe(false);

    // wave_event_resolved should be in the SQLite events table
    const db = (store as any).db;
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'wave_event_resolved'")
      .all() as Array<{ type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.eventId).toBe(injected.event.id);
    expect(payload.action).toBe("apply");
  });
});

// 4. DriftStore → DriftDb delegation round-trip

describe("DriftStore → DriftDb delegation round-trip", () => {
  it("appendReview then getReviews returns the entry with violations", async () => {
    const projectDir = makeTmpWorkspace("drift-integ-");

    const review: ReviewEntry = {
      files: ["src/tools/report-result.ts"],
      honored: [],
      review_id: "rev_test001",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 1 },
      },
      timestamp: new Date().toISOString(),
      verdict: "BLOCKING",
      violations: [
        {
          file_path: "src/tools/report-result.ts",
          impact_score: 0.8,
          message: "Leaking internal SQL via public API",
          principle_id: "deep-modules",
          severity: "rule",
        },
      ],
    };

    const store = new DriftStore(projectDir);
    await store.appendReview(review);

    const all = await store.getReviews();
    expect(all).toHaveLength(1);
    expect(all[0].review_id).toBe("rev_test001");
    expect(all[0].verdict).toBe("BLOCKING");
    expect(all[0].violations).toHaveLength(1);
    expect(all[0].violations![0].principle_id).toBe("deep-modules");
    expect(all[0].violations![0].severity).toBe("rule");
    expect(all[0].violations![0].file_path).toBe("src/tools/report-result.ts");
  });

  it("getReviews filters by principleId correctly", async () => {
    const projectDir = makeTmpWorkspace("drift-filter-");
    const store = new DriftStore(projectDir);
    const now = new Date().toISOString();

    await store.appendReview({
      files: ["a.ts"],
      honored: [],
      review_id: "rev_a",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 1 },
        rules: { passed: 0, total: 0 },
      },
      timestamp: now,
      verdict: "WARNING",
      violations: [{ principle_id: "fail-fast", severity: "strong-opinion" }],
    });

    await store.appendReview({
      files: ["b.ts"],
      honored: [],
      review_id: "rev_b",
      score: {
        conventions: { passed: 0, total: 1 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 0 },
      },
      timestamp: now,
      verdict: "WARNING",
      violations: [{ principle_id: "deep-modules", severity: "convention" }],
    });

    // Filter by principle_id
    const failFast = await store.getReviews({ principleId: "fail-fast" });
    expect(failFast).toHaveLength(1);
    expect(failFast[0].review_id).toBe("rev_a");

    const deepModules = await store.getReviews({ principleId: "deep-modules" });
    expect(deepModules).toHaveLength(1);
    expect(deepModules[0].review_id).toBe("rev_b");
  });

  it("getReviews filters by branch correctly", async () => {
    const projectDir = makeTmpWorkspace("drift-branch-");
    const store = new DriftStore(projectDir);
    const now = new Date().toISOString();

    const emptyScore = {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 0, total: 0 },
      rules: { passed: 0, total: 0 },
    };

    await store.appendReview({
      branch: "main",
      files: ["main.ts"],
      honored: [],
      review_id: "rev_main",
      score: emptyScore,
      timestamp: now,
      verdict: "CLEAN",
      violations: [],
    });

    await store.appendReview({
      branch: "feat/new-feature",
      files: ["feat.ts"],
      honored: [],
      review_id: "rev_feat",
      score: emptyScore,
      timestamp: now,
      verdict: "CLEAN",
      violations: [],
    });

    const mainOnly = await store.getReviews({ branch: "main" });
    expect(mainOnly).toHaveLength(1);
    expect(mainOnly[0].review_id).toBe("rev_main");
  });

  it("getLastReviewForPr returns most recent review for pr_number", async () => {
    const projectDir = makeTmpWorkspace("drift-pr-");
    const store = new DriftStore(projectDir);

    const earlier = new Date(Date.now() - 1000).toISOString();
    const later = new Date().toISOString();

    const emptyScore = {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 0, total: 0 },
      rules: { passed: 0, total: 0 },
    };

    await store.appendReview({
      files: [],
      honored: [],
      pr_number: 42,
      review_id: "rev_pr_old",
      score: emptyScore,
      timestamp: earlier,
      verdict: "CLEAN",
      violations: [],
    });

    await store.appendReview({
      files: [],
      honored: [],
      pr_number: 42,
      review_id: "rev_pr_new",
      score: emptyScore,
      timestamp: later,
      verdict: "BLOCKING",
      violations: [],
    });

    const last = await store.getLastReviewForPr(42);
    expect(last).not.toBeNull();
    expect(last!.review_id).toBe("rev_pr_new");
    expect(last!.verdict).toBe("BLOCKING");
  });
});

// 5. Concurrent report_result calls (SQLite busy_timeout)

describe("concurrent report_result calls serialize without SQLITE_BUSY", () => {
  it("two simultaneous report_result calls on the same workspace complete without error", async () => {
    const workspace = makeTmpWorkspace("concurrent-");
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    // Launch two concurrent report_result calls for the same state
    // (simulates parallel wave agents both completing at roughly the same time)
    const [r1, r2] = await Promise.all([
      reportResult({
        flow,
        progress_line: "Agent A done",
        state_id: "build",
        status_keyword: "DONE",
        workspace,
      }),
      reportResult({
        flow,
        progress_line: "Agent B done",
        state_id: "build",
        status_keyword: "DONE",
        workspace,
      }),
    ]);

    // Both calls should complete without throwing
    assertOk(r1);
    assertOk(r2);
    expect(r1.transition_condition).toBe("done");
    expect(r2.transition_condition).toBe("done");

    // Progress should contain at least one of the lines
    const progress = getExecutionStore(workspace).getProgress();
    expect(progress).toMatch(/Agent [AB] done/);
  });
});

// 6. jsonl-store.ts has zero production importers

describe("jsonl-store.ts migration completeness", () => {
  it("no production source file imports from jsonl-store", async () => {
    // Verify that the JSONL store has no production importers.
    // We do this by checking that none of the tool/orchestration/drift source files
    // import from jsonl-store.ts.
    const { readdir, readFile } = await import("node:fs/promises");

    const srcRoot = join(import.meta.dirname!, "..");
    const dirsToCheck = ["tools", "orchestration", "drift", "utils"];

    const importsJsonlStore: string[] = [];

    for (const dir of dirsToCheck) {
      let files: string[];
      try {
        // biome-ignore lint/performance/noAwaitInLoops: sequential directory scan — results accumulate into shared array
        files = await readdir(join(srcRoot, dir));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
        // biome-ignore lint/performance/noAwaitInLoops: sequential file reads — results accumulate into shared array
        const content = await readFile(join(srcRoot, dir, file), "utf-8");
        if (content.includes("jsonl-store")) {
          importsJsonlStore.push(`${dir}/${file}`);
        }
      }
    }

    expect(importsJsonlStore).toEqual([]);
  });
});

// 7. assertWorkspacePath validation

describe("assertWorkspacePath validation", () => {
  it("does NOT throw for paths containing .canon/workspaces/", () => {
    expect(() =>
      assertWorkspacePath("/home/user/project/.canon/workspaces/feat/task-slug"),
    ).not.toThrow();
  });

  it("does NOT throw for Windows-style paths containing .canon\\workspaces\\", () => {
    expect(() => assertWorkspacePath("C:\\project\\.canon\\workspaces\\main\\task")).not.toThrow();
  });

  it("throws for a project root path without .canon/workspaces/", () => {
    // We temporarily unset VITEST to test the production guard
    const orig = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => assertWorkspacePath("/home/user/project")).toThrow(
        /Invalid workspace path.*\.canon\/workspaces\//,
      );
    } finally {
      if (orig !== undefined) process.env.VITEST = orig;
    }
  });

  it("throws for a temp dir path without .canon/workspaces/", () => {
    const orig = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => assertWorkspacePath("/tmp/some-temp-dir")).toThrow(/Invalid workspace path/);
    } finally {
      if (orig !== undefined) process.env.VITEST = orig;
    }
  });
});

// 8. No file-based state (no board.json, session.json, log.jsonl after full run)

describe("no file-based orchestration state artifacts", () => {
  it("after a full build→review→ship run, no board.json or session.json exist", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    await reportResult({ flow, state_id: "build", status_keyword: "DONE", workspace });
    await reportResult({ flow, state_id: "review", status_keyword: "DONE", workspace });

    expect(existsSync(join(workspace, "board.json"))).toBe(false);
    expect(existsSync(join(workspace, "session.json"))).toBe(false);
    expect(existsSync(join(workspace, "log.jsonl"))).toBe(false);
    expect(existsSync(join(workspace, "orchestration.db"))).toBe(true);
  });
});
