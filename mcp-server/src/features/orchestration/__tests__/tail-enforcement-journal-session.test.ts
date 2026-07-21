/**
 * TDD tests for delta D3 codex-fix P1 — durable session identity in journal.json.
 *
 * The stop-hook tail-enforcement gate (hooks/tail-enforcement-gate.sh) originally
 * matched the active build for a Stop event's session_id via a sibling `.lock`
 * file. `finalize_workspace` releases `.lock` unconditionally BEFORE the gate's
 * `ship==completed` trigger can ever fire — so the gate was structurally dead
 * for its primary purpose (a shipped-but-tail-incomplete build). See
 * plans/tail-gate-codex-fix/DESIGN.md "Why journal.json is the right carrier".
 *
 * Fix: persist `session_id` on `journal.json` itself (which finalize_workspace
 * copies to the archive but never deletes) instead of relying on `.lock`.
 *
 * Covers:
 * 1. init_workspace seeds `session_id` into journal.json at CREATE (happy path).
 * 2. init_workspace omits the `session_id` field when none was provided (never
 *    writes the literal "unknown").
 * 3. A logStep round-trip preserves the top-level `session_id`.
 * 4. Resume refreshes `session_id` to the re-entering session while preserving
 *    previously-logged `steps`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock loadAndResolveFlow to avoid needing real flow files (same pattern as
// init-workspace-task-identity.test.ts / init-workspace-seed.test.ts).
vi.mock("@domains/flows/flow-parser.ts", () => ({
  loadAndResolveFlow: vi.fn().mockResolvedValue({
    description: "test",
    entry: "build",
    name: "fast-path",
    spawn_instructions: {},
    states: {
      build: { transitions: { done: "done" }, type: "single" },
      done: { type: "terminal" },
    },
  }),
}));

import { assertOk } from "@shared/lib/tool-result.ts";
import { initGitFixtureRepo } from "../../../tests/git-fixture.ts";
import { releaseLock } from "../services/workspace-lock.ts";
import { initWorkspaceFlow } from "../tools/init-workspace.ts";
import { logStep, readJournal } from "../tools/orchestration-journal.ts";

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tail-gate-journal-session-test-"));
  tmpDirs.push(dir);
  return dir;
}

function readJournalRaw(workspace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspace, "journal.json"), "utf-8"));
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// Timeout justification: each test calls initWorkspaceFlow which runs a real
// git-worktree-add subprocess (~0.5-1s). See init-workspace-task-identity.test.ts
// for the same measured-worst-case rationale.
describe("journal.json session_id persistence (tail-gate-codex-fix P1)", { timeout: 20000 }, () => {
  it("seeds session_id into journal.json at create (happy path)", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      {
        base_commit: baseCommit,
        branch: "main",
        flow_name: "fast-path",
        session_id: "session-abc-123",
        task: "seed session_id happy path",
        tier: "small",
      },
      projectDir,
      "/fake/plugin",
    );

    assertOk(result);

    expect(result.created).toBe(true);
    const raw = readJournalRaw(result.workspace);
    expect(raw.session_id).toBe("session-abc-123");
  });

  it("omits session_id from journal.json when none was provided (never writes 'unknown')", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      {
        base_commit: baseCommit,
        branch: "main",
        flow_name: "fast-path",
        task: "no session_id provided",
        tier: "small",
      },
      projectDir,
      "/fake/plugin",
    );

    assertOk(result);

    expect(result.created).toBe(true);
    // No session_id was supplied, so init_workspace never seeds journal.json at
    // all (preserves the pre-fix lazy-write-at-first-log_step behavior for this
    // case) — reading it back via the same readJournal() path an mcp tool would
    // use confirms session_id is absent, never the literal "unknown".
    const journal = await readJournal(result.workspace);
    expect(journal.session_id).toBeUndefined();
    expect(journal.session_id).not.toBe("unknown");
  });

  it("preserves top-level session_id across a logStep round-trip", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const result = await initWorkspaceFlow(
      {
        base_commit: baseCommit,
        branch: "main",
        flow_name: "fast-path",
        session_id: "session-round-trip",
        task: "round trip preserves session_id",
        tier: "small",
      },
      projectDir,
      "/fake/plugin",
    );
    assertOk(result);
    expect(result.created).toBe(true);

    // No agent_type — this test exercises session_id persistence only, not
    // the write-receipt gate (a mapped agent_type would reject this
    // completion since the fixture writes no artifact/receipt).
    await logStep({
      agent_id: "test-agent",
      artifacts_expected: [],
      projectDir,
      status: "completed",
      step_id: "implement",
      workspace: result.workspace,
    });

    const journal = await readJournal(result.workspace);
    expect(journal.session_id).toBe("session-round-trip");
    expect(journal.steps.find((s) => s.step_id === "implement")?.status).toBe("completed");
  });

  it("refreshes session_id on resume while preserving previously-logged steps", async () => {
    const projectDir = makeTmpProjectDir();
    const baseCommit = initGitFixtureRepo(projectDir);

    const input = {
      base_commit: baseCommit,
      branch: "main",
      flow_name: "fast-path",
      session_id: "session-original",
      task: "resume refreshes session_id",
      tier: "small" as const,
    };

    const first = await initWorkspaceFlow(input, projectDir, "/fake/plugin");
    assertOk(first);
    expect(first.created).toBe(true);

    // No agent_type — same rationale as the round-trip test above.
    await logStep({
      agent_id: "test-agent",
      artifacts_expected: [],
      projectDir,
      status: "completed",
      step_id: "design",
      workspace: first.workspace,
    });

    // Simulate the first session's mutex being released externally (crash
    // recovery, a prior finalize, a session restart under a new
    // CLAUDE_CODE_SESSION_ID) so a DIFFERENT session_id can freely re-acquire
    // it — isolates this test to the journal session_id refresh concern; lock
    // re-acquisition itself is covered by workspace-lock tests and
    // init-workspace-task-identity.test.ts.
    releaseLock(first.workspace, { session_id: "session-original" });

    // A new session resumes the same workspace (same task → same slug).
    const second = await initWorkspaceFlow(
      { ...input, session_id: "session-resumed" },
      projectDir,
      "/fake/plugin",
    );
    assertOk(second);
    expect(second.created).toBe(false);
    expect(second.workspace).toBe(first.workspace);

    const journal = await readJournal(second.workspace);
    expect(journal.session_id).toBe("session-resumed");
    // Prior step history survives the resume's session_id refresh.
    expect(journal.steps.find((s) => s.step_id === "design")?.status).toBe("completed");
  });
});
