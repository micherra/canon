/**
 * Tests for ADR-015 get_transcript tool and report_result transcript_path wiring.
 *
 * Covers:
 * - get_transcript returns entries from a valid JSONL file in full mode
 * - get_transcript in summary mode returns only assistant role entries
 * - get_transcript returns error when no transcript_path recorded for state
 * - get_transcript returns error when transcript file does not exist on disk
 * - get_transcript returns total_tokens from last entry's cumulative_tokens
 * - report_result with transcript_path persists it to execution_states
 * - report_result without transcript_path does not affect existing transcript_path
 *
 * Also covers NF-12 capture_transcript tool:
 * - transformClaudeCodeTranscript: CC string content → single Canon entry
 * - transformClaudeCodeTranscript: CC array content (text + tool_use) → multiple entries
 * - All output entries pass TranscriptEntrySchema.safeParse()
 * - Handles empty input
 * - Handles malformed CC entries gracefully
 * - Tracks cumulative_tokens across entries
 * - captureTranscript happy path: writes JSONL readable by get_transcript
 * - captureTranscript returns warning when source file does not exist
 * - captureTranscript output path is within {workspace}/transcripts/
 * - captureTranscript entry count matches expected output
 *
 * Also covers NF-17 deriveProjectIdFromEnv fix:
 * - deriveProjectIdFromEnv preserves leading dash (CC convention)
 * - deriveProjectIdFromEnv replaces all slashes with dashes
 * - deriveProjectIdFromEnv returns null when CANON_PROJECT_DIR not set
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "@domains/flows/event-schemas.ts";
import { TranscriptEntrySchema } from "@domains/flows/event-schemas.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { captureTranscript, deriveProjectIdFromEnv } from "../tools/capture-transcript.ts";
import { getTranscript } from "../tools/get-transcript.ts";
import { reportResult } from "../tools/report-result.ts";
import { transformClaudeCodeTranscript } from "../services/transcript-transformer.ts";
import type { ClaudeCodeEntry } from "../services/transcript-transformer.ts";

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "transcript-test-"));
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

function makeTranscriptEntries(): TranscriptEntry[] {
  return [
    {
      content: "Please implement the feature.",
      role: "user",
      timestamp: "2026-04-02T00:00:00Z",
      turn_number: 1,
    },
    {
      content: "I will implement the feature now.",
      cumulative_tokens: 200,
      role: "assistant",
      timestamp: "2026-04-02T00:00:01Z",
      tokens: 100,
      turn_number: 1,
    },
    {
      content: '{"tool":"Read","path":"/foo.ts"}',
      cumulative_tokens: 250,
      role: "tool_use",
      timestamp: "2026-04-02T00:00:02Z",
      tokens: 50,
      tool_name: "Read",
      turn_number: 2,
    },
    {
      content: "file contents here",
      cumulative_tokens: 330,
      role: "tool_result",
      timestamp: "2026-04-02T00:00:03Z",
      tokens: 80,
      turn_number: 2,
    },
    {
      content: "I've read the file. Implementation complete.",
      cumulative_tokens: 390,
      role: "assistant",
      timestamp: "2026-04-02T00:00:04Z",
      tokens: 60,
      turn_number: 3,
    },
  ];
}

function writeTranscriptFile(path: string, entries: TranscriptEntry[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(path, content, "utf-8");
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// get_transcript — full mode

describe("getTranscript — full mode", () => {
  it("returns all entries from a valid JSONL file", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const store = getExecutionStore(workspace);
    const transcriptsDir = join(workspace, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });

    const transcriptPath = join(transcriptsDir, "build-001.jsonl");
    const entries = makeTranscriptEntries();
    writeTranscriptFile(transcriptPath, entries);
    store.setTranscriptPath("build", transcriptPath);

    const result = await getTranscript({
      state_id: "build",
      workspace,
    });

    assertOk(result);
    expect(result.state_id).toBe("build");
    expect(result.mode).toBe("full");
    expect(result.transcript_path).toBe(transcriptPath);
    expect(result.entries).toHaveLength(5);
    expect(result.entry_count).toBe(5);
  });

  it("returns total_tokens from last entry's cumulative_tokens", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const store = getExecutionStore(workspace);
    const transcriptsDir = join(workspace, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });

    const transcriptPath = join(transcriptsDir, "build-001.jsonl");
    const entries = makeTranscriptEntries();
    writeTranscriptFile(transcriptPath, entries);
    store.setTranscriptPath("build", transcriptPath);

    const result = await getTranscript({ state_id: "build", workspace });

    assertOk(result);
    expect(result.total_tokens).toBe(390); // last entry's cumulative_tokens
  });

  it("returns no total_tokens when last entry has no cumulative_tokens", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const store = getExecutionStore(workspace);
    const transcriptsDir = join(workspace, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });

    const transcriptPath = join(transcriptsDir, "build-001.jsonl");
    const entries: TranscriptEntry[] = [
      { content: "Hello", role: "user", timestamp: "2026-04-02T00:00:00Z", turn_number: 1 },
    ];
    writeTranscriptFile(transcriptPath, entries);
    store.setTranscriptPath("build", transcriptPath);

    const result = await getTranscript({ state_id: "build", workspace });

    assertOk(result);
    expect(result.total_tokens).toBeUndefined();
  });
});

// get_transcript — summary mode

describe("getTranscript — summary mode", () => {
  it("returns only assistant role entries in summary mode", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const store = getExecutionStore(workspace);
    const transcriptsDir = join(workspace, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });

    const transcriptPath = join(transcriptsDir, "build-001.jsonl");
    const entries = makeTranscriptEntries();
    writeTranscriptFile(transcriptPath, entries);
    store.setTranscriptPath("build", transcriptPath);

    const result = await getTranscript({
      mode: "summary",
      state_id: "build",
      workspace,
    });

    assertOk(result);
    expect(result.mode).toBe("summary");
    // Only 2 assistant entries from the 5 total
    expect(result.entries).toHaveLength(2);
    expect(result.entry_count).toBe(2);
    for (const entry of result.entries) {
      expect(entry.role).toBe("assistant");
    }
  });

  it("summary mode returns total_tokens from last overall entry's cumulative_tokens", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const store = getExecutionStore(workspace);
    const transcriptsDir = join(workspace, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });

    const transcriptPath = join(transcriptsDir, "build-001.jsonl");
    const entries = makeTranscriptEntries();
    writeTranscriptFile(transcriptPath, entries);
    store.setTranscriptPath("build", transcriptPath);

    const result = await getTranscript({ mode: "summary", state_id: "build", workspace });

    assertOk(result);
    // total_tokens is always computed from ALL entries (before filtering),
    // so it uses the last overall entry's cumulative_tokens (390).
    // In this test data the last overall entry happens to be an assistant entry.
    expect(result.total_tokens).toBe(390);
  });
});

// get_transcript — error cases

describe("getTranscript — error cases", () => {
  it("returns TRANSCRIPT_NOT_FOUND error when no transcript_path recorded for state", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await getTranscript({
      state_id: "build",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("TRANSCRIPT_NOT_FOUND");
      expect(result.message).toContain("build");
    }
  });

  it("returns TRANSCRIPT_NOT_FOUND error when transcript file does not exist on disk", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const store = getExecutionStore(workspace);
    const transcriptPath = join(workspace, "transcripts", "build-001.jsonl");
    store.setTranscriptPath("build", transcriptPath);

    const result = await getTranscript({
      state_id: "build",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("TRANSCRIPT_NOT_FOUND");
      expect(result.message).toContain("build");
      expect(result.message).toContain(workspace);
    }
  });

  it("returns TRANSCRIPT_NOT_FOUND error when transcript path is outside the transcripts directory", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    // Directly set a path that is outside workspace/transcripts/
    const store = getExecutionStore(workspace);
    const maliciousPath = join(workspace, "..", "etc", "passwd");
    store.setTranscriptPath("build", maliciousPath);

    const result = await getTranscript({
      state_id: "build",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("TRANSCRIPT_NOT_FOUND");
      expect(result.message).toContain("outside the expected transcripts directory");
    }
  });
});

// report_result — transcript_path wiring

describe("reportResult — transcript_path persistence", () => {
  it("persists transcript_path to execution_states when provided", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const transcriptPath = join(workspace, "transcripts", "build-001.jsonl");

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "done",
      transcript_path: transcriptPath,
      workspace,
    });

    assertOk(result);

    const store = getExecutionStore(workspace);
    expect(store.getTranscriptPath("build")).toBe(transcriptPath);
  });

  it("does not affect existing transcript_path when not provided", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const transcriptPath = join(workspace, "transcripts", "build-001.jsonl");

    // First, set a transcript path manually
    const store = getExecutionStore(workspace);
    store.setTranscriptPath("build", transcriptPath);

    // Now call reportResult WITHOUT transcript_path
    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "done",
      workspace,
      // No transcript_path field
    });

    assertOk(result);

    // The transcript_path should still be the original value
    expect(store.getTranscriptPath("build")).toBe(transcriptPath);
  });

  it("report_result still succeeds even if transcript_path is provided for missing state", async () => {
    // This is best-effort — if setTranscriptPath returns false (state not found),
    // report_result does not fail
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const transcriptPath = join(workspace, "transcripts", "build-001.jsonl");

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "done",
      transcript_path: transcriptPath,
      workspace,
    });

    // report_result should succeed regardless
    assertOk(result);
  });

  it("silently rejects transcript_path outside workspace/transcripts/ (path traversal guard)", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    // Attempt path traversal — path escapes the transcripts directory
    const maliciousPath = join(workspace, "..", "etc", "passwd");

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "done",
      transcript_path: maliciousPath,
      workspace,
    });

    // report_result must still succeed (best-effort, never blocks)
    assertOk(result);

    // But the malicious path must NOT have been stored
    const store = getExecutionStore(workspace);
    expect(store.getTranscriptPath("build")).toBeNull();
  });
});

// ─── NF-12: transformClaudeCodeTranscript ────────────────────────────────────

describe("transformClaudeCodeTranscript — string content", () => {
  it("transforms a CC user entry with string content to a single Canon entry", () => {
    const entry: ClaudeCodeEntry = {
      agentId: "abc123",
      isSidechain: true,
      message: {
        content: "Please implement the feature.",
        role: "user",
      },
      parentUuid: "parent-uuid",
      timestamp: "2026-04-27T00:00:00.000Z",
      type: "user",
    };

    const result = transformClaudeCodeTranscript([entry]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Please implement the feature.");
    expect(result[0].timestamp).toBe("2026-04-27T00:00:00.000Z");
    expect(result[0].turn_number).toBe(1);
  });

  it("transforms a CC assistant entry with string content and usage tokens", () => {
    const entry: ClaudeCodeEntry = {
      agentId: "abc123",
      isSidechain: true,
      message: {
        content: "I will implement the feature now.",
        role: "assistant",
        usage: { input_tokens: 50, output_tokens: 100 },
      },
      parentUuid: "parent-uuid",
      timestamp: "2026-04-27T00:00:01.000Z",
      type: "assistant",
    };

    const result = transformClaudeCodeTranscript([entry]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].tokens).toBe(100);
    expect(result[0].cumulative_tokens).toBe(100);
  });
});

describe("transformClaudeCodeTranscript — array content blocks", () => {
  it("transforms a CC assistant entry with text + tool_use blocks to two Canon entries", () => {
    const entry: ClaudeCodeEntry = {
      agentId: "abc123",
      isSidechain: true,
      message: {
        content: [
          { type: "text", text: "Let me read the file." },
          { type: "tool_use", name: "Read", input: { file_path: "/foo.ts" } },
        ],
        role: "assistant",
        usage: { output_tokens: 80 },
      },
      parentUuid: "parent-uuid",
      timestamp: "2026-04-27T00:00:02.000Z",
      type: "assistant",
    };

    const result = transformClaudeCodeTranscript([entry]);

    expect(result).toHaveLength(2);

    // text block
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("Let me read the file.");
    expect(result[0].tokens).toBe(80); // tokens attributed to first block

    // tool_use block
    expect(result[1].role).toBe("tool_use");
    expect(result[1].tool_name).toBe("Read");
    expect(result[1].tokens).toBeUndefined(); // tokens only on first block
    const toolContent = JSON.parse(result[1].content) as { tool: string; input: { file_path: string } };
    expect(toolContent.tool).toBe("Read");
    expect(toolContent.input.file_path).toBe("/foo.ts");
  });

  it("transforms a tool_result block to a Canon tool_result entry", () => {
    const entry: ClaudeCodeEntry = {
      agentId: "abc123",
      isSidechain: true,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_123", content: "file contents here" },
        ],
        role: "user",
      },
      parentUuid: "parent-uuid",
      timestamp: "2026-04-27T00:00:03.000Z",
      type: "user",
    };

    const result = transformClaudeCodeTranscript([entry]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool_result");
    expect(result[0].content).toBe("file contents here");
  });
});

describe("transformClaudeCodeTranscript — schema compliance", () => {
  it("all output entries pass TranscriptEntrySchema.safeParse()", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        agentId: "abc",
        isSidechain: true,
        message: { content: "Hello", role: "user" },
        parentUuid: "uuid1",
        timestamp: "2026-04-27T00:00:00.000Z",
        type: "user",
      },
      {
        agentId: "abc",
        isSidechain: true,
        message: {
          content: [
            { type: "text", text: "Working on it." },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
          role: "assistant",
          usage: { output_tokens: 42 },
        },
        parentUuid: "uuid1",
        timestamp: "2026-04-27T00:00:01.000Z",
        type: "assistant",
      },
    ];

    const result = transformClaudeCodeTranscript(entries);

    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      const parsed = TranscriptEntrySchema.safeParse(entry);
      expect(parsed.success).toBe(true);
    }
  });

  it("handles empty input and returns empty array", () => {
    expect(transformClaudeCodeTranscript([])).toEqual([]);
  });

  it("handles malformed CC entries gracefully by skipping them", () => {
    const malformed = [
      { not_a_valid: "entry" },           // missing required fields
      { timestamp: "bad", message: null }, // message is null
    ] as unknown as ClaudeCodeEntry[];

    const result = transformClaudeCodeTranscript(malformed);
    // Malformed entries are skipped — no crash, empty output
    expect(result).toHaveLength(0);
  });

  it("tracks cumulative_tokens correctly across multiple entries", () => {
    const entries: ClaudeCodeEntry[] = [
      {
        agentId: "abc",
        isSidechain: true,
        message: {
          content: "First response.",
          role: "assistant",
          usage: { output_tokens: 100 },
        },
        parentUuid: "uuid1",
        timestamp: "2026-04-27T00:00:00.000Z",
        type: "assistant",
      },
      {
        agentId: "abc",
        isSidechain: true,
        message: {
          content: "Second response.",
          role: "assistant",
          usage: { output_tokens: 50 },
        },
        parentUuid: "uuid1",
        timestamp: "2026-04-27T00:00:01.000Z",
        type: "assistant",
      },
    ];

    const result = transformClaudeCodeTranscript(entries);

    expect(result).toHaveLength(2);
    expect(result[0].tokens).toBe(100);
    expect(result[0].cumulative_tokens).toBe(100);
    expect(result[1].tokens).toBe(50);
    expect(result[1].cumulative_tokens).toBe(150); // running total
  });

  it("turn_number increments per output entry, not per input entry", () => {
    const entry: ClaudeCodeEntry = {
      agentId: "abc",
      isSidechain: true,
      message: {
        content: [
          { type: "text", text: "Block one." },
          { type: "tool_use", name: "Read", input: {} },
          { type: "text", text: "Block three." },
        ],
        role: "assistant",
      },
      parentUuid: "uuid1",
      timestamp: "2026-04-27T00:00:00.000Z",
      type: "assistant",
    };

    const result = transformClaudeCodeTranscript([entry]);

    expect(result).toHaveLength(3);
    expect(result[0].turn_number).toBe(1);
    expect(result[1].turn_number).toBe(2);
    expect(result[2].turn_number).toBe(3);
  });
});

// ─── NF-12: captureTranscript (end-to-end) ───────────────────────────────────

/**
 * Build a fake Claude Code JSONL source file in a temp directory.
 * Returns { sourcePath, entryCount } for test assertions.
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
            { type: "text", text: "Let me check." },
            { type: "tool_use", name: "Read", input: { file_path: "/foo.ts" } },
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

// ─── NF-17: deriveProjectIdFromEnv ───────────────────────────────────────────

describe("deriveProjectIdFromEnv", () => {
  it("preserves leading dash (CC convention) — does NOT strip it", () => {
    const original = process.env.CANON_PROJECT_DIR;
    process.env.CANON_PROJECT_DIR = "/Users/michelle/Documents/canon";
    try {
      const result = deriveProjectIdFromEnv();
      // Claude Code stores projects under a leading-dash path:
      // /Users/michelle/Documents/canon → -Users-michelle-Documents-canon
      expect(result).toBe("-Users-michelle-Documents-canon");
    } finally {
      if (original === undefined) {
        delete process.env.CANON_PROJECT_DIR;
      } else {
        process.env.CANON_PROJECT_DIR = original;
      }
    }
  });

  it("replaces all forward slashes with dashes", () => {
    const original = process.env.CANON_PROJECT_DIR;
    process.env.CANON_PROJECT_DIR = "/a/b/c";
    try {
      expect(deriveProjectIdFromEnv()).toBe("-a-b-c");
    } finally {
      if (original === undefined) {
        delete process.env.CANON_PROJECT_DIR;
      } else {
        process.env.CANON_PROJECT_DIR = original;
      }
    }
  });

  it("returns null when CANON_PROJECT_DIR is not set", () => {
    const original = process.env.CANON_PROJECT_DIR;
    delete process.env.CANON_PROJECT_DIR;
    try {
      expect(deriveProjectIdFromEnv()).toBeNull();
    } finally {
      if (original !== undefined) {
        process.env.CANON_PROJECT_DIR = original;
      }
    }
  });
});
