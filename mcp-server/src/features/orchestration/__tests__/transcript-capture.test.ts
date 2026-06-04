import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeEntry } from "../services/transcript-transformer.ts";
import { captureTranscript } from "../tools/capture-transcript.ts";
import { getTranscript } from "../tools/get-transcript.ts";

// Minimal shape of a resolved flow used only for test setup.
type MinimalFlow = {
  description: string;
  entry: string;
  name: string;
  spawn_instructions: Record<string, string>;
  states: Record<string, { type: string; transitions?: Record<string, string> }>;
};

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "capture-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeMinimalFlow(): MinimalFlow {
  return {
    description: "A test flow",
    entry: "build",
    name: "test-flow",
    spawn_instructions: {},
    states: {
      build: { transitions: { done: "done_state" }, type: "single" },
      done_state: { type: "terminal" },
    },
  };
}

function setupWorkspace(workspace: string, flow: MinimalFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });
  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
  }
}

const AGENT_ID = "test-agent-01";

function makeMinimalCCEntries(): ClaudeCodeEntry[] {
  return [
    {
      agentId: AGENT_ID,
      isSidechain: true,
      message: { content: "Please implement the feature.", role: "user" },
      parentUuid: "parent-uuid",
      timestamp: "2026-04-27T00:00:00.000Z",
      type: "user",
    },
    {
      agentId: AGENT_ID,
      isSidechain: true,
      message: {
        content: "Done! I implemented it.",
        role: "assistant",
        usage: { output_tokens: 50 },
      },
      parentUuid: "parent-uuid",
      timestamp: "2026-04-27T00:00:01.000Z",
      type: "assistant",
    },
  ];
}

function plantAgentTranscript(
  fakeHome: string,
  agentId: string,
  entries: ClaudeCodeEntry[],
  projectDir: string = process.cwd(),
): void {
  const pid = projectDir.replace(/\//g, "-");
  const dir = join(fakeHome, ".claude", "projects", pid, "session-test", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `agent-${agentId}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join("\n"),
    "utf-8",
  );
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) rmSync(dir, { force: true, recursive: true });
  tmpDirs = [];
});

describe("captureTranscript", () => {
  it("uses the explicit projectDir param (not process.cwd) to derive the project path", async () => {
    const workspace = makeTmpDir();
    setupWorkspace(workspace, makeMinimalFlow());

    const fakeHome = makeTmpDir();
    // Use a fake project dir that differs from process.cwd()
    const fakeProjectDir = "/Users/fake/my-project";

    // Plant the transcript under the fake project dir path
    plantAgentTranscript(fakeHome, AGENT_ID, makeMinimalCCEntries(), fakeProjectDir);

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const result = await captureTranscript({
        agent_id: AGENT_ID,
        agent_type: "engineer",
        projectDir: fakeProjectDir,
        step_id: "build",
        workspace,
      });

      assertOk(result);
      // Should find the transcript at the fakeProjectDir-derived path, not process.cwd()
      expect(result.warning).toBeUndefined();
      expect(result.entry_count).toBe(2);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("captures transcript and writes JSONL readable by get_transcript", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const fakeHome = makeTmpDir();
    const projDir = process.cwd();
    plantAgentTranscript(fakeHome, AGENT_ID, makeMinimalCCEntries(), projDir);

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const result = await captureTranscript({
        agent_id: AGENT_ID,
        agent_type: "engineer",
        projectDir: projDir,
        step_id: "build",
        workspace,
      });

      assertOk(result);
      expect(result.warning).toBeUndefined();
      expect(result.entry_count).toBe(2);
      expect(result.transcript_path).toContain(join(workspace, "transcripts"));

      const store = getExecutionStore(workspace);
      store.setTranscriptPath("build", result.transcript_path);
      const readResult = await getTranscript({ state_id: "build", workspace });
      assertOk(readResult);
      expect(readResult.entry_count).toBe(2);
      expect(readResult.entries[0].role).toBe("user");
      expect(readResult.entries[1].role).toBe("assistant");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("returns warning when agent transcript not found", async () => {
    const workspace = makeTmpDir();
    setupWorkspace(workspace, makeMinimalFlow());

    const fakeHome = makeTmpDir();
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const result = await captureTranscript({
        agent_id: "nonexistent-agent",
        agent_type: "engineer",
        projectDir: process.cwd(),
        step_id: "implement",
        workspace,
      });

      assertOk(result);
      expect(result.transcript_path).toBe("");
      expect(result.entry_count).toBe(0);
      expect(result.warning).toContain("nonexistent-agent");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("handles array content blocks — entry count matches Canon entries", async () => {
    const workspace = makeTmpDir();
    setupWorkspace(workspace, makeMinimalFlow());

    const fakeHome = makeTmpDir();
    const ccEntries: ClaudeCodeEntry[] = [
      {
        agentId: AGENT_ID,
        isSidechain: true,
        message: {
          content: [
            { text: "Let me check.", type: "text" },
            { input: { file_path: "/foo.ts" }, name: "Read", type: "tool_use" },
          ],
          role: "assistant",
          usage: { output_tokens: 30 },
        },
        parentUuid: "uuid1",
        timestamp: "2026-04-27T00:00:00.000Z",
        type: "assistant",
      },
    ];
    plantAgentTranscript(fakeHome, AGENT_ID, ccEntries);

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const result = await captureTranscript({
        agent_id: AGENT_ID,
        agent_type: "engineer",
        projectDir: process.cwd(),
        step_id: "implement",
        workspace,
      });

      assertOk(result);
      expect(result.entry_count).toBe(2);
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

describe("captureTranscript — source_path and persist_path (harvest-02)", () => {
  it("source_path is primary — succeeds even with bogus agent_id when source_path provided", async () => {
    const workspace = makeTmpDir();
    setupWorkspace(workspace, makeMinimalFlow());

    // Write a real CC transcript file at a known path (not planted via normal mechanism)
    const fakeHome = makeTmpDir();
    const sourcePath = join(fakeHome, "known-source.jsonl");
    const entries = makeMinimalCCEntries();
    writeFileSync(sourcePath, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      // Use a bogus agent_id that findAgentTranscript would never resolve,
      // but provide source_path — capture should still succeed.
      const result = await captureTranscript({
        agent_id: "bogus-agent-id-that-does-not-exist",
        agent_type: "engineer",
        projectDir: workspace,
        source_path: sourcePath,
        step_id: "build",
        workspace,
      });

      assertOk(result);
      expect(result.warning).toBeUndefined();
      expect(result.entry_count).toBe(2);
      expect(result.transcript_path).toContain(join(workspace, "transcripts"));
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("non-completed step + source_path + persist_path:true → written AND get_transcript resolves it", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    // Create a synthetic CC JSONL source file
    const fakeHome = makeTmpDir();
    const sourcePath = join(fakeHome, "recovery-source.jsonl");
    const entries = makeMinimalCCEntries();
    writeFileSync(sourcePath, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      // Simulate a recovery call for a "started" (not completed) step
      const result = await captureTranscript({
        agent_id: "recovery-agent",
        agent_type: "engineer",
        persist_path: true,
        projectDir: workspace,
        source_path: sourcePath,
        step_id: "build",
        workspace,
      });

      assertOk(result);
      expect(result.warning).toBeUndefined();
      expect(result.transcript_path).not.toBe("");
      expect(result.entry_count).toBe(2);

      // get_transcript must resolve via the persisted path
      const getResult = await getTranscript({ state_id: "build", workspace });
      assertOk(getResult);
      expect(getResult.entry_count).toBe(2);
      expect(getResult.entries[0].role).toBe("user");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("no persist_path → not resolvable by get_transcript (no double-write on completion path)", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    // Plant a real transcript for the glob scan to find
    const fakeHome = makeTmpDir();
    plantAgentTranscript(fakeHome, AGENT_ID, makeMinimalCCEntries());

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      // Capture WITHOUT persist_path — simulates the completion path
      const result = await captureTranscript({
        agent_id: AGENT_ID,
        agent_type: "engineer",
        projectDir: process.cwd(),
        step_id: "build",
        // persist_path intentionally omitted
        workspace,
      });

      assertOk(result);
      expect(result.entry_count).toBe(2);

      // get_transcript should return TRANSCRIPT_NOT_FOUND — path was NOT persisted
      const getResult = await getTranscript({ state_id: "build", workspace });
      expect(getResult.ok).toBe(false);
      if (!getResult.ok) {
        expect(getResult.error_code).toBe("TRANSCRIPT_NOT_FOUND");
      }
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("persist_path:true — store path recorded and transcript_path non-empty after capture", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const fakeHome = makeTmpDir();
    const sourcePath = join(fakeHome, "persist-check-source.jsonl");
    const entries = makeMinimalCCEntries();
    writeFileSync(sourcePath, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const result = await captureTranscript({
        agent_id: "any-agent",
        agent_type: "engineer",
        persist_path: true,
        projectDir: workspace,
        source_path: sourcePath,
        step_id: "build",
        workspace,
      });

      assertOk(result);
      expect(result.transcript_path).not.toBe("");
      expect(result.entry_count).toBe(2);

      // The store path should now be set — get_transcript resolves without setTranscriptPath
      const store = getExecutionStore(workspace);
      expect(store.getTranscriptPath("build")).toBe(result.transcript_path);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("agent_id omitted + source_path provided → succeeds (cliff-recovery path)", async () => {
    const workspace = makeTmpDir();
    setupWorkspace(workspace, makeMinimalFlow());

    const fakeHome = makeTmpDir();
    const sourcePath = join(fakeHome, "no-agent-id-source.jsonl");
    const entries = makeMinimalCCEntries();
    writeFileSync(sourcePath, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");

    // No agent_id at all — source_path alone must drive the capture.
    const result = await captureTranscript({
      agent_type: "architect",
      persist_path: true,
      projectDir: workspace,
      source_path: sourcePath,
      step_id: "design",
      workspace,
    });

    assertOk(result);
    expect(result.warning).toBeUndefined();
    expect(result.entry_count).toBe(2);
    expect(result.transcript_path).not.toBe("");
  });

  it("agent_id and source_path both omitted → best-effort warning, never an error", async () => {
    const workspace = makeTmpDir();
    setupWorkspace(workspace, makeMinimalFlow());

    const result = await captureTranscript({
      agent_type: "architect",
      projectDir: workspace,
      step_id: "design",
      workspace,
    });

    assertOk(result);
    expect(result.warning).toContain("no source_path or agent_id provided");
    expect(result.entry_count).toBe(0);
    expect(result.transcript_path).toBe("");
  });
});
