/**
 * cliff-transcript-capture.test.ts
 *
 * Tests for captureCliffTranscripts — the fail-open effect layer that
 * resolves each incomplete step's transcript source (via
 * resolveCliffTranscriptSource) and, when found, calls the existing
 * captureTranscript service with persist_path: true. Every branch returns a
 * typed outcome; no throw ever escapes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_DIR = "/Users/fake/capture-project";
const SESSION_ID = "session-capture";

let tmpDirs: string[] = [];
let originalHome: string | undefined;

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function subagentsDir(homeDir: string, sessionId: string): string {
  const projectId = PROJECT_DIR.replace(/\//g, "-");
  const dir = join(homeDir, ".claude", "projects", projectId, sessionId, "subagents");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function plantFixture(dir: string, shortType: string, stepId: string): void {
  const path = join(dir, `agent-a${shortType}-${stepId}-jobsfx-hash.jsonl`);
  const entries = [
    {
      agentId: "irrelevant",
      isSidechain: true,
      message: { content: "hello", role: "user" },
      parentUuid: "parent",
      timestamp: "2026-07-06T00:00:00.000Z",
      type: "user",
    },
  ];
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");
}

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../tools/capture-transcript.ts");
  vi.resetModules();
  if (originalHome !== undefined) process.env.HOME = originalHome;
  for (const dir of tmpDirs) rmSync(dir, { force: true, recursive: true });
  tmpDirs = [];
});

describe("captureCliffTranscripts", () => {
  it("captures a real transcript when a fixture source resolves", async () => {
    const { captureCliffTranscripts } = await import("../cliff-transcript-capture.ts");
    const workspace = makeTmpDir("cliff-capture-ws-");
    const homeDir = makeTmpDir("cliff-capture-home-");
    process.env.HOME = homeDir;
    plantFixture(subagentsDir(homeDir, SESSION_ID), "engineer", "implement");

    const outcomes = await captureCliffTranscripts({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      steps: [{ agent_type: "canon:engineer", step_id: "implement" }],
      workspace,
    });

    const outcome = outcomes.get("implement");
    expect(outcome).toBeDefined();
    if (outcome && "transcript_path" in outcome) {
      expect(outcome.transcript_path).toContain(join(workspace, "transcripts"));
    } else {
      throw new Error(`expected transcript_path outcome, got ${JSON.stringify(outcome)}`);
    }
  });

  it("returns a no_source_match outcome when no fixture resolves", async () => {
    const { captureCliffTranscripts } = await import("../cliff-transcript-capture.ts");
    const workspace = makeTmpDir("cliff-capture-ws-");
    const homeDir = makeTmpDir("cliff-capture-home-");
    process.env.HOME = homeDir;
    subagentsDir(homeDir, SESSION_ID); // exists, empty

    const outcomes = await captureCliffTranscripts({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      steps: [{ agent_type: "canon:engineer", step_id: "implement" }],
      workspace,
    });

    expect(outcomes.get("implement")).toEqual({ transcript_uncaptured_reason: "no_source_match" });
  });

  it("returns a no_session_id outcome when sessionId is absent", async () => {
    const { captureCliffTranscripts } = await import("../cliff-transcript-capture.ts");
    const workspace = makeTmpDir("cliff-capture-ws-");

    const outcomes = await captureCliffTranscripts({
      projectDir: PROJECT_DIR,
      steps: [{ agent_type: "canon:engineer", step_id: "implement" }],
      workspace,
    });

    expect(outcomes.get("implement")).toEqual({ transcript_uncaptured_reason: "no_session_id" });
  });

  it("is fail-open: a throwing captureTranscript never escapes and yields capture_failed", async () => {
    vi.doMock("../../tools/capture-transcript.ts", () => ({
      captureTranscript: vi.fn().mockRejectedValue(new Error("boom")),
    }));
    const { captureCliffTranscripts } = await import("../cliff-transcript-capture.ts");

    const workspace = makeTmpDir("cliff-capture-ws-");
    const homeDir = makeTmpDir("cliff-capture-home-");
    process.env.HOME = homeDir;
    plantFixture(subagentsDir(homeDir, SESSION_ID), "engineer", "implement");

    const outcomes = await captureCliffTranscripts({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      steps: [{ agent_type: "canon:engineer", step_id: "implement" }],
      workspace,
    });

    expect(outcomes.get("implement")).toEqual({ transcript_uncaptured_reason: "capture_failed" });
  });

  it("maps a captureTranscript warning result (no transcript_path) to capture_failed", async () => {
    vi.doMock("../../tools/capture-transcript.ts", () => ({
      captureTranscript: vi.fn().mockResolvedValue({
        entry_count: 0,
        ok: true,
        transcript_path: "",
        warning: "source unreadable",
      }),
    }));
    const { captureCliffTranscripts } = await import("../cliff-transcript-capture.ts");

    const workspace = makeTmpDir("cliff-capture-ws-");
    const homeDir = makeTmpDir("cliff-capture-home-");
    process.env.HOME = homeDir;
    plantFixture(subagentsDir(homeDir, SESSION_ID), "engineer", "implement");

    const outcomes = await captureCliffTranscripts({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      steps: [{ agent_type: "canon:engineer", step_id: "implement" }],
      workspace,
    });

    expect(outcomes.get("implement")).toEqual({ transcript_uncaptured_reason: "capture_failed" });
  });

  it("processes multiple steps independently, keyed by step_id", async () => {
    const { captureCliffTranscripts } = await import("../cliff-transcript-capture.ts");
    const workspace = makeTmpDir("cliff-capture-ws-");
    const homeDir = makeTmpDir("cliff-capture-home-");
    process.env.HOME = homeDir;
    const dir = subagentsDir(homeDir, SESSION_ID);
    plantFixture(dir, "engineer", "implement");
    // No fixture for "review" — expect no_source_match for that one.

    const outcomes = await captureCliffTranscripts({
      projectDir: PROJECT_DIR,
      sessionId: SESSION_ID,
      steps: [
        { agent_type: "canon:engineer", step_id: "implement" },
        { agent_type: "canon:reviewer", step_id: "review" },
      ],
      workspace,
    });

    expect(outcomes.size).toBe(2);
    const implementOutcome = outcomes.get("implement");
    expect(implementOutcome && "transcript_path" in implementOutcome).toBe(true);
    expect(outcomes.get("review")).toEqual({ transcript_uncaptured_reason: "no_source_match" });
  });
});
