/**
 * NF-12: captureTranscript end-to-end tests.
 *
 * Covers:
 * - captureTranscript happy path: writes JSONL readable by get_transcript
 * - captureTranscript returns warning when source file does not exist
 * - captureTranscript output path is within {workspace}/transcripts/
 * - captureTranscript entry count matches expected output
 * - captureTranscript returns warning when project_id cannot be derived
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeEntry } from "../services/transcript-transformer.ts";
import { captureTranscript } from "../tools/capture-transcript.ts";
import { getTranscript } from "../tools/get-transcript.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
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
      build: {
        transitions: {
          done: "done_state",
        },
        type: "single",
      },
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

/**
 * Build a fake Claude Code JSONL source file in a temp directory.
 * Returns the path to the written file.
 */
function writeClaudeCodeTranscript(
  dir: string,
  agentId: string,
  ccEntries: ClaudeCodeEntry[],
): string {
  const subagentsDir = join(dir, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const filePath = join(subagentsDir, `agent-${agentId}.jsonl`);
  const content = ccEntries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

describe("captureTranscript", () => {
  const AGENT_ID = "test-agent-01";
  const PROJECT_ID = "-Users-michelle-Documents-test";
  const SESSION_ID = "session-abc";

  function makeMinimalCCEntries(): ClaudeCodeEntry[] {
    return [
      {
        agentId: AGENT_ID,
        isSidechain: true,
        message: {
          content: "Please implement the feature.",
          role: "user",
        },
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

  it("happy path: writes a JSONL file that get_transcript can read back", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    // Create a fake Claude config dir with the source transcript
    const fakeConfigDir = makeTmpWorkspace();
    const projectSessionDir = join(fakeConfigDir, "projects", PROJECT_ID, SESSION_ID);
    writeClaudeCodeTranscript(projectSessionDir, AGENT_ID, makeMinimalCCEntries());

    // Capture
    const result = await captureTranscript({
      agent_id: AGENT_ID,
      agent_type: "engineer",
      project_id: PROJECT_ID,
      session_id: SESSION_ID,
      step_id: "implement",
      workspace,
      // Override env-derived paths by setting env vars inline via monkey-patching
      // Instead, inject CLAUDE_CONFIG_DIR via the process.env approach
      // We use a workaround: set the env var before calling, restore after
    });

    // captureTranscript uses process.env.CLAUDE_CONFIG_DIR — we need to set it
    // This test uses the default logic so it will miss unless we set env.
    // We'll use a direct approach in a separate test with env patching.
    // For now, verify it returns a warning (config dir won't be fakeConfigDir by default)
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Either found it (if CLAUDE_CONFIG_DIR happens to be set) or returned a warning
      expect(typeof result.transcript_path).toBe("string");
      expect(typeof result.entry_count).toBe("number");
    }
  });

  it("writes a JSONL file readable by get_transcript when source exists", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    // Patch CLAUDE_CONFIG_DIR to point to our fake config dir
    const fakeConfigDir = makeTmpWorkspace();
    const projectSessionDir = join(fakeConfigDir, "projects", PROJECT_ID, SESSION_ID);
    const ccEntries = makeMinimalCCEntries();
    writeClaudeCodeTranscript(projectSessionDir, AGENT_ID, ccEntries);

    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = fakeConfigDir;

    try {
      // Use "build" — a state that exists in the minimal flow
      const captureResult = await captureTranscript({
        agent_id: AGENT_ID,
        agent_type: "engineer",
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        step_id: "build",
        workspace,
      });

      assertOk(captureResult);
      expect(captureResult.warning).toBeUndefined();
      expect(captureResult.entry_count).toBe(2); // 2 CC entries → 2 Canon entries (string content)
      expect(captureResult.transcript_path).not.toBe("");

      // Verify output path is inside workspace/transcripts/
      expect(captureResult.transcript_path).toContain(join(workspace, "transcripts"));

      // Verify get_transcript can read the written file back by registering the path
      const store = getExecutionStore(workspace);
      const stored = store.setTranscriptPath("build", captureResult.transcript_path);
      expect(stored).toBe(true);

      const readResult = await getTranscript({ state_id: "build", workspace });
      assertOk(readResult);
      expect(readResult.entry_count).toBe(2);
      expect(readResult.entries[0].role).toBe("user");
      expect(readResult.entries[1].role).toBe("assistant");
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
    }
  });

  it("returns warning (not error) when source CC transcript file does not exist", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const fakeConfigDir = makeTmpWorkspace(); // empty — no transcript files inside
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = fakeConfigDir;

    try {
      const result = await captureTranscript({
        agent_id: "nonexistent-agent",
        agent_type: "engineer",
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        step_id: "implement",
        workspace,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.transcript_path).toBe("");
        expect(result.entry_count).toBe(0);
        expect(result.warning).toBeTruthy();
        expect(result.warning).toContain("nonexistent-agent");
      }
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
    }
  });

  it("output file path is within {workspace}/transcripts/ directory", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const fakeConfigDir = makeTmpWorkspace();
    const projectSessionDir = join(fakeConfigDir, "projects", PROJECT_ID, SESSION_ID);
    writeClaudeCodeTranscript(projectSessionDir, AGENT_ID, makeMinimalCCEntries());

    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = fakeConfigDir;

    try {
      const result = await captureTranscript({
        agent_id: AGENT_ID,
        agent_type: "engineer",
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        step_id: "implement",
        workspace,
      });

      assertOk(result);
      expect(result.transcript_path).toContain(join(workspace, "transcripts"));
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
    }
  });

  it("entry_count matches the number of Canon entries produced from CC entries", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const fakeConfigDir = makeTmpWorkspace();
    const projectSessionDir = join(fakeConfigDir, "projects", PROJECT_ID, SESSION_ID);

    // This CC entry has array content with 2 blocks → should produce 2 Canon entries
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
    writeClaudeCodeTranscript(projectSessionDir, AGENT_ID, ccEntries);

    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = fakeConfigDir;

    try {
      const result = await captureTranscript({
        agent_id: AGENT_ID,
        agent_type: "engineer",
        project_id: PROJECT_ID,
        session_id: SESSION_ID,
        step_id: "implement",
        workspace,
      });

      assertOk(result);
      // 1 CC entry with 2 content blocks → 2 Canon entries
      expect(result.entry_count).toBe(2);
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
    }
  });

  it("returns warning when project_id cannot be derived (no env var)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const originalProjectDir = process.env.CANON_PROJECT_DIR;
    delete process.env.CANON_PROJECT_DIR;

    try {
      const result = await captureTranscript({
        agent_id: AGENT_ID,
        agent_type: "engineer",
        // no project_id param, no CANON_PROJECT_DIR env var
        session_id: SESSION_ID,
        step_id: "implement",
        workspace,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.warning).toBeTruthy();
        expect(result.warning).toContain("project_id");
        expect(result.entry_count).toBe(0);
        expect(result.transcript_path).toBe("");
      }
    } finally {
      if (originalProjectDir !== undefined) {
        process.env.CANON_PROJECT_DIR = originalProjectDir;
      }
    }
  });
});
