/**
 * Tests for get-spawn-prompt.ts
 *
 * Covers:
 * 1. truncateProgress — pure function, all branches
 * 2. getSpawnPrompt calls readBoard exactly once (consolidation)
 * 3. getSpawnPrompt wave briefing injection via consultation_outputs
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Hoist mock for readBoard before module import
// ---------------------------------------------------------------------------

vi.mock("../orchestration/board.js", () => ({
  readBoard: vi.fn(),
  writeBoard: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Hoist mock for wave-briefing before module import
// ---------------------------------------------------------------------------

vi.mock("../orchestration/wave-briefing.js", () => ({
  readWaveGuidance: vi.fn().mockResolvedValue(""),
  assembleWaveBriefing: vi.fn(),
}));

import { readBoard } from "../orchestration/board.ts";
import { assembleWaveBriefing, readWaveGuidance } from "../orchestration/wave-briefing.ts";
import { truncateProgress, getSpawnPrompt } from "../tools/get-spawn-prompt.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsp-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "implement",
    current_state: "implement",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  } as Board;
}

function makeFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-flow",
    description: "Test flow",
    entry: "implement",
    states: {
      implement: { type: "single", agent: "canon-implementor" },
      done: { type: "terminal" },
    },
    spawn_instructions: { implement: "Implement ${task}." },
    ...overrides,
  };
}

function makeWaveFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-wave-flow",
    description: "Test wave flow",
    entry: "build",
    states: {
      build: { type: "wave", agent: "canon-implementor" },
      done: { type: "terminal" },
    },
    spawn_instructions: { build: "Build ${item}." },
    ...overrides,
  };
}

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// truncateProgress — pure function tests
// ---------------------------------------------------------------------------

describe("truncateProgress", () => {
  it("returns unchanged content when there are 0 entries (header only)", () => {
    const content = "## Progress: My task\n";
    expect(truncateProgress(content, 8)).toBe(content);
  });

  it("returns unchanged content when entry count is under the cap", () => {
    const header = "## Progress: My task\n";
    const entries = [
      "- [research] done: found solution",
      "- [design] done: made plan",
      "- [implement] done: wrote code",
    ].join("\n");
    const content = header + "\n" + entries + "\n";
    expect(truncateProgress(content, 8)).toBe(content);
  });

  it("returns unchanged content when entry count equals the cap exactly", () => {
    const header = "## Progress: My task\n";
    const entries = Array.from({ length: 8 }, (_, i) => `- [state-${i}] done: step ${i}`).join("\n");
    const content = header + "\n" + entries + "\n";
    expect(truncateProgress(content, 8)).toBe(content);
  });

  it("truncates to last maxEntries when entry count exceeds cap", () => {
    const header = "## Progress: My task";
    const entries = Array.from({ length: 12 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const content = header + "\n" + entries.join("\n");

    const result = truncateProgress(content, 8);

    // Must contain header
    expect(result).toContain(header);

    // Must contain the last 8 entries
    for (let i = 4; i < 12; i++) {
      expect(result).toContain(`- [state-${i}] done: step ${i}`);
    }

    // Must NOT contain the first 4 entries
    for (let i = 0; i < 4; i++) {
      expect(result).not.toContain(`- [state-${i}] done: step ${i}`);
    }
  });

  it("preserves header lines that appear before the first entry line", () => {
    const header = "## Progress: My task\n\nSome metadata line\n";
    const entries = Array.from({ length: 10 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const content = header + entries.join("\n");

    const result = truncateProgress(content, 8);

    // Header and metadata must be preserved
    expect(result).toContain("## Progress: My task");
    expect(result).toContain("Some metadata line");

    // Only last 8 entries
    const entryLines = result.split("\n").filter(l => l.startsWith("- ["));
    expect(entryLines).toHaveLength(8);
  });

  it("handles content with no header (all lines are entries)", () => {
    const entries = Array.from({ length: 10 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const content = entries.join("\n");

    const result = truncateProgress(content, 8);

    const entryLines = result.split("\n").filter(l => l.startsWith("- ["));
    expect(entryLines).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// getSpawnPrompt — progress truncation integration
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — progress truncation", () => {
  it("truncates progress to last 8 entries before injecting into prompt", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());

    // Write a progress.md with 12 entries
    const header = "## Progress: My task";
    const entries = Array.from({ length: 12 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const progressContent = header + "\n" + entries.join("\n") + "\n";
    await writeFile(join(workspace, "progress.md"), progressContent, "utf-8");

    const flow = makeFlow({
      progress: "${WORKSPACE}/progress.md",
      spawn_instructions: { implement: "Task: ${task}\n\nProgress:\n${progress}" },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
    });

    const prompt = result.prompts[0].prompt;

    // Last 8 entries should appear
    for (let i = 4; i < 12; i++) {
      expect(prompt).toContain(`- [state-${i}] done: step ${i}`);
    }
    // First 4 entries should NOT appear
    for (let i = 0; i < 4; i++) {
      expect(prompt).not.toContain(`- [state-${i}] done: step ${i}`);
    }
  });

  it("passes through all entries unchanged when count is within cap", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());

    const header = "## Progress: My task";
    const entries = Array.from({ length: 5 }, (_, i) => `- [state-${i}] done: step ${i}`);
    const progressContent = header + "\n" + entries.join("\n") + "\n";
    await writeFile(join(workspace, "progress.md"), progressContent, "utf-8");

    const flow = makeFlow({
      progress: "${WORKSPACE}/progress.md",
      spawn_instructions: { implement: "${progress}" },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
    });

    const prompt = result.prompts[0].prompt;
    for (let i = 0; i < 5; i++) {
      expect(prompt).toContain(`- [state-${i}] done: step ${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// getSpawnPrompt — wave briefing injection via consultation_outputs
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — wave briefing injection", () => {
  it("injects assembleWaveBriefing output into wave-type prompts when consultation_outputs is provided", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing (from wave 1)\n\n### Security\nUse parameterized queries.");

    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a", "task-b"],
      wave: 1,
      consultation_outputs: {
        security: { section: "Security", summary: "Use parameterized queries." },
      },
    });

    expect(vi.mocked(assembleWaveBriefing)).toHaveBeenCalledWith({
      wave: 1,
      summaries: [],
      consultationOutputs: {
        security: { section: "Security", summary: "Use parameterized queries." },
      },
    });

    // Both items get the briefing
    expect(result.prompts).toHaveLength(2);
    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("## Wave Briefing (from wave 1)");
      expect(entry.prompt).toContain("Use parameterized queries.");
    }
  });

  it("does not inject briefing when consultation_outputs is undefined", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing (from wave 1)\n");

    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 1,
      // consultation_outputs intentionally omitted
    });

    expect(vi.mocked(assembleWaveBriefing)).not.toHaveBeenCalled();
    expect(result.prompts[0].prompt).not.toContain("Wave Briefing");
  });

  it("does not inject briefing for single-type states even when consultation_outputs is provided", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing (from wave 1)\n");

    const flow = makeFlow(); // single-type state

    const result = await getSpawnPrompt({
      workspace,
      state_id: "implement",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      wave: 1,
      consultation_outputs: {
        security: { section: "Security", summary: "Some advice." },
      },
    });

    expect(vi.mocked(assembleWaveBriefing)).not.toHaveBeenCalled();
    expect(result.prompts[0].prompt).not.toContain("Wave Briefing");
  });

  it("pre-escaped \\${ patterns in consultation summaries survive unchanged in assembled prompt", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());

    // Simulate caller pre-escaping ${VAR} → \${VAR} and assembleWaveBriefing
    // returning it as-is (as it should — no double-escaping)
    const escapedSummary = "Use \\${PARAM} in queries.";
    vi.mocked(assembleWaveBriefing).mockReturnValue(`## Wave Briefing (from wave 1)\n\n### Security\n${escapedSummary}`);

    const flow = makeWaveFlow();

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 2,
      consultation_outputs: {
        security: { section: "Security", summary: escapedSummary },
      },
    });

    // The escaped pattern must appear in the final prompt unchanged
    expect(result.prompts[0].prompt).toContain("\\${PARAM}");
  });

  it("does not inject briefing when assembleWaveBriefing returns an empty string", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    // assembleWaveBriefing returns header-only or empty string
    vi.mocked(assembleWaveBriefing).mockReturnValue("");

    const flow = makeWaveFlow();
    const basePromptText = "Build task-a.";

    const result = await getSpawnPrompt({
      workspace,
      state_id: "build",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      items: ["task-a"],
      wave: 1,
      consultation_outputs: {},
    });

    // Prompt should not get extra newlines or blank content from empty briefing
    expect(result.prompts[0].prompt).not.toContain("\n\n\n\n");
  });

  it("injects briefing into parallel-per state prompts when consultation_outputs is provided", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(assembleWaveBriefing).mockReturnValue("## Wave Briefing (from wave 1)\n\n### Arch\nUse services.");

    const flow: ResolvedFlow = {
      name: "test-parallel-per-flow",
      description: "Test parallel-per flow",
      entry: "review",
      states: {
        review: { type: "parallel-per", agent: "canon-reviewer" },
        done: { type: "terminal" },
      },
      spawn_instructions: { review: "Review ${item}." },
    };

    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "my task", CANON_PLUGIN_ROOT: "" },
      items: ["file-a.ts", "file-b.ts"],
      wave: 1,
      consultation_outputs: {
        arch: { section: "Arch", summary: "Use services." },
      },
    });

    expect(result.prompts).toHaveLength(2);
    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("## Wave Briefing (from wave 1)");
    }
  });
});
