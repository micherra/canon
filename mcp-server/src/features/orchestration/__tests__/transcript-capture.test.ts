import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCodeEntry } from "../services/transcript-transformer.ts";
import { captureTranscript } from "../tools/capture-transcript.ts";
import { getTranscript } from "../tools/get-transcript.ts";

// Mock server-state so captureTranscript uses the fake project dir set per-test.
vi.mock("../../../app/server-state.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../app/server-state.ts")>();
  return {
    ...actual,
    get projectDir() {
      return mockProjectDir;
    },
  };
});

// Mutable variable updated by each test before calling captureTranscript.
let mockProjectDir = process.cwd();

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "capture-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeMinimalFlow(): ResolvedFlow {
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

function setupWorkspace(workspace: string, flow: ResolvedFlow): void {
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
  projectDir?: string,
): void {
  const pid = (projectDir ?? mockProjectDir).replace(/\//g, "-");
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
  it("uses projectDir from server-state (not process.cwd) to derive the project path", async () => {
    const workspace = makeTmpDir();
    setupWorkspace(workspace, makeMinimalFlow());

    const fakeHome = makeTmpDir();
    // Use a fake project dir that differs from process.cwd()
    const fakeProjectDir = "/Users/fake/my-project";
    mockProjectDir = fakeProjectDir;

    // Plant the transcript under the fake project dir path
    plantAgentTranscript(fakeHome, AGENT_ID, makeMinimalCCEntries(), fakeProjectDir);

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const result = await captureTranscript({
        agent_id: AGENT_ID,
        agent_type: "engineer",
        step_id: "build",
        workspace,
      });

      assertOk(result);
      // Should find the transcript at the fakeProjectDir-derived path, not process.cwd()
      expect(result.warning).toBeUndefined();
      expect(result.entry_count).toBe(2);
    } finally {
      process.env.HOME = originalHome;
      mockProjectDir = process.cwd();
    }
  });

  it("captures transcript and writes JSONL readable by get_transcript", async () => {
    const workspace = makeTmpDir();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const fakeHome = makeTmpDir();
    plantAgentTranscript(fakeHome, AGENT_ID, makeMinimalCCEntries());

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const result = await captureTranscript({
        agent_id: AGENT_ID,
        agent_type: "engineer",
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
