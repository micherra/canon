/**
 * Tests for reconcileWorkspace — read-only cliff detection tool.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { afterEach, describe, expect, it } from "vitest";
import type { Journal } from "../tools/orchestration-journal.ts";
import { reconcileWorkspace } from "../tools/reconcile-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** Initialize an execution store so getExecutionStore(workspace) resolves. */
function setupStore(workspace: string): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: "implement",
    entry: "implement",
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });
}

afterEach(() => {
  clearStoreCache();
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

  it("started step with present-but-Partial skeleton => flagged via partial_artifacts", async () => {
    const workspace = makeTmpDir();
    mkdirSync(join(workspace, "plans", "slug"), { recursive: true });
    writeFileSync(
      join(workspace, "plans", "slug", "DESIGN.md"),
      "# Design\n\n## Status: Partial\n\n## Approach\n",
      "utf-8",
    );

    const journal: Journal = {
      steps: [
        {
          agent_type: "architect",
          artifacts_expected: ["plans/slug/DESIGN.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "design",
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
    expect(step.step_id).toBe("design");
    expect(step.missing_artifacts).toHaveLength(0);
    expect(step.partial_artifacts).toContain("plans/slug/DESIGN.md");
  });

  it("started step with present IN_PROGRESS reviewer stub => flagged via partial_artifacts", async () => {
    const workspace = makeTmpDir();
    mkdirSync(join(workspace, "reviews"), { recursive: true });
    writeFileSync(
      join(workspace, "reviews", "REVIEW.md"),
      "---\nverdict: IN_PROGRESS\n---\n\n## Canon Review — Verdict: IN_PROGRESS\n",
      "utf-8",
    );

    const journal: Journal = {
      steps: [
        {
          agent_type: "reviewer",
          artifacts_expected: ["reviews/REVIEW.md"],
          started_at: new Date().toISOString(),
          status: "started",
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
    expect(result.needs_recovery).toBe(true);
    expect(result.incomplete_steps[0]?.partial_artifacts).toContain("reviews/REVIEW.md");
  });

  it("started step with present IN_PROGRESS scribe skeleton (frontmatter status) => flagged via partial_artifacts", async () => {
    const workspace = makeTmpDir();
    mkdirSync(join(workspace, "plans", "slug"), { recursive: true });
    writeFileSync(
      join(workspace, "plans", "slug", "CONTEXT-SYNC.md"),
      '---\nstatus: "IN_PROGRESS"\nagent: scribe\ntimestamp: "2026-07-06T00:00:00Z"\n---\n\n## Context Sync\n',
      "utf-8",
    );

    const journal: Journal = {
      steps: [
        {
          agent_type: "scribe",
          artifacts_expected: ["plans/slug/CONTEXT-SYNC.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "context-sync",
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
    expect(result.incomplete_steps[0]?.partial_artifacts).toContain("plans/slug/CONTEXT-SYNC.md");
  });

  it("started step with present, FINAL artifact (no skeleton marker) => NOT flagged", async () => {
    const workspace = makeTmpDir();
    mkdirSync(join(workspace, "reviews"), { recursive: true });
    writeFileSync(
      join(workspace, "reviews", "REVIEW.md"),
      "---\nverdict: CLEAN\n---\n\n## Canon Review — Verdict: CLEAN\n\nAll good.\n",
      "utf-8",
    );

    const journal: Journal = {
      steps: [
        {
          agent_type: "reviewer",
          artifacts_expected: ["reviews/REVIEW.md"],
          started_at: new Date().toISOString(),
          status: "started",
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

describe("reconcileWorkspace — cliff_detected telemetry", () => {
  function cliffJournal(workspace: string): Journal {
    return {
      steps: [
        {
          agent_type: "engineer",
          artifacts_expected: ["plans/slug/SUMMARY.md", "plans/slug/OTHER.md"],
          started_at: new Date().toISOString(),
          status: "started",
          step_id: "implement",
        },
      ],
      version: 1,
      workspace,
    };
  }

  it("emits exactly one cliff_detected event with the correct payload when emit_telemetry && a cliff exists", async () => {
    const workspace = makeTmpDir();
    setupStore(workspace);
    writeJournal(workspace, cliffJournal(workspace));

    const result = await reconcileWorkspace({ workspace, emit_telemetry: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(true);

    const events = getExecutionStore(workspace).getEventsByType("cliff_detected");
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(payload.incomplete_step_ids).toEqual(["implement"]);
    expect(payload.missing_count).toBe(2);
    expect(payload.partial_count).toBe(0);
    expect(payload.needs_recovery).toBe(true);
    expect(payload.source).toBe("resume");
    expect(typeof payload.timestamp).toBe("string");
  });

  it("defaults source to 'resume' and round-trips 'post_subagent' when passed", async () => {
    const workspace = makeTmpDir();
    setupStore(workspace);
    writeJournal(workspace, cliffJournal(workspace));

    await reconcileWorkspace({ workspace, emit_telemetry: true, source: "post_subagent" });

    const events = getExecutionStore(workspace).getEventsByType("cliff_detected");
    expect(events).toHaveLength(1);
    expect(events[0].payload.source).toBe("post_subagent");
  });

  it("does NOT emit when emit_telemetry is absent (default behavior unchanged)", async () => {
    const workspace = makeTmpDir();
    setupStore(workspace);
    writeJournal(workspace, cliffJournal(workspace));

    const result = await reconcileWorkspace({ workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(true);
    expect(getExecutionStore(workspace).getEventsByType("cliff_detected")).toHaveLength(0);
  });

  it("does NOT emit when emit_telemetry is false", async () => {
    const workspace = makeTmpDir();
    setupStore(workspace);
    writeJournal(workspace, cliffJournal(workspace));

    await reconcileWorkspace({ workspace, emit_telemetry: false });

    expect(getExecutionStore(workspace).getEventsByType("cliff_detected")).toHaveLength(0);
  });

  it("does NOT emit when emit_telemetry is true but no cliff exists (needs_recovery false)", async () => {
    const workspace = makeTmpDir();
    setupStore(workspace);
    mkdirSync(join(workspace, "plans", "slug"), { recursive: true });
    writeFileSync(join(workspace, "plans", "slug", "SUMMARY.md"), "present", "utf-8");
    writeFileSync(join(workspace, "plans", "slug", "OTHER.md"), "present", "utf-8");
    writeJournal(workspace, cliffJournal(workspace));

    const result = await reconcileWorkspace({ workspace, emit_telemetry: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(false);
    expect(getExecutionStore(workspace).getEventsByType("cliff_detected")).toHaveLength(0);
  });

  it("fail-open: a throwing appendEvent does not change the result and does not reject", async () => {
    const workspace = makeTmpDir();
    setupStore(workspace);
    writeJournal(workspace, cliffJournal(workspace));

    // Inject a throwing appendEvent on the cached store the helper will reuse.
    const store = getExecutionStore(workspace);
    store.appendEvent = () => {
      throw new Error("simulated event-store write failure");
    };

    const result = await reconcileWorkspace({ workspace, emit_telemetry: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needs_recovery).toBe(true);
    expect(result.incomplete_steps).toHaveLength(1);
    expect(result.incomplete_steps[0].step_id).toBe("implement");
  });
});
