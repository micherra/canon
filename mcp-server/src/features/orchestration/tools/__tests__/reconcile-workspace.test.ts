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
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileWorkspaceInputSchema } from "@app/register-journal.ts";
import { EventPayloadSchemas } from "@domains/messages/events.ts";
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
