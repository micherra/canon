/**
 * decision-persistence.test.ts
 *
 * Tests for tryPersistDecisionsBeforeReap — the fail-open mirror of a
 * workspace's decision events into the durable drift.db `orchestrator_decisions`
 * table, called by the janitor immediately before `rmSync` (ADR-0038).
 *
 * Test plan (T-01-PLAN.md, drift-db-leak-guard convention: isolated mkdtemp
 * projectDir/workspace, never process.cwd()):
 * - end-to-end reap-survival: decisions persisted before rmSync are readable
 *   from drift.db AFTER the workspace directory is gone
 * - a throwing persist does not block deletion (fail-open)
 * - a workspace with zero decisions is a no-op (no persisted rows)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { DriftDb } from "@platform/storage/drift/drift-db.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import type { OrchestratorDecisionsDao } from "@platform/storage/drift/orchestrator-decisions-dao.ts";
import { CANON_FILES } from "@shared/constants.ts";
import { afterEach, describe, expect, it } from "vitest";
import { tryPersistDecisionsBeforeReap } from "../decision-persistence.ts";

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

/** Write real orchestrator_decision events into a workspace's orchestration.db. */
function seedWorkspaceDecisions(
  workspaceDir: string,
  decisions: Array<{ decision_type: string; summary: string; gate?: string }>,
): void {
  const store = getExecutionStore(workspaceDir);
  for (const d of decisions) {
    store.appendEvent("orchestrator_decision", { ...d, timestamp: new Date().toISOString() });
  }
}

describe("tryPersistDecisionsBeforeReap — reap survival", () => {
  it("persists decisions readable from drift.db after the workspace dir is deleted", () => {
    const workspaceDir = makeTmpDir("decision-persistence-workspace-");
    seedWorkspaceDecisions(workspaceDir, [
      { decision_type: "hitl_gate", gate: "plan_approval", summary: "Approved the plan" },
      { decision_type: "scope_cut", summary: "Cut the reader tool from this wave" },
    ]);

    const orchestrationDbPath = join(workspaceDir, CANON_FILES.ORCHESTRATION_DB);
    const drift = new DriftDb(initDriftDb(":memory:"));

    tryPersistDecisionsBeforeReap(orchestrationDbPath, "test-slug", drift);

    // Simulate the janitor's rmSync — the workspace dir (and orchestration.db) is gone.
    rmSync(workspaceDir, { force: true, recursive: true });

    const persisted = drift.getOrchestratorDecisions().getBySlug("test-slug");
    expect(persisted).toHaveLength(2);
    expect(persisted.map((p) => p.summary)).toContain("Approved the plan");
    expect(persisted.find((p) => p.gate === "plan_approval")).toBeDefined();

    drift.close();
  });

  it("is a no-op for a workspace with zero decisions", () => {
    const workspaceDir = makeTmpDir("decision-persistence-empty-");
    // Touch the store so orchestration.db exists, but log no decisions.
    getExecutionStore(workspaceDir);

    const orchestrationDbPath = join(workspaceDir, CANON_FILES.ORCHESTRATION_DB);
    const drift = new DriftDb(initDriftDb(":memory:"));

    tryPersistDecisionsBeforeReap(orchestrationDbPath, "empty-slug", drift);

    expect(drift.getOrchestratorDecisions().getBySlug("empty-slug")).toEqual([]);
    drift.close();
  });
});

describe("tryPersistDecisionsBeforeReap — fail-open", () => {
  it("does not throw when the DAO persist call throws", () => {
    const workspaceDir = makeTmpDir("decision-persistence-throwing-");
    seedWorkspaceDecisions(workspaceDir, [{ decision_type: "other", summary: "will not persist" }]);

    const orchestrationDbPath = join(workspaceDir, CANON_FILES.ORCHESTRATION_DB);
    const drift = new DriftDb(initDriftDb(":memory:"));
    // Monkey-patch getOrchestratorDecisions to return a DAO whose persistMany throws.
    drift.getOrchestratorDecisions = () =>
      ({
        persistMany: () => {
          throw new Error("simulated DAO failure");
        },
      }) as unknown as OrchestratorDecisionsDao;

    expect(() =>
      tryPersistDecisionsBeforeReap(orchestrationDbPath, "throwing-slug", drift),
    ).not.toThrow();

    drift.close();
  });

  it("does not throw when the orchestration.db path does not exist", () => {
    const drift = new DriftDb(initDriftDb(":memory:"));
    expect(() =>
      tryPersistDecisionsBeforeReap("/nonexistent/path/orchestration.db", "missing-slug", drift),
    ).not.toThrow();
    expect(drift.getOrchestratorDecisions().getBySlug("missing-slug")).toEqual([]);
    drift.close();
  });
});
