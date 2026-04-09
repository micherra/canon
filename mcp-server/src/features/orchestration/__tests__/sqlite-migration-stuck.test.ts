/**
 * Integration tests for ADR-001: SQLite migration — concurrency, migration, paths, and artifacts.
 *
 * Split from sqlite-migration-integration.test.ts. Covers:
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
} from "@domains/workspaces/execution-store.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
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
