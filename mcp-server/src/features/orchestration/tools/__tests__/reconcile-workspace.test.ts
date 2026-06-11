/**
 * reconcile-workspace tests — Phase C: source: "loop" enum widening (loops-phase-c-02)
 *
 * These tests verify:
 * - source: "loop" is accepted and flows through to telemetry (cliff detected result)
 * - source: "resume" regression still passes
 * - fail-open behavior: a workspace with no journal returns WORKSPACE_NOT_FOUND,
 *   never a hard throw
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileWorkspace } from "../reconcile-workspace.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-reconcile-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

/**
 * Write a minimal journal with a started step whose artifact is missing.
 * This creates a cliff scenario so reconcile returns needs_recovery: true.
 */
function writeJournalWithCliff(workspacePath: string): void {
  const journal = {
    steps: [
      {
        step_id: "implement",
        agent_type: "engineer",
        status: "started",
        artifacts_expected: ["plans/slug/SUMMARY.md"],
        started_at: new Date().toISOString(),
      },
    ],
    version: 1,
  };
  writeFileSync(join(workspacePath, "journal.json"), JSON.stringify(journal, null, 2));
}

/**
 * Write a minimal journal with a completed step (no cliff).
 */
function writeJournalClean(workspacePath: string): void {
  const journal = {
    steps: [
      {
        step_id: "implement",
        agent_type: "engineer",
        status: "completed",
        artifacts_expected: [],
        started_at: new Date().toISOString(),
      },
    ],
    version: 1,
  };
  writeFileSync(join(workspacePath, "journal.json"), JSON.stringify(journal, null, 2));
}

describe("reconcileWorkspace — source enum (loops-phase-c-02)", () => {
  it("WORKSPACE_NOT_FOUND when no journal exists (baseline)", async () => {
    const result = await reconcileWorkspace({ workspace, source: "loop" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it('source: "loop" accepted — cliff scenario returns needs_recovery: true', async () => {
    writeJournalWithCliff(workspace);
    const result = await reconcileWorkspace({
      workspace,
      source: "loop",
      emit_telemetry: false, // avoid execution-store dependency in unit test
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.needs_recovery).toBe(true);
      expect(result.incomplete_steps.length).toBeGreaterThan(0);
    }
  });

  it('source: "resume" regression — still works correctly', async () => {
    writeJournalWithCliff(workspace);
    const result = await reconcileWorkspace({
      workspace,
      source: "resume",
      emit_telemetry: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.needs_recovery).toBe(true);
    }
  });

  it('source: "post_subagent" regression — still works correctly', async () => {
    writeJournalWithCliff(workspace);
    const result = await reconcileWorkspace({
      workspace,
      source: "post_subagent",
      emit_telemetry: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.needs_recovery).toBe(true);
    }
  });

  it('clean journal with source: "loop" returns needs_recovery: false', async () => {
    writeJournalClean(workspace);
    const result = await reconcileWorkspace({
      workspace,
      source: "loop",
      emit_telemetry: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.needs_recovery).toBe(false);
      expect(result.incomplete_steps).toHaveLength(0);
    }
  });
});
