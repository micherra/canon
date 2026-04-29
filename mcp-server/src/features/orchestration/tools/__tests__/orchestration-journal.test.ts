/**
 * orchestration-journal — unit tests for log_step and verify_completion.
 *
 * Uses a per-test tmpdir workspace. No SQLite — the journal is a plain
 * JSON file at `${workspace}/journal.json`.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertOk, isToolError } from "../../../../shared/lib/tool-result.ts";
import type { Journal } from "../orchestration-journal.ts";
import { logStep, verifyCompletion } from "../orchestration-journal.ts";

// ─── Helpers for transcript-capture integration tests ────────────────────────

/** Saved env vars that need to be restored after transcript tests. */
type SavedEnv = {
  CLAUDE_CONFIG_DIR: string | undefined;
  CLAUDE_SESSION_ID: string | undefined;
  CANON_PROJECT_DIR: string | undefined;
};

function saveEnv(): SavedEnv {
  return {
    CANON_PROJECT_DIR: process.env.CANON_PROJECT_DIR,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
  };
}

function restoreEnv(saved: SavedEnv): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Write a minimal Claude Code agent JSONL file in the expected location:
 *   {configDir}/projects/{projectId}/{sessionId}/subagents/agent-{agentId}.jsonl
 */
function writeAgentJsonl(
  configDir: string,
  projectId: string,
  sessionId: string,
  agentId: string,
): void {
  const subagentsDir = join(configDir, "projects", projectId, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const entry = JSON.stringify({
    agentId,
    isSidechain: true,
    message: { content: "Task complete.", role: "assistant", usage: { output_tokens: 42 } },
    parentUuid: "parent-uuid",
    timestamp: "2026-04-29T00:00:00.000Z",
    type: "assistant",
  });
  writeFileSync(join(subagentsDir, `agent-${agentId}.jsonl`), entry, "utf-8");
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "canon-journal-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

async function readJournalFile(ws: string): Promise<Journal> {
  const raw = await readFile(join(ws, "journal.json"), "utf-8");
  return JSON.parse(raw) as Journal;
}

describe("logStep", () => {
  test("creates journal.json on first call", async () => {
    expect(existsSync(join(workspace, "journal.json"))).toBe(false);

    const result = await logStep({
      status: "planned",
      step_id: "step-a",
      workspace,
    });
    assertOk(result);
    expect(result.step_id).toBe("step-a");
    expect(result.status).toBe("planned");

    expect(existsSync(join(workspace, "journal.json"))).toBe(true);
    const journal = await readJournalFile(workspace);
    expect(journal.version).toBe(1);
    expect(journal.steps).toHaveLength(1);
    expect(journal.steps[0]?.step_id).toBe("step-a");
  });

  test("updates existing step status from planned → started → completed", async () => {
    await logStep({
      agent_type: "engineer",
      status: "planned",
      step_id: "step-a",
      workspace,
    });
    await logStep({ status: "started", step_id: "step-a", workspace });
    await logStep({ status: "completed", step_id: "step-a", workspace });

    const journal = await readJournalFile(workspace);
    expect(journal.steps).toHaveLength(1);
    expect(journal.steps[0]?.status).toBe("completed");
    expect(journal.steps[0]?.agent_type).toBe("engineer");
  });

  test("adds started_at on started and completed_at on completed", async () => {
    await logStep({ status: "started", step_id: "s1", workspace });
    let journal = await readJournalFile(workspace);
    expect(journal.steps[0]?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(journal.steps[0]?.completed_at).toBeUndefined();

    await logStep({ status: "completed", step_id: "s1", workspace });
    journal = await readJournalFile(workspace);
    expect(journal.steps[0]?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("returns WORKSPACE_NOT_FOUND for nonexistent workspace", async () => {
    const ghost = join(tmpdir(), "canon-journal-does-not-exist-xyz");
    const result = await logStep({
      status: "planned",
      step_id: "step-a",
      workspace: ghost,
    });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  test("returns INVALID_INPUT for empty step_id", async () => {
    const result = await logStep({
      status: "planned",
      step_id: "",
      workspace,
    });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  test("persists domain_skills_loaded and outcome fields (v2.1 extension)", async () => {
    // Create the declared artifact so the new enforcement does not block completion.
    writeFileSync(join(workspace, "plan.md"), "# Plan\n");
    await logStep({
      artifacts_expected: ["plan.md"],
      domain_skills_loaded: ["backend-api", "authentication-security"],
      outcome: { fix_iterations: 2, review_verdict: "approve", test_pass_rate: 0.95 },
      status: "completed",
      step_id: "s1",
      workspace,
    });
    const journal = await readJournalFile(workspace);
    expect(journal.steps[0]?.domain_skills_loaded).toEqual([
      "backend-api",
      "authentication-security",
    ]);
    expect(journal.steps[0]?.outcome).toEqual({
      fix_iterations: 2,
      review_verdict: "approve",
      test_pass_rate: 0.95,
    });
  });
});

describe("verifyCompletion", () => {
  test("returns complete: true when all steps completed and artifacts exist", async () => {
    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, "plans", "DESIGN.md"), "# Design\n");

    await logStep({
      artifacts_expected: ["plans/DESIGN.md"],
      status: "completed",
      step_id: "design",
      workspace,
    });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.complete).toBe(true);
    expect(result.steps_completed).toBe(1);
    expect(result.steps_missing).toEqual([]);
    expect(result.artifacts_missing).toEqual([]);
  });

  test("detects steps_missing (started but not completed)", async () => {
    await logStep({ status: "started", step_id: "s1", workspace });
    await logStep({ status: "completed", step_id: "s2", workspace });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect(result.steps_missing).toEqual([{ status: "started", step_id: "s1" }]);
    expect(result.steps_completed).toBe(1);
  });

  test("counts planned steps as missing (PR #119 P1 fix)", async () => {
    // A planned step that never transitioned must block completion —
    // otherwise a forgotten checklist item slips past the gate.
    await logStep({ status: "planned", step_id: "s1", workspace });
    await logStep({ status: "completed", step_id: "s2", workspace });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect(result.steps_missing).toEqual([{ status: "planned", step_id: "s1" }]);
    expect(result.steps_completed).toBe(1);
  });

  test("mixed planned + started are both reported as missing", async () => {
    await logStep({ status: "planned", step_id: "s1", workspace });
    await logStep({ status: "started", step_id: "s2", workspace });
    await logStep({ status: "completed", step_id: "s3", workspace });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect(result.steps_missing).toHaveLength(2);
    expect(result.steps_missing.map((s) => s.step_id).sort()).toEqual(["s1", "s2"]);
  });

  test("detects artifacts_missing when a completed step has missing artifacts (journal written directly)", async () => {
    // logStep now mechanically refuses to complete steps with missing artifacts,
    // so we simulate a pre-existing journal (e.g., from a prior run, manual edit,
    // or migrated workspace) where a step was already marked completed but its
    // artifact is absent. verifyCompletion must still catch this.
    const journal: Journal = {
      steps: [
        {
          agent_type: "engineer",
          artifacts_expected: ["nope.md"],
          status: "completed",
          step_id: "s1",
        },
      ],
      version: 1,
      workspace,
    };
    writeFileSync(join(workspace, "journal.json"), JSON.stringify(journal, null, 2));

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect(result.artifacts_missing).toEqual(["nope.md"]);
  });

  test("returns WORKSPACE_NOT_FOUND when no journal exists", async () => {
    const ghost = await mkdtemp(join(tmpdir(), "canon-journal-no-file-"));
    const result = await verifyCompletion({ workspace: ghost });
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    }
    await rm(ghost, { force: true, recursive: true });
  });

  test("handles skipped steps correctly (not counted as missing)", async () => {
    await logStep({ status: "skipped", step_id: "s1", workspace });
    await logStep({ status: "completed", step_id: "s2", workspace });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.steps_skipped).toEqual(["s1"]);
    expect(result.steps_missing).toEqual([]);
    expect(result.complete).toBe(true);
  });

  test("flow_outcome aggregates domain_skills_used, review_verdict, and fix_iterations", async () => {
    await logStep({
      domain_skills_loaded: ["backend-api"],
      outcome: { fix_iterations: 1 },
      status: "completed",
      step_id: "s1",
      workspace,
    });
    await logStep({
      domain_skills_loaded: ["backend-api", "testing"],
      outcome: { fix_iterations: 2, review_verdict: "approve" },
      status: "completed",
      step_id: "s2",
      workspace,
    });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.flow_outcome.domain_skills_used).toEqual(["backend-api", "testing"]);
    expect(result.flow_outcome.review_verdict).toBe("approve");
    expect(result.flow_outcome.fix_iterations).toBe(3);
    expect(result.flow_outcome.total_steps).toBe(2);
    expect(
      typeof result.flow_outcome.total_duration_ms === "number" ||
        result.flow_outcome.total_duration_ms === null,
    ).toBe(true);
  });

  test("review_verdict reports the LAST verdict, not the first (review→fix→re-review)", async () => {
    await logStep({
      outcome: { review_verdict: "block" },
      status: "completed",
      step_id: "review-1",
      workspace,
    });
    await logStep({
      outcome: { fix_iterations: 2 },
      status: "completed",
      step_id: "fix",
      workspace,
    });
    await logStep({
      outcome: { review_verdict: "approve" },
      status: "completed",
      step_id: "review-2",
      workspace,
    });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.flow_outcome.review_verdict).toBe("approve");
  });

  test("glob patterns in artifacts_expected resolve against workspace contents", async () => {
    mkdirSync(join(workspace, "plans", "my-slug"), { recursive: true });
    writeFileSync(join(workspace, "plans", "my-slug", "DESIGN.md"), "# D\n");
    writeFileSync(join(workspace, "plans", "my-slug", "INDEX.md"), "# I\n");

    await logStep({
      artifacts_expected: ["plans/my-slug/*.md"],
      status: "completed",
      step_id: "plan",
      workspace,
    });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.complete).toBe(true);
    expect(result.artifacts_missing).toEqual([]);
  });

  test("unresolved ${variable} patterns are surfaced via artifacts_skipped_unresolved", async () => {
    await logStep({
      artifacts_expected: ["plans/${slug}/DESIGN.md"],
      status: "completed",
      step_id: "plan",
      workspace,
    });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    // Not a false-negative: we don't claim the file is missing.
    expect(result.artifacts_missing).toEqual([]);
    // But we DO surface that the lead should double-check the substitution.
    expect(result.artifacts_skipped_unresolved).toEqual(["plans/${slug}/DESIGN.md"]);
    expect(result.complete).toBe(true);
  });
});

describe("logStep artifact scanning on completion — mechanical enforcement", () => {
  // --- New enforcement behavior: refuse to complete when artifacts are missing ---

  test("logStep refuses to complete when declared artifacts are missing", async () => {
    // First register the step as started
    await logStep({
      artifacts_expected: ["plans/DESIGN.md"],
      status: "started",
      step_id: "plan",
      workspace,
    });

    // Attempt to complete without writing the artifact
    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    // Must return an error — not toolOk
    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.recoverable).toBe(true);
      expect(result.message).toContain("plans/DESIGN.md");
      expect(result.context?.artifacts_missing).toEqual(["plans/DESIGN.md"]);
    }

    // Journal must stay at "started", not "completed"
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

    // Journal must reflect completed status
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
    // INDEX.md intentionally NOT created

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

    // Still not completed
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
      // No artifacts_expected — defaults to empty array
      status: "completed",
      step_id: "plan",
      workspace,
    });

    assertOk(result);
    expect(result.status).toBe("completed");
  });

  test("logStep preserves planned status when refusing completion from planned → completed", async () => {
    // Step registered directly as planned with expected artifacts
    await logStep({
      artifacts_expected: ["plans/DESIGN.md"],
      status: "planned",
      step_id: "plan",
      workspace,
    });

    // Attempt to complete without writing artifact
    const result = await logStep({
      status: "completed",
      step_id: "plan",
      workspace,
    });

    expect(isToolError(result)).toBe(true);

    // Must revert to "planned" (the pre-completion status)
    const journal = await readJournalFile(workspace);
    const step = journal.steps.find((s) => s.step_id === "plan");
    expect(step?.status).toBe("planned");
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
      // Non-completed statuses must still succeed even with missing artifacts
      assertOk(result);
      expect(result.artifacts_missing).toBeUndefined();
    }
  });
});

// ─── NF-17: logStep transcript-capture integration ───────────────────────────

describe("logStep — transcript capture via agent_id", () => {
  const AGENT_ID = "nf17-agent-01";
  // logStep calls captureTranscript without project_id/session_id, so they
  // must come from CANON_PROJECT_DIR → deriveProjectIdFromEnv() and CLAUDE_SESSION_ID.
  // CANON_PROJECT_DIR="/Users/test-project" → project_id = "-Users-test-project"
  const CANON_PROJECT_DIR_VAL = "/Users/test-project";
  const PROJECT_ID = "-Users-test-project"; // slash-replaced form used as folder name
  const SESSION_ID = "session-nf17";

  test("agent_id triggers capture and records transcript_path in result", async () => {
    const saved = saveEnv();
    const fakeConfigDir = await mkdtemp(join(tmpdir(), "canon-cc-config-"));

    try {
      writeAgentJsonl(fakeConfigDir, PROJECT_ID, SESSION_ID, AGENT_ID);

      process.env.CLAUDE_CONFIG_DIR = fakeConfigDir;
      process.env.CLAUDE_SESSION_ID = SESSION_ID;
      process.env.CANON_PROJECT_DIR = CANON_PROJECT_DIR_VAL;

      // First register the step with agent_type so step.agent_type is set
      await logStep({
        agent_type: "engineer",
        status: "planned",
        step_id: "implement",
        workspace,
      });

      const result = await logStep({
        agent_id: AGENT_ID,
        status: "completed",
        step_id: "implement",
        workspace,
      });

      assertOk(result);
      expect(result.step_id).toBe("implement");
      expect(result.status).toBe("completed");
      expect(result.transcript_path).toBeDefined();
      expect(result.transcript_path).not.toBe("");
      expect(result.transcript_path).toContain(join(workspace, "transcripts"));
    } finally {
      restoreEnv(saved);
      await rm(fakeConfigDir, { force: true, recursive: true });
    }
  });

  test("without agent_id, no transcript_path in result (backward compat)", async () => {
    const result = await logStep({
      agent_type: "engineer",
      status: "completed",
      step_id: "implement-no-capture",
      workspace,
      // intentionally no agent_id
    });

    assertOk(result);
    expect(result.step_id).toBe("implement-no-capture");
    expect(result.transcript_path).toBeUndefined();
  });

  test("agent_id provided but source file missing → step completes, no transcript_path", async () => {
    const saved = saveEnv();
    const emptyConfigDir = await mkdtemp(join(tmpdir(), "canon-cc-empty-"));

    try {
      // Point to a config dir that has no agent JSONL files
      process.env.CLAUDE_CONFIG_DIR = emptyConfigDir;
      process.env.CLAUDE_SESSION_ID = SESSION_ID;
      process.env.CANON_PROJECT_DIR = CANON_PROJECT_DIR_VAL;

      await logStep({
        agent_type: "engineer",
        status: "planned",
        step_id: "implement-no-source",
        workspace,
      });

      const result = await logStep({
        agent_id: "nonexistent-agent",
        status: "completed",
        step_id: "implement-no-source",
        workspace,
      });

      // Step must succeed (best-effort — capture failure never blocks)
      assertOk(result);
      expect(result.status).toBe("completed");
      // No transcript_path because source file was missing
      expect(result.transcript_path).toBeUndefined();
    } finally {
      restoreEnv(saved);
      await rm(emptyConfigDir, { force: true, recursive: true });
    }
  });

  test("transcript_path is persisted to journal.json after successful capture", async () => {
    const saved = saveEnv();
    const fakeConfigDir = await mkdtemp(join(tmpdir(), "canon-cc-config2-"));

    try {
      writeAgentJsonl(fakeConfigDir, PROJECT_ID, SESSION_ID, AGENT_ID);

      process.env.CLAUDE_CONFIG_DIR = fakeConfigDir;
      process.env.CLAUDE_SESSION_ID = SESSION_ID;
      process.env.CANON_PROJECT_DIR = CANON_PROJECT_DIR_VAL;

      // Plan then complete with agent_id
      await logStep({
        agent_type: "tester",
        status: "planned",
        step_id: "test-step",
        workspace,
      });

      const result = await logStep({
        agent_id: AGENT_ID,
        status: "completed",
        step_id: "test-step",
        workspace,
      });

      assertOk(result);
      expect(result.transcript_path).toBeDefined();
      expect(result.transcript_path).not.toBe("");

      // Read the journal.json from disk and verify transcript_path is persisted
      const raw = await readFile(join(workspace, "journal.json"), "utf-8");
      const journal = JSON.parse(raw) as Journal;
      const step = journal.steps.find((s) => s.step_id === "test-step");
      expect(step).toBeDefined();
      expect(step?.transcript_path).toBe(result.transcript_path);
    } finally {
      restoreEnv(saved);
      await rm(fakeConfigDir, { force: true, recursive: true });
    }
  });
});
