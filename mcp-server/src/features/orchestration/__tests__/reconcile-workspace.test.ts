/**
 * Tests for reconcileWorkspace — read-only cliff detection tool.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Journal } from "../tools/orchestration-journal.ts";
import { reconcileWorkspace } from "../tools/reconcile-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { force: true, recursive: true });
  tmpDirs = [];
});

function writeJournal(workspace: string, journal: Journal): void {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf-8");
}

describe("reconcileWorkspace", () => {
  it("started step with artifact missing => incomplete_steps includes it, needs_recovery true", async () => {
    const workspace = makeTmpDir();
    const journal: Journal = {
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
      workspace,
    };
    writeJournal(workspace, journal);

    const result = await reconcileWorkspace({ workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(true);
    expect(result.incomplete_steps).toHaveLength(1);
    const step = result.incomplete_steps[0];
    expect(step.step_id).toBe("implement");
    expect(step.agent_type).toBe("engineer");
    expect(step.status).toBe("started");
    expect(step.missing_artifacts).toContain("plans/slug/SUMMARY.md");
  });

  it("started step with artifact present at workspace root => NOT flagged", async () => {
    const workspace = makeTmpDir();
    mkdirSync(join(workspace, "plans", "slug"), { recursive: true });
    writeFileSync(join(workspace, "plans", "slug", "SUMMARY.md"), "present", "utf-8");

    const journal: Journal = {
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
      workspace,
    };
    writeJournal(workspace, journal);

    const result = await reconcileWorkspace({ workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(false);
    expect(result.incomplete_steps).toHaveLength(0);
  });

  it("started step with artifact present in worktree/ => NOT flagged", async () => {
    const workspace = makeTmpDir();
    mkdirSync(join(workspace, "worktree", "plans", "slug"), { recursive: true });
    writeFileSync(join(workspace, "worktree", "plans", "slug", "SUMMARY.md"), "present", "utf-8");

    const journal: Journal = {
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
      workspace,
    };
    writeJournal(workspace, journal);

    const result = await reconcileWorkspace({ workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(false);
    expect(result.incomplete_steps).toHaveLength(0);
  });

  it("planned step with empty artifacts_expected => NOT flagged", async () => {
    const workspace = makeTmpDir();
    const journal: Journal = {
      steps: [
        {
          agent_type: null,
          artifacts_expected: [],
          status: "planned",
          step_id: "verify",
        },
      ],
      version: 1,
      workspace,
    };
    writeJournal(workspace, journal);

    const result = await reconcileWorkspace({ workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(false);
    expect(result.incomplete_steps).toHaveLength(0);
  });

  it("completed step => never included in incomplete_steps", async () => {
    const workspace = makeTmpDir();
    const journal: Journal = {
      steps: [
        {
          agent_type: "reviewer",
          artifacts_expected: ["reviews/REVIEW.md"],
          completed_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          status: "completed",
          step_id: "review",
        },
      ],
      version: 1,
      workspace,
    };
    writeJournal(workspace, journal);

    const result = await reconcileWorkspace({ workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(false);
    expect(result.incomplete_steps).toHaveLength(0);
  });

  it("outcome: and template entries => not counted as missing", async () => {
    const workspace = makeTmpDir();
    const journal: Journal = {
      steps: [
        {
          agent_type: "engineer",
          artifacts_expected: [
            "outcome:npm run build exit 0",
            "${WORKSPACE}/plans/slug/SUMMARY.md",
          ],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "verify",
        },
      ],
      version: 1,
      workspace,
    };
    writeJournal(workspace, journal);

    const result = await reconcileWorkspace({ workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(false);
    expect(result.incomplete_steps).toHaveLength(0);
  });

  it("no journal => WORKSPACE_NOT_FOUND error", async () => {
    const workspace = makeTmpDir();

    const result = await reconcileWorkspace({ workspace });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("non-absolute workspace => INVALID_INPUT error", async () => {
    const result = await reconcileWorkspace({ workspace: "relative/path" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("malformed journal JSON => returns cleanly with empty incomplete_steps (fail-open)", async () => {
    const workspace = makeTmpDir();
    writeFileSync(join(workspace, "journal.json"), "THIS IS NOT JSON {{{{", "utf-8");

    const result = await reconcileWorkspace({ workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(false);
    expect(result.incomplete_steps).toHaveLength(0);
  });

  it("is read-only: journal.json byte-identical before and after", async () => {
    const workspace = makeTmpDir();
    const journal: Journal = {
      steps: [
        {
          agent_type: "engineer",
          artifacts_expected: ["plans/slug/MISSING.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "implement",
        },
      ],
      version: 1,
      workspace,
    };
    writeJournal(workspace, journal);

    const journalPath = join(workspace, "journal.json");
    const before = readFileSync(journalPath, "utf-8");

    await reconcileWorkspace({ workspace });

    const after = readFileSync(journalPath, "utf-8");
    expect(after).toBe(before);
  });

  it("includes transcript_path from step when available", async () => {
    const workspace = makeTmpDir();
    const journal: Journal = {
      steps: [
        {
          agent_type: "architect",
          artifacts_expected: ["plans/slug/DESIGN.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "design",
          transcript_path: "/some/transcript.jsonl",
        },
      ],
      version: 1,
      workspace,
    };
    writeJournal(workspace, journal);

    const result = await reconcileWorkspace({ workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(true);
    const step = result.incomplete_steps[0];
    expect(step.transcript_path).toBe("/some/transcript.jsonl");
  });
});
