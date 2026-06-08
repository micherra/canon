/**
 * Tests for reconcileWorkspace — drift.db write-through (cliff-02).
 *
 * Covers: dual-write to drift.db on cliff detection, upsert dedup, payload
 * enrichment (steps[]), fail-open on bad projectDir, no-write when projectDir
 * absent, no-write when needs_recovery is false.
 *
 * Extracted from reconcile-workspace.test.ts to keep both files under the
 * 600-line Biome limit.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { evictDriftDbForScope, getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Journal } from "../tools/orchestration-journal.ts";
import { reconcileWorkspace } from "../tools/reconcile-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-drift-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Initialize an execution store so getExecutionStore(workspace) resolves. */
function setupStore(workspace: string): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: "implement",
    entry: "implement",
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    evictDriftDbForScope(dir);
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

function writeJournal(workspace: string, journal: Journal): void {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf-8");
}

function cliffJournal(workspace: string): Journal {
  return {
    steps: [
      {
        agent_type: "engineer",
        artifacts_expected: ["plans/slug/SUMMARY.md"],
        started_at: new Date().toISOString(),
        status: "started",
        step_id: "implement",
      },
      {
        agent_type: "reviewer",
        artifacts_expected: ["reviews/REVIEW.md"],
        started_at: new Date().toISOString(),
        status: "started",
        step_id: "review",
      },
    ],
    version: 1,
    workspace,
  };
}

describe("reconcileWorkspace — drift.db write-through (cliff-02)", () => {
  it("happy path: cliff with emit_telemetry + projectDir writes one row per step to drift.db", async () => {
    const workspace = makeTmpDir();
    const projectDir = makeTmpDir();
    setupStore(workspace);
    writeJournal(workspace, cliffJournal(workspace));

    const result = await reconcileWorkspace({
      workspace,
      emit_telemetry: true,
      projectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(true);

    const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
    expect(rows).toHaveLength(2);
    const implementRow = rows.find((r) => r.step_id === "implement");
    const reviewRow = rows.find((r) => r.step_id === "review");
    expect(implementRow).toBeDefined();
    expect(reviewRow).toBeDefined();
    expect(implementRow?.agent_type).toBe("engineer");
    expect(reviewRow?.agent_type).toBe("reviewer");
    expect(implementRow?.source).toBe("resume");
    expect(implementRow?.workspace_slug).toBe(basename(workspace));
    expect(implementRow?.missing_count).toBe(1);
    expect(implementRow?.partial_count).toBe(0);
  });

  it("repeated reconcile on same cliff results in same row count (upsert dedup)", async () => {
    const workspace = makeTmpDir();
    const projectDir = makeTmpDir();
    setupStore(workspace);
    writeJournal(workspace, cliffJournal(workspace));

    await reconcileWorkspace({ workspace, emit_telemetry: true, projectDir });
    await reconcileWorkspace({ workspace, emit_telemetry: true, projectDir });

    const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
    // 2 steps in the journal, not 4 rows — upsert dedup works
    expect(rows).toHaveLength(2);
  });

  it("payload enrichment: orchestration.db event payload contains steps[] with per-step fields", async () => {
    const workspace = makeTmpDir();
    setupStore(workspace);
    writeJournal(workspace, cliffJournal(workspace));

    await reconcileWorkspace({ workspace, emit_telemetry: true });

    const events = getExecutionStore(workspace).getEventsByType("cliff_detected");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as {
      steps: Array<{
        step_id: string;
        agent_type: string | null;
        missing_count: number;
        partial_count: number;
      }>;
    };
    expect(Array.isArray(payload.steps)).toBe(true);
    expect(payload.steps).toHaveLength(2);
    const implementStep = payload.steps.find((s) => s.step_id === "implement");
    expect(implementStep).toBeDefined();
    expect(implementStep?.agent_type).toBe("engineer");
    expect(implementStep?.missing_count).toBe(1);
    expect(implementStep?.partial_count).toBe(0);
  });

  it("fail-open: invalid/unwritable projectDir still returns normal result (no throw)", async () => {
    const workspace = makeTmpDir();
    setupStore(workspace);
    writeJournal(workspace, cliffJournal(workspace));

    // Use a non-existent path that will fail mkdirSync permissions check
    const badProjectDir = "/nonexistent/cannot/write/here/xyzzy12345";

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await reconcileWorkspace({
      workspace,
      emit_telemetry: true,
      projectDir: badProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(true);
    expect(result.incomplete_steps).toHaveLength(2);
    // Should have warned about the drift.db write failure
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it("no projectDir → no drift.db write, orchestration.db event log still written", async () => {
    const workspace = makeTmpDir();
    setupStore(workspace);
    writeJournal(workspace, cliffJournal(workspace));

    // No projectDir — no drift.db write, but orchestration.db still gets event
    const result = await reconcileWorkspace({ workspace, emit_telemetry: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(true);
    // orchestration.db still has the event
    const events = getExecutionStore(workspace).getEventsByType("cliff_detected");
    expect(events).toHaveLength(1);
  });

  it("no cliff (needs_recovery false) → no drift.db write, zero rows in drift.db", async () => {
    const workspace = makeTmpDir();
    const projectDir = makeTmpDir();
    setupStore(workspace);
    // Write artifacts so no cliff is detected
    mkdirSync(join(workspace, "plans", "slug"), { recursive: true });
    mkdirSync(join(workspace, "reviews"), { recursive: true });
    writeFileSync(join(workspace, "plans", "slug", "SUMMARY.md"), "done", "utf-8");
    writeFileSync(join(workspace, "reviews", "REVIEW.md"), "---\nverdict: CLEAN\n---\n", "utf-8");
    writeJournal(workspace, cliffJournal(workspace));

    const result = await reconcileWorkspace({ workspace, emit_telemetry: true, projectDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(false);
    const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
    expect(rows).toHaveLength(0);
  });
});
