/**
 * Tests for skip_reason validation and clearing behavior in orchestration-journal.
 *
 * Fix 1: logStep must reject a skipped step with no skip_reason (or empty skip_reason).
 * Fix 5: logStep must clear skip_reason when a step transitions to a non-skipped terminal state.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertOk, isToolError } from "../../../../shared/lib/tool-result.ts";
import type { Journal } from "../orchestration-journal.ts";
import { batchLogSteps, logStep } from "../orchestration-journal.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-skip-reason-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

async function readJournalFile(ws: string): Promise<Journal> {
  const raw = await readFile(join(ws, "journal.json"), "utf-8");
  return JSON.parse(raw) as Journal;
}

describe("logStep — skip_reason validation (Fix 1)", () => {
  test("skipped step without skip_reason is rejected with INVALID_INPUT", async () => {
    const result = await logStep({
      status: "skipped",
      step_id: "learn",
      workspace,

      projectDir: process.cwd(),
    });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("skip_reason");
    }
  });

  test("skipped step with empty skip_reason string is rejected with INVALID_INPUT", async () => {
    const result = await logStep({
      skip_reason: "",
      status: "skipped",
      step_id: "context-sync",
      workspace,

      projectDir: process.cwd(),
    });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("skip_reason");
    }
  });

  test("skipped step with a non-empty skip_reason succeeds", async () => {
    const result = await logStep({
      skip_reason: "fix-type build, no contract-level changes",
      status: "skipped",
      step_id: "context-sync",
      workspace,

      projectDir: process.cwd(),
    });
    assertOk(result);
    expect(result.step_id).toBe("context-sync");

    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "context-sync");
    expect(step?.skip_reason).toBe("fix-type build, no contract-level changes");
  });

  test("non-skipped status (planned, started) does not require skip_reason", async () => {
    const planned = await logStep({
      status: "planned",
      step_id: "ship",
      workspace,

      projectDir: process.cwd(),
    });
    assertOk(planned);

    const started = await logStep({
      status: "started",
      step_id: "ship",
      workspace,

      projectDir: process.cwd(),
    });
    assertOk(started);
  });
});

describe("logStep — skip_reason cleared on non-skipped terminal state (Fix 5)", () => {
  test("skip_reason is cleared when step transitions from skipped to completed", async () => {
    // Step 1: plan the step
    await logStep({ projectDir: process.cwd(), status: "planned", step_id: "learn", workspace });

    // Step 2: mark as skipped with a reason
    await logStep({
      skip_reason: "no new patterns observed",
      status: "skipped",
      step_id: "learn",
      workspace,

      projectDir: process.cwd(),
    });

    let journal = await readJournalFile(workspace);
    expect(journal.steps.find((s) => s.step_id === "learn")?.skip_reason).toBe(
      "no new patterns observed",
    );

    // Step 3: the orchestrator later decides to complete the step instead
    // skip_reason must be cleared when completing
    const result = await logStep({
      agent_id: "test-agent-clear",
      status: "completed",
      step_id: "learn",
      workspace,

      projectDir: process.cwd(),
    });
    assertOk(result);

    journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "learn");
    expect(step?.status).toBe("completed");
    expect(step?.skip_reason).toBeUndefined();
  });

  test("skip_reason is preserved when step remains skipped (re-skipped)", async () => {
    const reason = "session timeout";
    await logStep({
      skip_reason: reason,
      status: "skipped",
      step_id: "context-sync",
      workspace,

      projectDir: process.cwd(),
    });

    // Re-log as skipped with same reason — skip_reason should still be there
    await logStep({
      skip_reason: reason,
      status: "skipped",
      step_id: "context-sync",
      workspace,

      projectDir: process.cwd(),
    });

    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "context-sync");
    expect(step?.skip_reason).toBe(reason);
  });
});

describe("batchLogSteps — skip_reason validation (defense-in-depth)", () => {
  test("batch entry with skipped status and no skip_reason is rejected", async () => {
    const result = await batchLogSteps({
      steps: [{ status: "skipped", step_id: "learn" }],
      workspace,

      projectDir: process.cwd(),
    });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("skip_reason");
    }
  });

  test("batch entry with skipped status and empty skip_reason is rejected", async () => {
    const result = await batchLogSteps({
      steps: [{ skip_reason: "   ", status: "skipped", step_id: "context-sync" }],
      workspace,

      projectDir: process.cwd(),
    });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("skip_reason");
    }
  });

  test("entire batch is rejected when one entry has skipped status and no skip_reason", async () => {
    const result = await batchLogSteps({
      steps: [
        { status: "planned", step_id: "implement" },
        { status: "skipped", step_id: "learn" }, // missing skip_reason
      ],
      workspace,

      projectDir: process.cwd(),
    });
    expect(isToolError(result)).toBe(true);
    // The valid step must not have been written either
    const journalPath = `${workspace}/journal.json`;
    const { existsSync } = await import("node:fs");
    expect(existsSync(journalPath)).toBe(false);
  });

  test("batch entry with skipped status and valid skip_reason succeeds", async () => {
    const result = await batchLogSteps({
      steps: [
        {
          skip_reason: "fix-type build, no contract-level changes",
          status: "skipped",
          step_id: "context-sync",
        },
      ],
      workspace,

      projectDir: process.cwd(),
    });
    assertOk(result);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].step_id).toBe("context-sync");

    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "context-sync");
    expect(step?.skip_reason).toBe("fix-type build, no contract-level changes");
  });

  test("batch with non-skipped statuses does not require skip_reason", async () => {
    const result = await batchLogSteps({
      steps: [
        { status: "planned", step_id: "ship" },
        { status: "started", step_id: "implement" },
      ],
      workspace,

      projectDir: process.cwd(),
    });
    assertOk(result);
    expect(result.results).toHaveLength(2);
  });
});
