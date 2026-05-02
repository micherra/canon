/** orchestration-journal — unit tests for log_step and verify_completion. */
// batchLogSteps tests live in batch-log-steps.test.ts (line-count split)

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertOk, isToolError } from "../../../../shared/lib/tool-result.ts";
import type { Journal } from "../orchestration-journal.ts";
import { logStep, verifyCompletion } from "../orchestration-journal.ts";

// Plant a fake agent JSONL where captureTranscript will find it.
function plantAgentJsonl(fakeHome: string, agentId: string): void {
  const pid = process.cwd().replace(/\//g, "-");
  const subagentsDir = join(fakeHome, ".claude", "projects", pid, "session-test", "subagents");
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
    await logStep({ agent_id: "test-agent-01", status: "completed", step_id: "step-a", workspace });

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

    await logStep({ agent_id: "test-agent-ts", status: "completed", step_id: "s1", workspace });
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
      agent_id: "test-agent-meta",
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
      agent_id: "test-agent-design",
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
    await logStep({ agent_id: "test-agent-vc1", status: "completed", step_id: "s2", workspace });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect(result.steps_missing).toEqual([{ status: "started", step_id: "s1" }]);
    expect(result.steps_completed).toBe(1);
  });

  test("counts planned steps as missing (PR #119 P1 fix)", async () => {
    await logStep({ status: "planned", step_id: "s1", workspace });
    await logStep({ agent_id: "test-agent-vc2", status: "completed", step_id: "s2", workspace });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect(result.steps_missing).toEqual([{ status: "planned", step_id: "s1" }]);
    expect(result.steps_completed).toBe(1);
  });

  test("mixed planned + started are both reported as missing", async () => {
    await logStep({ status: "planned", step_id: "s1", workspace });
    await logStep({ status: "started", step_id: "s2", workspace });
    await logStep({ agent_id: "test-agent-vc3", status: "completed", step_id: "s3", workspace });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.complete).toBe(false);
    expect(result.steps_missing).toHaveLength(2);
    expect(result.steps_missing.map((s) => s.step_id).sort()).toEqual(["s1", "s2"]);
  });

  test("detects artifacts_missing when a completed step has missing artifacts (journal written directly)", async () => {
    // Simulate a pre-existing journal where a step is completed but its artifact is absent.
    // verifyCompletion must still catch this.
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
    await logStep({ agent_id: "test-agent-skip", status: "completed", step_id: "s2", workspace });

    const result = await verifyCompletion({ workspace });
    assertOk(result);
    expect(result.steps_skipped).toEqual(["s1"]);
    expect(result.steps_missing).toEqual([]);
    expect(result.complete).toBe(true);
  });

  test("flow_outcome aggregates domain_skills_used, review_verdict, and fix_iterations", async () => {
    await logStep({
      agent_id: "test-agent-fo1",
      domain_skills_loaded: ["backend-api"],
      outcome: { fix_iterations: 1 },
      status: "completed",
      step_id: "s1",
      workspace,
    });
    await logStep({
      agent_id: "test-agent-fo2",
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
      agent_id: "test-agent-rv1",
      outcome: { review_verdict: "block" },
      status: "completed",
      step_id: "review-1",
      workspace,
    });
    await logStep({
      agent_id: "test-agent-rv2",
      outcome: { fix_iterations: 2 },
      status: "completed",
      step_id: "fix",
      workspace,
    });
    await logStep({
      agent_id: "test-agent-rv3",
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
      agent_id: "test-agent-glob",
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
      agent_id: "test-agent-unresolved",
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

// ─── NF-17: logStep transcript-capture integration ──────────────────────────
describe("logStep — transcript capture via agent_id", () => {
  const AGENT_ID = "nf17-agent-01";

  test("agent_id triggers capture and records transcript_path in result", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "canon-home-"));
    plantAgentJsonl(fakeHome, AGENT_ID);
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
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
      process.env.HOME = originalHome;
      await rm(fakeHome, { force: true, recursive: true });
    }
  });

  test("without agent_id, completed step is rejected with INVALID_INPUT", async () => {
    const result = await logStep({
      agent_type: "engineer",
      status: "completed",
      step_id: "implement-no-capture",
      workspace,
    });

    expect(isToolError(result)).toBe(true);
    if (isToolError(result)) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  test("agent_id provided but source file missing → step completes, no transcript_path", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "canon-home-empty-"));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
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

      assertOk(result);
      expect(result.status).toBe("completed");
      expect(result.transcript_path).toBeUndefined();
    } finally {
      process.env.HOME = originalHome;
      await rm(fakeHome, { force: true, recursive: true });
    }
  });

  test("transcript_path is persisted to journal.json after successful capture", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "canon-home-"));
    plantAgentJsonl(fakeHome, AGENT_ID);
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
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

      const raw = await readFile(join(workspace, "journal.json"), "utf-8");
      const journal = JSON.parse(raw) as Journal;
      const step = journal.steps.find((s) => s.step_id === "test-step");
      expect(step).toBeDefined();
      expect(step?.transcript_path).toBe(result.transcript_path);
    } finally {
      process.env.HOME = originalHome;
      await rm(fakeHome, { force: true, recursive: true });
    }
  });
});

// ─── agent_id enforcement ────────────────────────────────────────────────────
describe("logStep — agent_id enforcement", () => {
  test("completed step without agent_id is rejected; exemptions pass through", async () => {
    // Rejection: completed + no agent_id + non-exempt step_id
    const rejected = await logStep({
      status: "completed",
      step_id: "some-step",
      workspace,
    });
    expect(isToolError(rejected)).toBe(true);
    if (isToolError(rejected)) {
      expect(rejected.error_code).toBe("INVALID_INPUT");
    }

    // Exemption 1: step_id "inline-fix" bypasses the guard
    const inlineFix = await logStep({
      status: "completed",
      step_id: "inline-fix",
      workspace,
    });
    expect(isToolError(inlineFix)).toBe(false);
    if (!isToolError(inlineFix)) {
      expect(inlineFix.step_id).toBe("inline-fix");
    }

    // Exemption 2: status "skipped" bypasses the guard (skipped steps never have an agent)
    const skipped = await logStep({
      status: "skipped",
      step_id: "skipped-step",
      workspace,
    });
    expect(isToolError(skipped)).toBe(false);
    if (!isToolError(skipped)) {
      expect(skipped.step_id).toBe("skipped-step");
    }
  });

  test("full capture pipeline — fake JSONL in, Canon transcript out", async () => {
    const AGENT_ID = "enforce-pipeline-agent-01";
    const fakeHome = await mkdtemp(join(tmpdir(), "canon-home-enforce-"));
    plantAgentJsonl(fakeHome, AGENT_ID);
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      await logStep({
        agent_type: "engineer",
        status: "planned",
        step_id: "enforce-step",
        workspace,
      });

      await logStep({
        status: "started",
        step_id: "enforce-step",
        workspace,
      });

      // Step 3: completed with agent_id — triggers transcript capture
      const result = await logStep({
        agent_id: AGENT_ID,
        status: "completed",
        step_id: "enforce-step",
        workspace,
      });

      // logStep must succeed
      assertOk(result);
      expect(result.transcript_path).toBeDefined();
      expect(result.transcript_path).not.toBe("");

      // transcripts/ directory must contain a .jsonl file
      const transcriptsDir = join(workspace, "transcripts");
      expect(existsSync(transcriptsDir)).toBe(true);
      const transcriptFiles = readdirSync(transcriptsDir).filter((f) => f.endsWith(".jsonl"));
      expect(transcriptFiles.length).toBeGreaterThan(0);

      // Read and parse the transcript JSONL — entries must have Canon shape
      const transcriptContent = await readFile(join(transcriptsDir, transcriptFiles[0]!), "utf-8");
      const lines = transcriptContent.split("\n").filter((l) => l.trim());
      expect(lines.length).toBeGreaterThan(0);
      const firstEntry = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(firstEntry).toHaveProperty("role");
      expect(firstEntry).toHaveProperty("content");
      expect(firstEntry).toHaveProperty("turn_number");
      expect(firstEntry).toHaveProperty("timestamp");

      // Journal step must have transcript_path populated
      const raw = await readFile(join(workspace, "journal.json"), "utf-8");
      const journal = JSON.parse(raw) as Journal;
      const step = journal.steps.find((s) => s.step_id === "enforce-step");
      expect(step).toBeDefined();
      expect(step?.transcript_path).toBe(result.transcript_path);
      expect(existsSync(step!.transcript_path!)).toBe(true);
    } finally {
      process.env.HOME = originalHome;
      await rm(fakeHome, { force: true, recursive: true });
    }
  });

  test("bogus agent_id (no matching JSONL) — step succeeds with transcript_warning, no transcript file", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "canon-home-bogus-"));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      await logStep({
        agent_type: "engineer",
        status: "planned",
        step_id: "bogus-step",
        workspace,
      });

      const result = await logStep({
        agent_id: "bogus-agent-no-file-xyz",
        status: "completed",
        step_id: "bogus-step",
        workspace,
      });

      // Call must succeed — agent_id IS provided, missing source is a warning not an error
      assertOk(result);
      expect(result.transcript_path).toBeUndefined();

      // A warning must be present explaining why transcript capture failed
      expect(result.transcript_warning).toBeDefined();
      expect(result.transcript_warning).toContain("bogus-agent-no-file-xyz");

      // No file should appear in transcripts/ directory
      const transcriptsDir = join(workspace, "transcripts");
      if (existsSync(transcriptsDir)) {
        const transcriptFiles = readdirSync(transcriptsDir).filter((f) => f.endsWith(".jsonl"));
        expect(transcriptFiles.length).toBe(0);
      }
    } finally {
      process.env.HOME = originalHome;
      await rm(fakeHome, { force: true, recursive: true });
    }
  });
});
