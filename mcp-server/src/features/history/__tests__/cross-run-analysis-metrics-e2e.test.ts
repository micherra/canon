/**
 * cross-run-analysis-metrics-e2e.test.ts
 *
 * End-to-end integration test for AC#5: metrics recorded via record_agent_metrics
 * must reach get_cross_run_analysis's agent_performance_trends.
 *
 * Drives the real pipeline, no mocks: recordAgentMetrics -> archiveWorkspace
 * (buildRunSummary joins execution_states.metrics onto step_outcomes) ->
 * getCrossRunAnalysis (computePerformanceTrends aggregates the joined counters).
 *
 * Uses an isolated mkdtemp projectDir — never process.cwd() — per
 * drift-db-leak-guard (see mcp-server/.claude/CLAUDE.md Conventions).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveWorkspace } from "@platform/storage/archive/archive-service.ts";
import { evictDriftDbForScope } from "@platform/storage/drift/drift-db-cache.ts";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearStoreCache,
  getExecutionStore,
} from "../../../domains/workspaces/execution-store-cache.ts";
import { recordAgentMetrics } from "../../diagnostics/tools/record-agent-metrics.ts";
import { getCrossRunAnalysis } from "../tools/get-cross-run-analysis.ts";

// ---- helpers ----

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJournal(workspace: string, steps: Record<string, unknown>[]): void {
  writeFileSync(join(workspace, "journal.json"), JSON.stringify({ steps }, null, 2), "utf-8");
}

/**
 * archiveWorkspace's extractWorkspaceMetadata reads flow_name from the
 * `execution` row (id=1) via a fresh readonly connection — so record_agent_metrics
 * (which requires store.getExecution() !== null) and a real flow name in the
 * archived run-summary both depend on this row existing.
 */
function seedExecutionRow(workspace: string, flowName: string): void {
  const store = getExecutionStore(workspace);
  store.initExecution({
    base_commit: "abc123",
    branch: "main",
    created: "2026-07-07T00:00:00.000Z",
    current_state: "implement",
    entry: "implement",
    flow: flowName,
    flow_name: flowName,
    last_updated: "2026-07-07T00:00:00.000Z",
    sanitized: "main",
    slug: "test-slug",
    started: "2026-07-07T00:00:00.000Z",
    task: "test task",
    tier: "small",
  });
}

afterEach(() => {
  clearStoreCache();
});

describe("record_agent_metrics -> archive -> get_cross_run_analysis (dc-05)", () => {
  test("recorded counters reach agent_performance_trends after archiving", async () => {
    const projectDir = makeTmpDir("cross-run-metrics-e2e-proj-");
    const workspacePath = makeTmpDir("cross-run-metrics-e2e-ws-");

    try {
      writeJournal(workspacePath, [
        {
          step_id: "implement",
          agent_type: "engineer",
          status: "completed",
          started_at: "2026-07-07T00:00:00.000Z",
          completed_at: "2026-07-07T00:10:00.000Z",
          artifacts_expected: [],
        },
      ]);
      seedExecutionRow(workspacePath, "metrics-e2e-flow");

      // Drive the real record_agent_metrics tool — auto-creates the state row.
      const recordResult = await recordAgentMetrics({
        workspace: workspacePath,
        state_id: "implement",
        tool_calls: 8,
        turns: 4,
        orientation_calls: 2,
      });
      expect(recordResult.ok).toBe(true);

      // Drive the real archive path — buildRunSummary joins the recorded metrics
      // onto step_outcomes[] by step_id (Step A of this task).
      const archiveResult = await archiveWorkspace({
        branch: "main",
        projectDir,
        slug: "metrics-e2e-slug",
        workspacePath,
      });
      expect(archiveResult.archived).toBe(true);
      expect(archiveResult.run_summary_generated).toBe(true);

      // Drive the real learner-facing read path.
      const analysis = await getCrossRunAnalysis({ project_dir: projectDir });
      expect(analysis.ok).toBe(true);
      if (!analysis.ok) return;

      expect(analysis.agent_performance_trends).toHaveLength(1);
      const trend = analysis.agent_performance_trends[0];
      expect(trend.avg_tool_calls).toBe(8);
      expect(trend.avg_turns).toBe(4);
      expect(trend.avg_orientation_calls).toBe(2);
    } finally {
      evictDriftDbForScope(projectDir);
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("a run archived with no recorded metrics omits avg_* fields entirely", async () => {
    const projectDir = makeTmpDir("cross-run-metrics-e2e-proj2-");
    const workspacePath = makeTmpDir("cross-run-metrics-e2e-ws2-");

    try {
      writeJournal(workspacePath, [
        {
          step_id: "implement",
          agent_type: "engineer",
          status: "completed",
          started_at: "2026-07-07T00:00:00.000Z",
          completed_at: "2026-07-07T00:10:00.000Z",
          artifacts_expected: [],
        },
      ]);
      // Touch the store so orchestration.db exists, but record no metrics.
      seedExecutionRow(workspacePath, "no-metrics-flow");

      const archiveResult = await archiveWorkspace({
        branch: "main",
        projectDir,
        slug: "no-metrics-slug",
        workspacePath,
      });
      expect(archiveResult.archived).toBe(true);

      const analysis = await getCrossRunAnalysis({ project_dir: projectDir });
      expect(analysis.ok).toBe(true);
      if (!analysis.ok) return;

      expect(analysis.agent_performance_trends).toHaveLength(1);
      const trend = analysis.agent_performance_trends[0];
      expect(trend.avg_tool_calls).toBeUndefined();
      expect(trend.avg_turns).toBeUndefined();
      expect(trend.avg_orientation_calls).toBeUndefined();
    } finally {
      evictDriftDbForScope(projectDir);
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
