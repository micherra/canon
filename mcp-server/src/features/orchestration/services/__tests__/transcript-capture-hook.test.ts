/**
 * transcript-capture-hook.test.ts
 *
 * Tests for tryTranscriptCapture's migration to the shared session-scoped
 * name resolver (resolveCliffTranscriptSource, ADR-0041). Covers dc-01..dc-04
 * from DESIGN.md: named-hit, unnamed-fallback/no-regression, cross-session
 * miss, and fail-open miss telemetry.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JournalStep,
  LogStepInput,
  LogStepResult,
} from "../../tools/orchestration-journal.ts";

const PROJECT_DIR = "/Users/fake/thook-project";

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

function fakeEntry(): string {
  return JSON.stringify({
    agentId: "irrelevant",
    isSidechain: true,
    message: { content: "hello", role: "user" },
    parentUuid: "parent",
    timestamp: "2026-07-11T00:00:00.000Z",
    type: "user",
  });
}

/** Plant a named-agent fixture matching the {shortType}-{stepId}-{sfx}-{hash}.jsonl convention. */
function plantNamedFixture(dir: string, shortType: string, stepId: string): void {
  writeFileSync(join(dir, `agent-a${shortType}-${stepId}-jobsfx-hash.jsonl`), fakeEntry(), "utf-8");
}

/** Plant an unnamed raw-hex fixture matching agent-{agentId}.jsonl. */
function plantRawFixture(dir: string, agentId: string): void {
  writeFileSync(join(dir, `agent-${agentId}.jsonl`), fakeEntry(), "utf-8");
}

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../cliff-transcript-source.ts");
  vi.resetModules();
  if (originalHome !== undefined) process.env.HOME = originalHome;
  for (const dir of tmpDirs) rmSync(dir, { force: true, recursive: true });
  tmpDirs = [];
});

describe("tryTranscriptCapture", () => {
  it("dc-01: named-hit — composite agent_id resolves via the shared session-scoped resolver", async () => {
    const { tryTranscriptCapture } = await import("../transcript-capture-hook.ts");
    const { getExecutionStore } = await import("@domains/workspaces/execution-store-cache.ts");

    const workspace = makeTmpDir("thook-ws-");
    const homeDir = makeTmpDir("thook-home-");
    process.env.HOME = homeDir;
    const sessionId = "session-named-hit";
    plantNamedFixture(subagentsDir(homeDir, sessionId), "architect", "design");

    const step: JournalStep = {
      agent_type: "canon:architect",
      artifacts_expected: [],
      started_at: new Date().toISOString(),
      status: "completed" as const,
      step_id: "design",
    };
    const result: LogStepResult = { status: "completed" as const, step_id: "design" };
    const input: LogStepInput = {
      agent_id: `architect-design-7c64e852@session-${sessionId}`,
      agent_type: "canon:architect",
      projectDir: PROJECT_DIR,
      status: "completed" as const,
      step_id: "design",
      workspace,
    };

    await tryTranscriptCapture(step, result, input, sessionId);

    expect(result.transcript_path).toBeDefined();
    expect(existsSync(result.transcript_path as string)).toBe(true);

    const store = getExecutionStore(workspace);
    expect(store.getEvents({ type: "transcript_capture_miss" })).toHaveLength(0);
  });

  it("dc-02: unnamed raw-hex resolves via the raw exact-stat path — no regression, name-based never fires", async () => {
    const resolveSpy = vi.fn();
    vi.doMock("../cliff-transcript-source.ts", async (importOriginal) => {
      const original = await importOriginal<typeof import("../cliff-transcript-source.ts")>();
      return {
        ...original,
        resolveCliffTranscriptSource: (
          ...args: Parameters<typeof original.resolveCliffTranscriptSource>
        ) => {
          resolveSpy(...args);
          return original.resolveCliffTranscriptSource(...args);
        },
      };
    });
    const { tryTranscriptCapture } = await import("../transcript-capture-hook.ts");
    const { getExecutionStore } = await import("@domains/workspaces/execution-store-cache.ts");

    const workspace = makeTmpDir("thook-ws-");
    const homeDir = makeTmpDir("thook-home-");
    process.env.HOME = homeDir;
    const sessionId = "session-raw";
    const agentId = "a06c7a653c6cf3744";
    plantRawFixture(subagentsDir(homeDir, sessionId), agentId);

    const step: JournalStep = {
      agent_type: "canon:engineer",
      artifacts_expected: [],
      started_at: new Date().toISOString(),
      status: "completed" as const,
      step_id: "implement",
    };
    const result: LogStepResult = { status: "completed" as const, step_id: "implement" };
    const input: LogStepInput = {
      agent_id: agentId,
      agent_type: "canon:engineer",
      projectDir: PROJECT_DIR,
      status: "completed" as const,
      step_id: "implement",
      workspace,
    };

    await tryTranscriptCapture(step, result, input, sessionId);

    expect(result.transcript_path).toBeDefined();
    expect(existsSync(result.transcript_path as string)).toBe(true);
    expect(resolveSpy).not.toHaveBeenCalled();

    const store = getExecutionStore(workspace);
    expect(store.getEvents({ type: "transcript_capture_miss" })).toHaveLength(0);
  });

  it("dc-03: cross-session miss — a fixture under a different session is not matched", async () => {
    const { tryTranscriptCapture } = await import("../transcript-capture-hook.ts");
    const { getExecutionStore } = await import("@domains/workspaces/execution-store-cache.ts");

    const workspace = makeTmpDir("thook-ws-");
    const homeDir = makeTmpDir("thook-home-");
    process.env.HOME = homeDir;
    const sessionB = "session-B";
    const sessionA = "session-A";
    // Fixture planted under session B's subagents dir.
    plantNamedFixture(subagentsDir(homeDir, sessionB), "engineer", "implement");
    // Session A's subagents dir exists but has no matching fixture.
    subagentsDir(homeDir, sessionA);

    const step: JournalStep = {
      agent_type: "canon:engineer",
      artifacts_expected: [],
      started_at: new Date().toISOString(),
      status: "completed" as const,
      step_id: "implement",
    };
    const result: LogStepResult = { status: "completed" as const, step_id: "implement" };
    const input: LogStepInput = {
      agent_id: `engineer-implement-abcd1234@session-${sessionB}`,
      agent_type: "canon:engineer",
      projectDir: PROJECT_DIR,
      status: "completed" as const,
      step_id: "implement",
      workspace,
    };

    // journal.session_id is sessionA — the resolver must not cross into sessionB's fixture.
    await tryTranscriptCapture(step, result, input, sessionA);

    expect(result.transcript_path).toBeUndefined();

    const store = getExecutionStore(workspace);
    const events = store.getEvents({ type: "transcript_capture_miss" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.step_id).toBe("implement");
  });

  it("dc-04: a completion-path miss emits fail-open telemetry and never throws", async () => {
    const { tryTranscriptCapture } = await import("../transcript-capture-hook.ts");
    const { getExecutionStore } = await import("@domains/workspaces/execution-store-cache.ts");

    const workspace = makeTmpDir("thook-ws-");
    const homeDir = makeTmpDir("thook-home-");
    process.env.HOME = homeDir;
    const sessionId = "session-miss";
    subagentsDir(homeDir, sessionId); // exists, no matching fixture

    const step: JournalStep = {
      agent_type: "canon:reviewer",
      artifacts_expected: [],
      started_at: new Date().toISOString(),
      status: "completed" as const,
      step_id: "review",
    };
    const result: LogStepResult = { status: "completed" as const, step_id: "review" };
    const input: LogStepInput = {
      agent_id: `reviewer-review-deadbeef@session-${sessionId}`,
      agent_type: "canon:reviewer",
      projectDir: PROJECT_DIR,
      status: "completed" as const,
      step_id: "review",
      workspace,
    };

    await expect(tryTranscriptCapture(step, result, input, sessionId)).resolves.toBeUndefined();

    expect(result.transcript_path).toBeUndefined();
    expect(result.transcript_warning).toBeDefined();

    const store = getExecutionStore(workspace);
    const events = store.getEvents({ type: "transcript_capture_miss" });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      agent_type: "canon:reviewer",
      step_id: "review",
    });
  });
});
