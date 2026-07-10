/**
 * reconcile-workspace tests — Phase C: source: "loop" enum widening (loops-phase-c-02)
 *
 * These tests verify:
 * - source: "loop" is accepted and flows through to telemetry (cliff detected result)
 * - source: "resume" regression still passes
 * - fail-open behavior: a workspace with no journal returns WORKSPACE_NOT_FOUND,
 *   never a hard throw
 *
 * BOUNDARY TESTS (loops-phase-c-02 P1 fix):
 * The direct-call tests above bypass the registered Zod schemas. These boundary tests
 * validate the REGISTERED schema surfaces — EventPayloadSchemas.cliff_detected and the
 * reconcile_workspace input schema — accept source: "loop". These are the surfaces that
 * rejected the value in production before the P1 fix.
 *
 * Cliff-transcript capture tests (cliff-transcript-01) live in the sibling file
 * reconcile-workspace-cliff.test.ts — split out 2026-07-06 to keep both files
 * under the 600-line biome noExcessiveLinesPerFile limit.
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { reconcileWorkspaceInputSchema } from "@app/register-journal.ts";
import { EventPayloadSchemas } from "@domains/messages/events.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { evictDriftDbForScope, getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncompleteStep } from "../reconcile-workspace.ts";
import { isDispatchedCliff, reconcileWorkspace } from "../reconcile-workspace.ts";

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

/**
 * BOUNDARY TESTS — loops-phase-c-02 P1 fix
 *
 * These tests validate the REGISTERED schema surfaces (not the direct-call impl).
 * The P1 gap: direct-call tests pass because reconcileWorkspace() accepts "loop" in its
 * TypeScript param, but the Zod schemas in register-journal.ts inputSchema and
 * events.ts EventPayloadSchemas.cliff_detected were NOT widened — so the MCP call was
 * rejected at the Zod boundary before reconcileWorkspace() ran.
 *
 * TDD red→green: These tests fail BEFORE the schema fixes (source: "loop" rejected by
 * the narrow z.enum(["resume","post_subagent"])) and pass AFTER the fixes.
 */
describe("reconcileWorkspace — registered schema boundary (loops-phase-c-02 P1)", () => {
  it('EventPayloadSchemas.cliff_detected accepts source: "loop"', () => {
    const payload = {
      incomplete_step_ids: ["implement"],
      missing_count: 1,
      partial_count: 0,
      needs_recovery: true as const,
      source: "loop" as const,
      timestamp: new Date().toISOString(),
    };
    const result = EventPayloadSchemas.cliff_detected.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("EventPayloadSchemas.cliff_detected rejects unknown source (schema is not too wide)", () => {
    const payload = {
      incomplete_step_ids: [],
      missing_count: 0,
      partial_count: 0,
      needs_recovery: true as const,
      source: "unknown_source",
      timestamp: new Date().toISOString(),
    };
    const result = EventPayloadSchemas.cliff_detected.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('EventPayloadSchemas.cliff_detected still accepts source: "resume" (regression)', () => {
    const payload = {
      incomplete_step_ids: [],
      missing_count: 0,
      partial_count: 0,
      needs_recovery: true as const,
      source: "resume" as const,
      timestamp: new Date().toISOString(),
    };
    const result = EventPayloadSchemas.cliff_detected.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('EventPayloadSchemas.cliff_detected still accepts source: "post_subagent" (regression)', () => {
    const payload = {
      incomplete_step_ids: [],
      missing_count: 0,
      partial_count: 0,
      needs_recovery: true as const,
      source: "post_subagent" as const,
      timestamp: new Date().toISOString(),
    };
    const result = EventPayloadSchemas.cliff_detected.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('reconcileWorkspaceInputSchema accepts source: "loop"', () => {
    const input = {
      workspace: "/tmp/test-workspace",
      source: "loop" as const,
      emit_telemetry: false,
    };
    const result = reconcileWorkspaceInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('reconcileWorkspaceInputSchema still accepts source: "resume" (regression)', () => {
    const result = reconcileWorkspaceInputSchema.safeParse({
      workspace: "/tmp/test-workspace",
      source: "resume",
    });
    expect(result.success).toBe(true);
  });

  it('reconcileWorkspaceInputSchema still accepts source: "post_subagent" (regression)', () => {
    const result = reconcileWorkspaceInputSchema.safeParse({
      workspace: "/tmp/test-workspace",
      source: "post_subagent",
    });
    expect(result.success).toBe(true);
  });

  it('reconcileWorkspaceInputSchema rejects source: "unknown" (schema is not too wide)', () => {
    const result = reconcileWorkspaceInputSchema.safeParse({
      workspace: "/tmp/test-workspace",
      source: "unknown",
    });
    expect(result.success).toBe(false);
  });
});

/**
 * Narrow cliff telemetry to dispatched steps only (watch_GGGGGG1).
 *
 * A `planned` step created upfront by `batch_log_steps` (e.g. the scribe's
 * `context-sync` tail step) never gets a `started_at` until it's actually
 * dispatched. Today the whole `incompleteSteps` array — planned steps
 * included — is fed to both telemetry writes, producing a false
 * `cliff_detected` event + drift.db row for work that was simply not
 * started yet. `isDispatchedCliff` narrows the TELEMETRY input only; the
 * tool's `incomplete_steps`/`needs_recovery` return value (consumed by
 * resume) stays unfiltered — see DESIGN.md D1/OQ#2.
 */
/** Typed test fixture factory — fills every required IncompleteStep field so
 * call sites only need to override the fields under test (no `as unknown` escapes). */
function makeIncompleteStep(overrides: Partial<IncompleteStep> = {}): IncompleteStep {
  return {
    agent_type: "engineer",
    missing_artifacts: [],
    partial_artifacts: [],
    status: "planned",
    step_id: "context-sync",
    ...overrides,
  };
}

describe("reconcileWorkspace — telemetry narrowed to dispatched steps (fix-cliff-telemetry-01)", () => {
  describe("isDispatchedCliff — pure predicate", () => {
    it("false for a step with no started_at (never dispatched)", () => {
      const step = makeIncompleteStep({ status: "planned" });
      expect(isDispatchedCliff(step)).toBe(false);
    });

    it("true for a step with a non-empty started_at (dispatched)", () => {
      const step = makeIncompleteStep({
        started_at: new Date().toISOString(),
        status: "started",
        step_id: "implement",
      });
      expect(isDispatchedCliff(step)).toBe(true);
    });
  });

  let workspace: string;
  let projectDir: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-reconcile-telemetry-"));
    projectDir = await mkdtemp(join(tmpdir(), "canon-reconcile-telemetry-drift-"));
  });

  afterEach(async () => {
    evictDriftDbForScope(projectDir);
    await rm(workspace, { force: true, recursive: true });
    await rm(projectDir, { force: true, recursive: true });
  });

  function writePlannedContextSyncJournal(workspacePath: string): void {
    const journal = {
      steps: [
        {
          agent_type: "scribe",
          artifacts_expected: ["plans/slug/CONTEXT-SYNC.md"],
          status: "planned",
          step_id: "context-sync",
        },
      ],
      version: 1,
    };
    writeFileSync(join(workspacePath, "journal.json"), JSON.stringify(journal, null, 2));
  }

  function writeStartedImplementJournal(workspacePath: string): void {
    const journal = {
      steps: [
        {
          agent_type: "engineer",
          artifacts_expected: ["plans/slug/SUMMARY.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "implement",
        },
      ],
      version: 1,
    };
    writeFileSync(join(workspacePath, "journal.json"), JSON.stringify(journal, null, 2));
  }

  function writeMixedJournal(workspacePath: string): void {
    const journal = {
      steps: [
        {
          agent_type: "engineer",
          artifacts_expected: ["plans/slug/SUMMARY.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "implement",
        },
        {
          agent_type: "scribe",
          artifacts_expected: ["plans/slug/CONTEXT-SYNC.md"],
          status: "planned",
          step_id: "context-sync",
        },
      ],
      version: 1,
    };
    writeFileSync(join(workspacePath, "journal.json"), JSON.stringify(journal, null, 2));
  }

  it("AC#2 — planned-never-dispatched step emits NO cliff_detected event and NO drift.db row", async () => {
    getExecutionStore(workspace);
    writePlannedContextSyncJournal(workspace);

    const result = await reconcileWorkspace({ workspace, emit_telemetry: true, projectDir });

    expect(result.ok).toBe(true);
    const events = getExecutionStore(workspace).getEventsByType("cliff_detected");
    expect(events).toHaveLength(0);
    const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
    expect(rows.find((r) => r.step_id === "context-sync")).toBeUndefined();
  });

  it("dc-03/OQ#2 — planned-never-dispatched step is still returned as pending work (telemetry suppressed, recovery preserved)", async () => {
    getExecutionStore(workspace);
    writePlannedContextSyncJournal(workspace);

    const result = await reconcileWorkspace({ workspace, emit_telemetry: true, projectDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(true);
    expect(result.incomplete_steps.map((s) => s.step_id)).toContain("context-sync");
  });

  it("AC#3 — dispatched-then-silent step still emits both the event and the drift.db row", async () => {
    getExecutionStore(workspace);
    writeStartedImplementJournal(workspace);

    const result = await reconcileWorkspace({ workspace, emit_telemetry: true, projectDir });

    expect(result.ok).toBe(true);
    const events = getExecutionStore(workspace).getEventsByType("cliff_detected");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { incomplete_step_ids: string[] };
    expect(payload.incomplete_step_ids).toEqual(["implement"]);
    const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
    expect(rows.find((r) => r.step_id === "implement")).toBeDefined();
  });

  it("mixed — one planned + one started: incomplete_steps has both, telemetry has only the started step", async () => {
    getExecutionStore(workspace);
    writeMixedJournal(workspace);

    const result = await reconcileWorkspace({ workspace, emit_telemetry: true, projectDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incomplete_steps.map((s) => s.step_id).sort()).toEqual([
      "context-sync",
      "implement",
    ]);

    const events = getExecutionStore(workspace).getEventsByType("cliff_detected");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { incomplete_step_ids: string[] };
    expect(payload.incomplete_step_ids).toEqual(["implement"]);

    const rows = getDriftDb(projectDir).getCliffEvents().getByWorkspace(basename(workspace));
    expect(rows.map((r) => r.step_id)).toEqual(["implement"]);
  });
});
