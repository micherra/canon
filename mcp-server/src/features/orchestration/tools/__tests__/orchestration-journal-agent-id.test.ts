/** orchestration-journal — agent_id enforcement and capture pipeline tests (line-count split). */
// Main tests live in orchestration-journal.test.ts

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

import { assertOk, isToolError } from "../../../../shared/lib/tool-result.ts";
import type { Journal } from "../orchestration-journal.ts";
import { logStep } from "../orchestration-journal.ts";

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
  workspace = await mkdtemp(join(tmpdir(), "canon-journal-aid-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
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

    // Exemption 2: status "skipped" bypasses the agent_id guard (skipped steps never have an agent)
    // but skip_reason is required for skipped steps.
    const skipped = await logStep({
      skip_reason: "fix-type build, no contract-level changes",
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
