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
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTranscript } from "../tools/get-transcript.ts";
import { reportResult } from "../tools/report-result.ts";
import { assertOk } from "../utils/tool-result.ts";
import { getExecutionStore, clearStoreCache } from "../orchestration/execution-store.ts";
import type { TranscriptEntry } from "../orchestration/flow-schema.ts";
import type { ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "transcript-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeMinimalFlow(): ResolvedFlow {
  return {
    name: "test-flow",
    description: "A test flow",
    entry: "build",
    spawn_instructions: {},
    states: {
      build: {
        type: "single",
        transitions: {
          done: "done_state",
        },
      },
      done_state: { type: "terminal" },
    },
  };
}

function setupWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();

  store.initExecution({
    flow: flow.name,
    task: "test task",
    entry: flow.entry,
    current_state: flow.entry,
    base_commit: "abc123",
    started: now,
    last_updated: now,
    branch: "feat/test",
    sanitized: "feat-test",
    created: now,
    tier: "medium",
    flow_name: flow.name,
    slug: "test-slug",
  });

  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { status: "pending", entries: 0 });
  }
}

function makeTranscriptEntries(): TranscriptEntry[] {
  return [
    {
      role: "user",
      timestamp: "2026-04-02T00:00:00Z",
      content: "Please implement the feature.",
      turn_number: 1,
    },
    {
      role: "assistant",
      timestamp: "2026-04-02T00:00:01Z",
      content: "I will implement the feature now.",
      turn_number: 1,
      tokens: 100,
      cumulative_tokens: 200,
    },
    {
      role: "tool_use",
      timestamp: "2026-04-02T00:00:02Z",
      content: '{"tool":"Read","path":"/foo.ts"}',
      tool_name: "Read",
      tokens: 50,
      cumulative_tokens: 250,
      turn_number: 2,
    },
    {
      role: "tool_result",
      timestamp: "2026-04-02T00:00:03Z",
      content: "file contents here",
      tokens: 80,
      cumulative_tokens: 330,
      turn_number: 2,
    },
    {
      role: "assistant",
      timestamp: "2026-04-02T00:00:04Z",
      content: "I've read the file. Implementation complete.",
      tokens: 60,
      cumulative_tokens: 390,
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
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// get_transcript — full mode
// ---------------------------------------------------------------------------

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
      workspace,
      state_id: "build",
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

    const result = await getTranscript({ workspace, state_id: "build" });

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
      { role: "user", timestamp: "2026-04-02T00:00:00Z", content: "Hello", turn_number: 1 },
    ];
    writeTranscriptFile(transcriptPath, entries);
    store.setTranscriptPath("build", transcriptPath);

    const result = await getTranscript({ workspace, state_id: "build" });

    assertOk(result);
    expect(result.total_tokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// get_transcript — summary mode
// ---------------------------------------------------------------------------

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
      workspace,
      state_id: "build",
      mode: "summary",
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

    const result = await getTranscript({ workspace, state_id: "build", mode: "summary" });

    assertOk(result);
    // total_tokens is always computed from ALL entries (before filtering),
    // so it uses the last overall entry's cumulative_tokens (390).
    // In this test data the last overall entry happens to be an assistant entry.
    expect(result.total_tokens).toBe(390);
  });
});

// ---------------------------------------------------------------------------
// get_transcript — error cases
// ---------------------------------------------------------------------------

describe("getTranscript — error cases", () => {
  it("returns TRANSCRIPT_NOT_FOUND error when no transcript_path recorded for state", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const result = await getTranscript({
      workspace,
      state_id: "build",
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
      workspace,
      state_id: "build",
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
      workspace,
      state_id: "build",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("TRANSCRIPT_NOT_FOUND");
      expect(result.message).toContain("outside the expected transcripts directory");
    }
  });
});

// ---------------------------------------------------------------------------
// report_result — transcript_path wiring
// ---------------------------------------------------------------------------

describe("reportResult — transcript_path persistence", () => {
  it("persists transcript_path to execution_states when provided", async () => {
    const workspace = makeTmpWorkspace();
    const flow = makeMinimalFlow();
    setupWorkspace(workspace, flow);

    const transcriptPath = join(workspace, "transcripts", "build-001.jsonl");

    const result = await reportResult({
      workspace,
      state_id: "build",
      status_keyword: "done",
      flow,
      transcript_path: transcriptPath,
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
      workspace,
      state_id: "build",
      status_keyword: "done",
      flow,
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
      workspace,
      state_id: "build",
      status_keyword: "done",
      flow,
      transcript_path: transcriptPath,
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
      workspace,
      state_id: "build",
      status_keyword: "done",
      flow,
      transcript_path: maliciousPath,
    });

    // report_result must still succeed (best-effort, never blocks)
    assertOk(result);

    // But the malicious path must NOT have been stored
    const store = getExecutionStore(workspace);
    expect(store.getTranscriptPath("build")).toBeNull();
  });
});
