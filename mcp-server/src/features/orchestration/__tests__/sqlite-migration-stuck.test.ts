/**
 * Integration tests for ADR-001: SQLite migration — drift store, concurrency, migration, paths, and artifacts.
 *
 * Split from sqlite-migration-integration.test.ts. Covers:
 * 4. DriftStore → DriftDb delegation round-trip (append review, query with filters)
 * 5. Concurrent report_result calls from parallel wave agents (busy_timeout)
 * 6. jsonl-store.ts has zero production importers
 * 7. assertWorkspacePath validation (guards bad paths, passes good paths)
 * 8. No file-based state (no board.json, session.json, log.jsonl after full run)
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import {
  assertWorkspacePath,
  clearStoreCache,
  getExecutionStore,
} from "@domains/workspaces/execution-store-cache.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import { afterEach, describe, expect, it } from "vitest";
import { reportResult } from "../tools/report-result.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(prefix = "sqlite-stuck-"): string {
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

// 4. DriftStore → DriftDb delegation round-trip

describe("DriftStore → DriftDb delegation round-trip", () => {
  it("appendReview then getReviews returns the entry with violations", async () => {
    const projectDir = makeTmpWorkspace("drift-integ-");

    const review: ReviewEntry = {
      files: ["src/features/orchestration/tools/report-result.ts"],
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
          file_path: "src/features/orchestration/tools/report-result.ts",
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
    expect(all[0].violations![0].file_path).toBe(
      "src/features/orchestration/tools/report-result.ts",
    );
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
