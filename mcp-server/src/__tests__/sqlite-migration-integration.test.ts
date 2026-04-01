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
import { DriftStore } from "../drift/store.ts";
import { assertWorkspacePath, clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";
import type { ReviewEntry } from "../schema.ts";
import { getMessages } from "../tools/get-messages.ts";
import { postMessage } from "../tools/post-message.ts";
import { reportResult } from "../tools/report-result.ts";
import { assertOk } from "../utils/tool-result.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpWorkspace(prefix = "sqlite-integ-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A canonical three-state flow: build → review → ship */
function makeThreeStateFlow(): ResolvedFlow {
  return {
    name: "quick-fix",
    description: "Build, review, ship",
    entry: "build",
    spawn_instructions: {},
    states: {
      build: {
        type: "single",
        transitions: { done: "review", failed: "hitl" },
      },
      review: {
        type: "single",
        transitions: { done: "ship", failed: "hitl" },
      },
      ship: { type: "terminal" },
      hitl: { type: "terminal" },
    },
  };
}

/** Seed a workspace store with minimal execution data for a given flow. */
function seedWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    flow: flow.name,
    task: "integration test task",
    entry: flow.entry,
    current_state: flow.entry,
    base_commit: "deadbeef",
    started: now,
    last_updated: now,
    branch: "feat/test",
    sanitized: "feat-test",
    created: now,
    tier: "small",
    flow_name: flow.name,
    slug: "integration-test-task",
    status: "active",
  });

  // Create pending state entries and iteration records for each non-terminal state
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    if (stateDef.type === "terminal") continue;
    store.upsertState(stateId, { status: "pending", entries: 0 });
    store.upsertIteration(stateId, { count: 0, max: 3, history: [], cannot_fix: [] });
  }
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// 1. Full lifecycle: init → enter state → report result → next state → complete flow
// ---------------------------------------------------------------------------

describe("full SQLite lifecycle: init → report_result → complete_flow", () => {
  it("board state advances from build → review → ship via report_result", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    // Verify initial state
    const initialBoard = getExecutionStore(workspace).getBoard()!;
    expect(initialBoard.current_state).toBe("build");
    expect(initialBoard.states["build"].status).toBe("pending");

    // Agent reports build done
    const buildResult = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      artifacts: ["src/fix.ts"],
    });

    assertOk(buildResult);
    expect(buildResult.transition_condition).toBe("done");
    expect(buildResult.next_state).toBe("review");
    expect(buildResult.stuck).toBe(false);
    expect(buildResult.hitl_required).toBe(false);

    // Board persisted: current_state is now "review", build is done
    const midBoard = getExecutionStore(workspace).getBoard()!;
    expect(midBoard.current_state).toBe("review");
    expect(midBoard.states["build"].status).toBe("done");
    expect(midBoard.states["build"].result).toBe("done");
    expect(midBoard.states["build"].artifacts).toEqual(["src/fix.ts"]);

    // Agent reports review done
    const reviewResult = await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE",
      flow,
    });

    assertOk(reviewResult);
    expect(reviewResult.next_state).toBe("ship");

    // Verify ship state is the next state in the board
    const finalBoard = getExecutionStore(workspace).getBoard()!;
    expect(finalBoard.current_state).toBe("ship");
    expect(finalBoard.states["review"].status).toBe("done");
  });

  it("progress_line from report_result accumulates in SQLite, not in log.jsonl", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      progress_line: "Build completed: 3 files changed",
    });

    await reportResult({
      workspace,
      state_id: "review",
      status_keyword: "DONE",
      flow,
      progress_line: "Review passed: no violations",
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
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
    });

    // Read events from SQLite directly
    const store = getExecutionStore(workspace);
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
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
      workspace,
      state_id: "build",
      status_keyword: "DONE_WITH_CONCERNS",
      flow,
      concern_text: "TypeScript strict mode violations remain in legacy files",
    });

    const board = getExecutionStore(workspace).getBoard()!;
    expect(board.concerns).toHaveLength(1);
    expect(board.concerns[0].message).toBe("TypeScript strict mode violations remain in legacy files");
    expect(board.concerns[0].state_id).toBe("build");
  });

  it("quality signals (gate_results, test_results) are persisted to board state metrics", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    const gateResults = [{ passed: true, gate: "npm-test", command: "npm test", output: "All passed", exitCode: 0 }];
    const testResults = { passed: 42, failed: 0, skipped: 2 };

    await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "DONE",
      flow,
      gate_results: gateResults,
      test_results: testResults,
      files_changed: 5,
      metrics: { duration_ms: 1500, spawns: 1, model: "claude-3" },
    });

    const board = getExecutionStore(workspace).getBoard()!;
    const buildState = board.states["build"];
    expect(buildState.gate_results).toEqual(gateResults);
    expect(buildState.metrics?.test_results).toEqual(testResults);
    expect(buildState.metrics?.files_changed).toBe(5);
    expect(buildState.metrics?.duration_ms).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// 2. Messages round-trip through store
// ---------------------------------------------------------------------------

describe("messages round-trip through SQLite store", () => {
  it("postMessage persists to store; getMessages retrieves in order", async () => {
    const workspace = makeTmpWorkspace();
    seedWorkspace(workspace, makeThreeStateFlow());

    await postMessage({ workspace, channel: "main", from: "orchestrator", content: "Hello" });
    await postMessage({ workspace, channel: "main", from: "agent", content: "Working on it" });
    await postMessage({ workspace, channel: "notes", from: "orchestrator", content: "Side note" });

    const mainMessages = await getMessages({ workspace, channel: "main" });
    expect(mainMessages.messages).toHaveLength(2);
    expect(mainMessages.messages[0].content).toBe("Hello");
    expect(mainMessages.messages[1].content).toBe("Working on it");

    // Different channel is isolated
    const notesMessages = await getMessages({ workspace, channel: "notes" });
    expect(notesMessages.messages).toHaveLength(1);
    expect(notesMessages.messages[0].content).toBe("Side note");
  });

  it("getMessages with include_events returns wave events as well", async () => {
    const workspace = makeTmpWorkspace();
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      flow: "test",
      task: "task",
      entry: "implement",
      current_state: "implement",
      base_commit: "abc",
      started: now,
      last_updated: now,
      branch: "main",
      sanitized: "main",
      created: now,
      tier: "small",
      flow_name: "test",
      slug: "task",
    });
    store.upsertState("implement", { status: "in_progress", entries: 1, wave: 1 });

    // Post a message and inject a wave event
    await postMessage({ workspace, channel: "main", from: "orchestrator", content: "Hi" });
    store.postWaveEvent({
      id: "evt-test-001",
      type: "guidance",
      payload: { description: "Added authentication" },
      timestamp: new Date().toISOString(),
      status: "pending",
    });

    const result = await getMessages({ workspace, channel: "main", include_events: true });
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.events).toBeDefined();
    expect(result.events!.some((e) => e.id === "evt-test-001")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Wave events lifecycle
// ---------------------------------------------------------------------------

describe("wave events lifecycle through SQLite store", () => {
  it("wave event transitions from pending → applied, clearing pending count", async () => {
    const workspace = makeTmpWorkspace();
    const store = getExecutionStore(workspace);
    const now = new Date().toISOString();
    store.initExecution({
      flow: "test",
      task: "task",
      entry: "implement",
      current_state: "implement",
      base_commit: "abc",
      started: now,
      last_updated: now,
      branch: "main",
      sanitized: "main",
      created: now,
      tier: "small",
      flow_name: "test",
      slug: "task",
    });

    const eventId = "evt-apply-001";
    store.postWaveEvent({
      id: eventId,
      type: "guidance",
      payload: { description: "Scope expanded" },
      timestamp: now,
      status: "pending",
    });

    // Apply the event
    store.updateWaveEvent(eventId, {
      status: "applied",
      applied_at: new Date().toISOString(),
      resolution: { decision: "accepted" },
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
      flow: "test",
      task: "task",
      entry: "implement",
      current_state: "implement",
      base_commit: "abc",
      started: now,
      last_updated: now,
      branch: "main",
      sanitized: "main",
      created: now,
      tier: "small",
      flow_name: "test",
      slug: "task",
    });

    const eventId = "evt-reject-001";
    store.postWaveEvent({
      id: eventId,
      type: "guidance",
      payload: { description: "Unrelated change" },
      timestamp: now,
      status: "pending",
    });

    store.updateWaveEvent(eventId, {
      status: "rejected",
      rejection_reason: "Out of scope for this iteration",
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
      flow: "test",
      task: "task",
      entry: "implement",
      current_state: "implement",
      base_commit: "abc",
      started: now,
      last_updated: now,
      branch: "main",
      sanitized: "main",
      created: now,
      tier: "small",
      flow_name: "test",
      slug: "task",
    });
    store.upsertState("implement", { status: "in_progress", entries: 1, wave: 1 });

    const { resolveWaveEvent } = await import("../tools/resolve-wave-event.ts");
    const { injectWaveEvent } = await import("../tools/inject-wave-event.ts");

    const injected = await injectWaveEvent({
      workspace,
      type: "guidance",
      payload: { description: "Test change" },
    });

    await resolveWaveEvent({
      workspace,
      event_id: injected.event.id,
      action: "apply",
    });

    // log.jsonl should not exist — events go to SQLite
    const logPath = join(workspace, "log.jsonl");
    expect(existsSync(logPath)).toBe(false);

    // wave_event_resolved should be in the SQLite events table
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    const events = db.prepare("SELECT * FROM events WHERE type = 'wave_event_resolved'").all() as Array<{
      type: string;
      payload: string;
    }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.eventId).toBe(injected.event.id);
    expect(payload.action).toBe("apply");
  });
});

// ---------------------------------------------------------------------------
// 4. DriftStore → DriftDb delegation round-trip
// ---------------------------------------------------------------------------

describe("DriftStore → DriftDb delegation round-trip", () => {
  it("appendReview then getReviews returns the entry with violations", async () => {
    const projectDir = makeTmpWorkspace("drift-integ-");

    const review: ReviewEntry = {
      review_id: "rev_test001",
      timestamp: new Date().toISOString(),
      files: ["src/tools/report-result.ts"],
      honored: [],
      score: {
        rules: { passed: 0, total: 1 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
      verdict: "BLOCKING",
      violations: [
        {
          principle_id: "deep-modules",
          severity: "rule",
          file_path: "src/tools/report-result.ts",
          impact_score: 0.8,
          message: "Leaking internal SQL via public API",
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
      review_id: "rev_a",
      timestamp: now,
      files: ["a.ts"],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 1 },
        conventions: { passed: 0, total: 0 },
      },
      verdict: "WARNING",
      violations: [{ principle_id: "fail-fast", severity: "strong-opinion" }],
    });

    await store.appendReview({
      review_id: "rev_b",
      timestamp: now,
      files: ["b.ts"],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 1 },
      },
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
      rules: { passed: 0, total: 0 },
      opinions: { passed: 0, total: 0 },
      conventions: { passed: 0, total: 0 },
    };

    await store.appendReview({
      review_id: "rev_main",
      timestamp: now,
      files: ["main.ts"],
      honored: [],
      score: emptyScore,
      verdict: "CLEAN",
      violations: [],
      branch: "main",
    });

    await store.appendReview({
      review_id: "rev_feat",
      timestamp: now,
      files: ["feat.ts"],
      honored: [],
      score: emptyScore,
      verdict: "CLEAN",
      violations: [],
      branch: "feat/new-feature",
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
      rules: { passed: 0, total: 0 },
      opinions: { passed: 0, total: 0 },
      conventions: { passed: 0, total: 0 },
    };

    await store.appendReview({
      review_id: "rev_pr_old",
      timestamp: earlier,
      files: [],
      honored: [],
      score: emptyScore,
      verdict: "CLEAN",
      violations: [],
      pr_number: 42,
    });

    await store.appendReview({
      review_id: "rev_pr_new",
      timestamp: later,
      files: [],
      honored: [],
      score: emptyScore,
      verdict: "BLOCKING",
      violations: [],
      pr_number: 42,
    });

    const last = await store.getLastReviewForPr(42);
    expect(last).not.toBeNull();
    expect(last!.review_id).toBe("rev_pr_new");
    expect(last!.verdict).toBe("BLOCKING");
  });
});

// ---------------------------------------------------------------------------
// 5. Concurrent report_result calls (SQLite busy_timeout)
// ---------------------------------------------------------------------------

describe("concurrent report_result calls serialize without SQLITE_BUSY", () => {
  it("two simultaneous report_result calls on the same workspace complete without error", async () => {
    const workspace = makeTmpWorkspace("concurrent-");
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    // Launch two concurrent report_result calls for the same state
    // (simulates parallel wave agents both completing at roughly the same time)
    const [r1, r2] = await Promise.all([
      reportResult({
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        progress_line: "Agent A done",
      }),
      reportResult({
        workspace,
        state_id: "build",
        status_keyword: "DONE",
        flow,
        progress_line: "Agent B done",
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

// ---------------------------------------------------------------------------
// 6. jsonl-store.ts has zero production importers
// ---------------------------------------------------------------------------

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
        files = await readdir(join(srcRoot, dir));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
        const content = await readFile(join(srcRoot, dir, file), "utf-8");
        if (content.includes("jsonl-store")) {
          importsJsonlStore.push(`${dir}/${file}`);
        }
      }
    }

    expect(importsJsonlStore).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. assertWorkspacePath validation
// ---------------------------------------------------------------------------

describe("assertWorkspacePath validation", () => {
  it("does NOT throw for paths containing .canon/workspaces/", () => {
    expect(() => assertWorkspacePath("/home/user/project/.canon/workspaces/feat/task-slug")).not.toThrow();
  });

  it("does NOT throw for Windows-style paths containing .canon\\workspaces\\", () => {
    expect(() => assertWorkspacePath("C:\\project\\.canon\\workspaces\\main\\task")).not.toThrow();
  });

  it("throws for a project root path without .canon/workspaces/", () => {
    // We temporarily unset VITEST to test the production guard
    const orig = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => assertWorkspacePath("/home/user/project")).toThrow(/Invalid workspace path.*\.canon\/workspaces\//);
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

// ---------------------------------------------------------------------------
// 8. No file-based state (no board.json, session.json, log.jsonl after full run)
// ---------------------------------------------------------------------------

describe("no file-based orchestration state artifacts", () => {
  it("after a full build→review→ship run, no board.json or session.json exist", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeThreeStateFlow();
    seedWorkspace(workspace, flow);

    await reportResult({ workspace, state_id: "build", status_keyword: "DONE", flow });
    await reportResult({ workspace, state_id: "review", status_keyword: "DONE", flow });

    expect(existsSync(join(workspace, "board.json"))).toBe(false);
    expect(existsSync(join(workspace, "session.json"))).toBe(false);
    expect(existsSync(join(workspace, "log.jsonl"))).toBe(false);
    expect(existsSync(join(workspace, "orchestration.db"))).toBe(true);
  });
});
