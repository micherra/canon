/**
 * Tests for get-history.ts
 *
 * Covers:
 * - Returns empty flow_runs and total_decisions: 0 when drift.db is empty
 * - Returns flow runs sorted by completed desc
 * - Respects limit parameter
 * - Filters by flow name when specified
 * - Enriches flow runs with associated decisions
 * - Handles flow runs with no commits/diff_stat (backward compat)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionEntry, FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { getHistory } from "../tools/get-history.ts";

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "get-history-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeFlowRun(overrides: Partial<FlowRunEntry> = {}): FlowRunEntry {
  return {
    completed: "2026-01-15T12:00:00.000Z",
    flow: "feature",
    run_id: `run-${Math.random().toString(36).slice(2)}`,
    skipped_states: [],
    started: "2026-01-15T11:00:00.000Z",
    state_durations: { build: 60000 },
    state_iterations: { build: 1 },
    task: "Add dark mode",
    tier: "medium",
    total_duration_ms: 3600000,
    total_spawns: 3,
    ...overrides,
  };
}

function makeDecision(runId: string, overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    content: "Chose this approach for performance reasons",
    decision_id: `dec-${Math.random().toString(36).slice(2)}`,
    run_id: runId,
    timestamp: "2026-01-15T11:30:00.000Z",
    title: "Use SQLite for persistence",
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// Empty DB

describe("getHistory — empty database", () => {
  it("returns empty flow_runs and total_decisions: 0 when drift.db is empty", async () => {
    const projectDir = makeTmpProjectDir();

    const result = await getHistory({ limit: 20, project_dir: projectDir });

    assertOk(result);
    expect(result.flow_runs).toEqual([]);
    expect(result.total_decisions).toBe(0);
  });
});

// Sorting

describe("getHistory — sorting", () => {
  it("returns flow runs sorted by completed desc (newest first)", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const run1 = makeFlowRun({
      completed: "2026-01-10T10:00:00.000Z",
      run_id: "run-older",
      started: "2026-01-10T09:00:00.000Z",
    });
    const run2 = makeFlowRun({
      completed: "2026-01-20T10:00:00.000Z",
      run_id: "run-newer",
      started: "2026-01-20T09:00:00.000Z",
    });
    const run3 = makeFlowRun({
      completed: "2026-01-15T10:00:00.000Z",
      run_id: "run-middle",
      started: "2026-01-15T09:00:00.000Z",
    });

    db.appendFlowRun(run1);
    db.appendFlowRun(run2);
    db.appendFlowRun(run3);

    const result = await getHistory({ limit: 20, project_dir: projectDir });

    assertOk(result);
    expect(result.flow_runs).toHaveLength(3);
    expect(result.flow_runs[0].run_id).toBe("run-newer");
    expect(result.flow_runs[1].run_id).toBe("run-middle");
    expect(result.flow_runs[2].run_id).toBe("run-older");
  });
});

// Limit

describe("getHistory — limit parameter", () => {
  it("respects limit parameter and returns at most N runs", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    for (let i = 0; i < 5; i++) {
      db.appendFlowRun(
        makeFlowRun({
          completed: `2026-01-${String(i + 10).padStart(2, "0")}T10:00:00.000Z`,
          run_id: `run-${i}`,
          started: `2026-01-${String(i + 10).padStart(2, "0")}T09:00:00.000Z`,
        }),
      );
    }

    const result = await getHistory({ limit: 3, project_dir: projectDir });

    assertOk(result);
    expect(result.flow_runs).toHaveLength(3);
  });

  it("uses default limit of 20 when not specified", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    for (let i = 0; i < 25; i++) {
      db.appendFlowRun(
        makeFlowRun({
          completed: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
          run_id: `run-${i}`,
          started: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
        }),
      );
    }

    const result = await getHistory({ project_dir: projectDir });

    assertOk(result);
    expect(result.flow_runs).toHaveLength(20);
  });
});

// Flow filter

describe("getHistory — flow filter", () => {
  it("filters by flow name when specified", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    db.appendFlowRun(makeFlowRun({ flow: "feature", run_id: "run-feature-1" }));
    db.appendFlowRun(makeFlowRun({ flow: "fast-path", run_id: "run-fast-path-1" }));
    db.appendFlowRun(makeFlowRun({ flow: "feature", run_id: "run-feature-2" }));

    const result = await getHistory({ flow: "feature", limit: 20, project_dir: projectDir });

    assertOk(result);
    expect(result.flow_runs).toHaveLength(2);
    expect(result.flow_runs.every((r) => r.flow === "feature")).toBe(true);
  });

  it("returns empty array when no runs match the flow filter", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    db.appendFlowRun(makeFlowRun({ flow: "feature", run_id: "run-feature-1" }));

    const result = await getHistory({ flow: "nonexistent", limit: 20, project_dir: projectDir });

    assertOk(result);
    expect(result.flow_runs).toHaveLength(0);
  });
});

// Decision enrichment

describe("getHistory — decision enrichment", () => {
  it("enriches flow runs with associated decisions", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const run = makeFlowRun({ run_id: "run-with-decisions" });
    db.appendFlowRun(run);

    const dec1 = makeDecision("run-with-decisions", { title: "Decision A" });
    const dec2 = makeDecision("run-with-decisions", { title: "Decision B" });
    db.appendDecision(dec1);
    db.appendDecision(dec2);

    const result = await getHistory({ limit: 20, project_dir: projectDir });

    assertOk(result);
    expect(result.flow_runs).toHaveLength(1);
    const enriched = result.flow_runs[0];
    expect(enriched.decisions).toHaveLength(2);
    expect(enriched.decisions.map((d) => d.title)).toContain("Decision A");
    expect(enriched.decisions.map((d) => d.title)).toContain("Decision B");
  });

  it("returns empty decisions array for runs with no decisions", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    db.appendFlowRun(makeFlowRun({ run_id: "run-no-decisions" }));

    const result = await getHistory({ limit: 20, project_dir: projectDir });

    assertOk(result);
    expect(result.flow_runs[0].decisions).toEqual([]);
  });

  it("counts total decisions across all runs in the database", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    const run1 = makeFlowRun({ run_id: "run-1" });
    const run2 = makeFlowRun({ run_id: "run-2" });
    db.appendFlowRun(run1);
    db.appendFlowRun(run2);

    db.appendDecision(makeDecision("run-1", { title: "D1" }));
    db.appendDecision(makeDecision("run-1", { title: "D2" }));
    db.appendDecision(makeDecision("run-2", { title: "D3" }));

    const result = await getHistory({ limit: 20, project_dir: projectDir });

    assertOk(result);
    expect(result.total_decisions).toBe(3);
  });
});

// Backward compatibility — runs with no optional fields

describe("getHistory — backward compatibility", () => {
  it("handles flow runs with no gate_pass_rate or total_files_changed (pre-v2 data)", async () => {
    const projectDir = makeTmpProjectDir();
    const db = getDriftDb(projectDir);

    // Minimal run — no optional quality signals
    const minimalRun: FlowRunEntry = {
      completed: "2026-01-15T12:00:00.000Z",
      flow: "fast-path",
      run_id: "run-minimal",
      skipped_states: [],
      started: "2026-01-15T11:00:00.000Z",
      state_durations: {},
      state_iterations: {},
      task: "Fix typo",
      tier: "small",
      total_duration_ms: 600000,
      total_spawns: 1,
    };

    db.appendFlowRun(minimalRun);

    const result = await getHistory({ limit: 20, project_dir: projectDir });

    assertOk(result);
    expect(result.flow_runs).toHaveLength(1);
    const run = result.flow_runs[0];
    expect(run.run_id).toBe("run-minimal");
    expect(run.gate_pass_rate).toBeUndefined();
    expect(run.total_files_changed).toBeUndefined();
    expect(run.decisions).toEqual([]);
  });
});
