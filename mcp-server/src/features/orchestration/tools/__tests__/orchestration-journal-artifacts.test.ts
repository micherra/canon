/**
 * orchestration-journal artifact enforcement — unit tests for logStep's
 * mechanical artifact-presence checks on step completion.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertOk, isToolError } from "../../../../shared/lib/tool-result.ts";
import type { Journal } from "../orchestration-journal.ts";
import { logStep } from "../orchestration-journal.ts";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-journal-art-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

async function readJournalFile(ws: string): Promise<Journal> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(join(ws, "journal.json"), "utf-8");
  return JSON.parse(raw) as Journal;
}

describe("logStep artifact scanning on completion — mechanical enforcement", () => {
  test("logStep refuses to complete when declared artifacts are missing", async () => {
    await logStep({
      artifacts_expected: ["plans/DESIGN.md"],
      status: "started",
      step_id: "plan",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.recoverable).toBe(true);
      expect(result.message).toContain("plans/DESIGN.md");
      expect(result.context?.artifacts_missing).toEqual(["plans/DESIGN.md"]);
    }

    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "plan");
    expect(step?.status).toBe("started");
  });

  test("logStep completes normally when all artifacts exist", async () => {
    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, "plans", "DESIGN.md"), "# Design\n");

    await logStep({
      artifacts_expected: ["plans/DESIGN.md"],
      status: "started",
      step_id: "plan",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    assertOk(result);
    expect(result.status).toBe("completed");
    expect(result.artifacts_missing).toBeUndefined();

    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "plan");
    expect(step?.status).toBe("completed");
  });

  test("logStep allows completion when all artifacts are outcome: sentinels", async () => {
    await logStep({
      artifacts_expected: ["outcome:all tests pass"],
      status: "started",
      step_id: "plan",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    assertOk(result);
    expect(result.status).toBe("completed");

    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "plan");
    expect(step?.status).toBe("completed");
  });

  test("logStep allows completion when artifacts_expected is empty", async () => {
    await logStep({
      artifacts_expected: [],
      status: "started",
      step_id: "plan",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    assertOk(result);
    expect(result.status).toBe("completed");
  });

  test("logStep allows completion when all artifacts have ${variable} templates", async () => {
    await logStep({
      artifacts_expected: ["${WORKSPACE}/plans/DESIGN.md"],
      status: "started",
      step_id: "plan",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    assertOk(result);
    expect(result.status).toBe("completed");
  });

  test("logStep refuses completion with multiple missing artifacts — lists all in error", async () => {
    await logStep({
      artifacts_expected: ["plans/DESIGN.md", "plans/INDEX.md"],
      status: "started",
      step_id: "plan",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.context?.artifacts_missing).toEqual(["plans/DESIGN.md", "plans/INDEX.md"]);
    }

    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "plan");
    expect(step?.status).toBe("started");
  });

  test("logStep refuses completion when one artifact present, one missing", async () => {
    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, "plans", "DESIGN.md"), "# Design\n");

    await logStep({
      artifacts_expected: ["plans/DESIGN.md", "plans/INDEX.md"],
      status: "started",
      step_id: "plan",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.context?.artifacts_missing).toEqual(["plans/INDEX.md"]);
    }

    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "plan");
    expect(step?.status).toBe("started");
  });

  test("logStep allows completion when no artifacts_expected field provided", async () => {
    await logStep({
      status: "started",
      step_id: "plan",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    assertOk(result);
    expect(result.status).toBe("completed");
  });

  test("logStep preserves planned status when refusing completion from planned → completed", async () => {
    await logStep({
      artifacts_expected: ["plans/DESIGN.md"],
      status: "planned",
      step_id: "plan",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    expect(isToolError(result)).toBe(true);

    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "plan");
    expect(step?.status).toBe("planned");
  });

  test("artifact-check failure rolls back completed_at and outcome (P2 fix)", async () => {
    await logStep({
      artifacts_expected: ["plans/MISSING.md"],
      status: "started",
      step_id: "s1",
      workspace,
    });

    const result = await logStep({
      outcome: { review_verdict: "clean" },
      status: "completed",
      step_id: "s1",
      workspace,
    });

    expect(isToolError(result)).toBe(true);

    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "s1");
    expect(step?.status).toBe("started");
    expect(step?.completed_at).toBeUndefined();
    expect(step?.outcome).toBeUndefined();
  });

  test("does not apply artifact enforcement for non-completed statuses", async () => {
    const statuses = ["planned", "started", "skipped"] as const;
    const results = await Promise.all(
      statuses.map((status) =>
        logStep({
          artifacts_expected: ["plans/DESIGN.md"],
          status,
          step_id: `step-${status}`,
          workspace,
        }),
      ),
    );
    for (const result of results) {
      assertOk(result);
      expect(result.artifacts_missing).toBeUndefined();
    }
  });

  test("logStep finds artifacts in workspace root (reviews, plans)", async () => {
    mkdirSync(join(workspace, "reviews"), { recursive: true });
    writeFileSync(join(workspace, "reviews", "REVIEW.md"), "# Review\n");

    await logStep({
      artifacts_expected: ["reviews/REVIEW.md"],
      status: "started",
      step_id: "review",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "review",
      workspace,
    });

    assertOk(result);
    expect(result.status).toBe("completed");
    expect(result.artifacts_missing).toBeUndefined();
  });

  test("logStep finds artifacts in worktree/ subdirectory (code files from engineer agents)", async () => {
    mkdirSync(join(workspace, "worktree", "src"), { recursive: true });
    writeFileSync(join(workspace, "worktree", "src", "feature.ts"), "export {};\n");

    await logStep({
      artifacts_expected: ["src/feature.ts"],
      status: "started",
      step_id: "implement",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "implement",
      workspace,
    });

    assertOk(result);
    expect(result.status).toBe("completed");
    expect(result.artifacts_missing).toBeUndefined();
  });

  test("logStep finds artifacts when some are at workspace root and some in worktree/", async () => {
    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, "plans", "DESIGN.md"), "# Design\n");
    mkdirSync(join(workspace, "worktree", "src"), { recursive: true });
    writeFileSync(join(workspace, "worktree", "src", "service.ts"), "export {};\n");

    await logStep({
      artifacts_expected: ["plans/DESIGN.md", "src/service.ts"],
      status: "started",
      step_id: "mixed",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "mixed",
      workspace,
    });

    assertOk(result);
    expect(result.status).toBe("completed");
    expect(result.artifacts_missing).toBeUndefined();
  });

  test("logStep still reports missing when artifact is absent from both workspace root and worktree/", async () => {
    mkdirSync(join(workspace, "worktree"), { recursive: true });

    await logStep({
      artifacts_expected: ["src/missing-file.ts"],
      status: "started",
      step_id: "implement",
      workspace,
    });

    const result = await logStep({
      status: "completed",
      step_id: "implement",
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.context?.artifacts_missing).toEqual(["src/missing-file.ts"]);
    }
  });
});
