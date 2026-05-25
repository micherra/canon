/**
 * orchestration-journal — trust-boundary hardening tests.
 *
 * Covers the two trust-boundary fixes added to readJournal:
 *  1. JSON.parse is wrapped in try/catch — syntactically invalid journal.json
 *     returns the safe empty-journal default instead of throwing.
 *  2. Steps array elements are filtered to well-formed objects — corrupted
 *     entries (null, missing fields) are dropped silently rather than
 *     propagating to finalizeWorkspace/scanArtifacts where they would throw.
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock git-adapter before importing modules that use it
vi.mock("@platform/adapters/git-adapter.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@platform/adapters/git-adapter.ts")>();
  return {
    ...original,
    gitExec: vi.fn(),
  };
});

import { finalizeWorkspace, logStep } from "../orchestration-journal.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-journal-tb-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

/** Write raw bytes to journal.json, bypassing the normal write path. */
function writeRawJournal(ws: string, content: string): void {
  writeFileSync(join(ws, "journal.json"), content, "utf-8");
}

describe("readJournal — invalid JSON (trust-boundary fix 1)", () => {
  test("logStep normalises to empty journal when journal.json contains truncated JSON", async () => {
    // Write truncated JSON — syntactically invalid
    writeRawJournal(workspace, '{"steps":[{"step_id":"s1"');

    // logStep should not throw; it should treat journal as empty and create a fresh step
    const result = await logStep({
      status: "planned",
      step_id: "new-step",
      workspace,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step_id).toBe("new-step");
    }
  });

  test("logStep normalises to empty journal when journal.json contains non-JSON text", async () => {
    writeRawJournal(workspace, "this is not json at all");

    const result = await logStep({
      status: "planned",
      step_id: "step-after-corrupt",
      workspace,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step_id).toBe("step-after-corrupt");
    }
  });

  test("finalizeWorkspace normalises to empty journal when journal.json is syntactically invalid", async () => {
    // finalizeWorkspace requires the journal.json to exist (it checks for the file before reading)
    writeRawJournal(workspace, "{{{{ broken json");

    // finalizeWorkspace will return WORKSPACE_NOT_FOUND because our safe-default produces
    // steps:[] which means all steps would be missing — but it should NOT throw.
    // The key assertion is that it handles the corrupt file gracefully.
    const result = await finalizeWorkspace({ workspace });

    // Should not throw — either ok or a tool error, never an uncaught exception
    expect(result).toBeDefined();
    // With an empty-journal fallback, there are no completed steps and no missing artifacts —
    // complete:true if there are also no missing/skipped steps.
    if (result.ok) {
      expect(Array.isArray(result.steps_missing)).toBe(true);
    }
  });
});

describe("readJournal — corrupted step elements (trust-boundary fix 2)", () => {
  test("logStep silently drops null step entries, retains well-formed ones", async () => {
    // Write a journal with a mix of null entries and a valid step
    const corrupt = JSON.stringify({
      steps: [
        null,
        { agent_type: null, artifacts_expected: [], status: "planned", step_id: "real-step" },
        null,
      ],
      version: 1,
      workspace,
    });
    writeRawJournal(workspace, corrupt);

    // Adding a new step should work — real-step is retained, nulls dropped
    const result = await logStep({
      status: "planned",
      step_id: "another-step",
      workspace,
    });

    expect(result.ok).toBe(true);
  });

  test("logStep silently drops step entries missing required fields", async () => {
    // Steps without step_id or status are invalid
    const corrupt = JSON.stringify({
      steps: [
        { status: "planned" }, // missing step_id
        { agent_type: null, artifacts_expected: [], status: "planned", step_id: "valid-step" },
        { step_id: "no-status" }, // missing status
      ],
      version: 1,
      workspace,
    });
    writeRawJournal(workspace, corrupt);

    const result = await logStep({
      status: "started",
      step_id: "valid-step",
      workspace,
    });

    expect(result.ok).toBe(true);
    // Should have updated valid-step to started
    if (result.ok) {
      expect(result.step_id).toBe("valid-step");
      expect(result.status).toBe("started");
    }
  });

  test("logStep normalises steps:[] when steps field is not an array", async () => {
    const corrupt = JSON.stringify({
      steps: "not-an-array",
      version: 1,
      workspace,
    });
    writeRawJournal(workspace, corrupt);

    const result = await logStep({
      status: "planned",
      step_id: "fresh-step",
      workspace,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step_id).toBe("fresh-step");
    }
  });
});
