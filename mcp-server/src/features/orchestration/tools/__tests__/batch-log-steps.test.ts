/** batch-log-steps — unit tests for batchLogSteps (split from orchestration-journal.test.ts). */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertOk, isToolError } from "../../../../shared/lib/tool-result.ts";
import type { Journal } from "../orchestration-journal.ts";
import { batchLogSteps, logStep } from "../orchestration-journal.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-batch-journal-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

async function readJournalFile(ws: string): Promise<Journal> {
  const raw = await readFile(join(ws, "journal.json"), "utf-8");
  return JSON.parse(raw) as Journal;
}

describe("batchLogSteps", () => {
  test("creates 5 planned steps in one call — all appear in journal with correct statuses", async () => {
    const steps = [
      { status: "planned" as const, step_id: "plan" },
      { status: "planned" as const, step_id: "design" },
      { status: "planned" as const, step_id: "implement" },
      { status: "planned" as const, step_id: "test" },
      { status: "planned" as const, step_id: "ship" },
    ];

    const result = await batchLogSteps({ steps, workspace });
    assertOk(result);
    expect(result.results).toHaveLength(5);

    const journal = await readJournalFile(workspace);
    expect(journal.steps).toHaveLength(5);

    const stepIds = journal.steps.map((s) => s.step_id);
    expect(stepIds).toContain("plan");
    expect(stepIds).toContain("design");
    expect(stepIds).toContain("implement");
    expect(stepIds).toContain("test");
    expect(stepIds).toContain("ship");

    for (const step of journal.steps) {
      expect(step.status).toBe("planned");
    }

    for (const r of result.results) {
      expect(r.status).toBe("planned");
      expect(steps.map((s) => s.step_id)).toContain(r.step_id);
    }
  });

  test("empty steps array returns { results: [] } and does not corrupt the journal", async () => {
    await logStep({ status: "planned", step_id: "pre-existing", workspace });

    const result = await batchLogSteps({ steps: [], workspace });
    assertOk(result);
    expect(result.results).toEqual([]);

    const journal = await readJournalFile(workspace);
    expect(journal.steps).toHaveLength(1);
    expect(journal.steps[0]?.step_id).toBe("pre-existing");
  });

  test("validation failure on empty step_id — entire batch fails, no steps written", async () => {
    const result = await batchLogSteps({
      steps: [
        { status: "planned" as const, step_id: "valid-step" },
        { status: "planned" as const, step_id: "" },
        { status: "planned" as const, step_id: "another-valid" },
      ],
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }

    expect(existsSync(join(workspace, "journal.json"))).toBe(false);
  });

  test("batchLogSteps rejects when a completed entry has missing artifacts", async () => {
    const result = await batchLogSteps({
      steps: [
        {
          artifacts_expected: ["plans/DESIGN.md"],
          status: "completed" as const,
          step_id: "design",
        },
      ],
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.recoverable).toBe(true);
      expect(result.message).toContain("plans/DESIGN.md");
      expect(result.context?.artifacts_missing).toEqual(["plans/DESIGN.md"]);
    }

    // Fail-closed: journal must not be written
    expect(existsSync(join(workspace, "journal.json"))).toBe(false);
  });

  test("batchLogSteps allows completion when all artifacts exist", async () => {
    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, "plans", "DESIGN.md"), "# Design\n");

    const result = await batchLogSteps({
      steps: [
        {
          artifacts_expected: ["plans/DESIGN.md"],
          status: "completed" as const,
          step_id: "design",
        },
      ],
      workspace,
    });

    assertOk(result);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("completed");

    const journal = await readJournalFile(workspace);
    expect(journal.steps[0]?.status).toBe("completed");
  });

  test("batchLogSteps allows planned entries with missing artifact paths (no enforcement for non-completed)", async () => {
    // artifacts_expected declared but file does not exist — should not block planned entries
    const result = await batchLogSteps({
      steps: [
        {
          artifacts_expected: ["plans/DESIGN.md"],
          status: "planned" as const,
          step_id: "design",
        },
        {
          artifacts_expected: ["reviews/REVIEW.md"],
          status: "started" as const,
          step_id: "review",
        },
      ],
      workspace,
    });

    assertOk(result);
    expect(result.results).toHaveLength(2);

    const journal = await readJournalFile(workspace);
    expect(journal.steps).toHaveLength(2);
    expect(journal.steps[0]?.status).toBe("planned");
    expect(journal.steps[1]?.status).toBe("started");
  });

  test("batchLogSteps rejects whole batch when one completed entry has missing artifacts (fail-closed)", async () => {
    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, "plans", "DESIGN.md"), "# Design\n");

    // First completed entry has artifact, second does not — entire batch must be rejected
    const result = await batchLogSteps({
      steps: [
        {
          artifacts_expected: ["plans/DESIGN.md"],
          status: "completed" as const,
          step_id: "design",
        },
        {
          artifacts_expected: ["reviews/REVIEW.md"],
          status: "completed" as const,
          step_id: "review",
        },
      ],
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.context?.artifacts_missing).toEqual(["reviews/REVIEW.md"]);
    }

    // No journal written — fail-closed
    expect(existsSync(join(workspace, "journal.json"))).toBe(false);
  });
});
