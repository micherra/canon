/**
 * cliff-transcript-source.test.ts
 *
 * Tests for resolveCliffTranscriptSource — the session-scoped, fail-open
 * resolver that locates a cliffed step's Claude Code subagent JSONL via the
 * {agent_type}-{step_id}-{job_suffix} spawn-name filename convention
 * (PROBE-FINDINGS.md Probe 1/2). Fixture layout mirrors the real
 * `~/.claude/projects/{projectId}/{sessionId}/subagents/agent-a{name}-{hash}.jsonl`
 * convention, using an injectable `homeDir` seam so tests never touch the
 * real `~/.claude` directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliffTranscriptSource } from "../cliff-transcript-source.ts";

const PROJECT_DIR = "/Users/fake/my-project";
const SESSION_ID = "session-abc";

let tmpDirs: string[] = [];

function makeHomeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cliff-source-home-"));
  tmpDirs.push(dir);
  return dir;
}

function subagentsDir(homeDir: string, sessionId: string): string {
  const projectId = PROJECT_DIR.replace(/\//g, "-");
  const dir = join(homeDir, ".claude", "projects", projectId, sessionId, "subagents");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Plants a fixture file named agent-a{shortType}-{stepId}-{suffix}.jsonl,
 * where `suffix` is the caller-composed `{jobSuffix}-{hash}` tail. */
function plantFixture(dir: string, shortType: string, stepId: string, suffix: string): string {
  const path = join(dir, `agent-a${shortType}-${stepId}-${suffix}.jsonl`);
  writeFileSync(path, "", "utf-8");
  return path;
}

/** Synchronous blocking sleep — used to force distinguishable file birthtimes. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { force: true, recursive: true });
  tmpDirs = [];
});

describe("resolveCliffTranscriptSource", () => {
  it("resolves the fixture file for a happy-path match", () => {
    const homeDir = makeHomeDir();
    const dir = subagentsDir(homeDir, SESSION_ID);
    const expected = plantFixture(dir, "scribe", "context-sync", "x-hash");

    const result = resolveCliffTranscriptSource(
      {
        agentType: "canon:scribe",
        projectDir: PROJECT_DIR,
        sessionId: SESSION_ID,
        stepId: "context-sync",
      },
      { homeDir },
    );

    expect(result.path).toBe(expected);
  });

  it("strips the canon: prefix — canon:scribe and scribe resolve the same fixture", () => {
    const homeDir = makeHomeDir();
    const dir = subagentsDir(homeDir, SESSION_ID);
    const expected = plantFixture(dir, "scribe", "context-sync", "x-hash");

    const withPrefix = resolveCliffTranscriptSource(
      {
        agentType: "canon:scribe",
        projectDir: PROJECT_DIR,
        sessionId: SESSION_ID,
        stepId: "context-sync",
      },
      { homeDir },
    );
    const withoutPrefix = resolveCliffTranscriptSource(
      {
        agentType: "scribe",
        projectDir: PROJECT_DIR,
        sessionId: SESSION_ID,
        stepId: "context-sync",
      },
      { homeDir },
    );

    expect(withPrefix.path).toBe(expected);
    expect(withoutPrefix.path).toBe(expected);
  });

  it("returns no_session_id when sessionId is absent", () => {
    const homeDir = makeHomeDir();
    const dir = subagentsDir(homeDir, SESSION_ID);
    plantFixture(dir, "scribe", "context-sync", "x-hash");

    const result = resolveCliffTranscriptSource(
      { agentType: "canon:scribe", projectDir: PROJECT_DIR, stepId: "context-sync" },
      { homeDir },
    );

    expect(result.path).toBeNull();
    if (result.path === null) expect(result.reason).toBe("no_session_id");
  });

  it("returns projects_dir_unreadable when the subagents dir does not exist", () => {
    const homeDir = makeHomeDir(); // empty — no .claude/projects at all

    const result = resolveCliffTranscriptSource(
      {
        agentType: "canon:scribe",
        projectDir: PROJECT_DIR,
        sessionId: SESSION_ID,
        stepId: "context-sync",
      },
      { homeDir },
    );

    expect(result.path).toBeNull();
    if (result.path === null) expect(result.reason).toBe("projects_dir_unreadable");
  });

  it("returns no_source_match when no candidate file exists", () => {
    const homeDir = makeHomeDir();
    subagentsDir(homeDir, SESSION_ID); // dir exists but empty

    const result = resolveCliffTranscriptSource(
      {
        agentType: "canon:scribe",
        projectDir: PROJECT_DIR,
        sessionId: SESSION_ID,
        stepId: "context-sync",
      },
      { homeDir },
    );

    expect(result.path).toBeNull();
    if (result.path === null) expect(result.reason).toBe("no_source_match");
  });

  it("does not match a context-sync-codex-fix file for step_id context-sync (trailing-dash collision guard)", () => {
    const homeDir = makeHomeDir();
    const dir = subagentsDir(homeDir, SESSION_ID);
    // Only a fixture for a DIFFERENT, longer step_id exists.
    plantFixture(dir, "scribe", "context-sync-codex-fix", "x-hash");

    const result = resolveCliffTranscriptSource(
      {
        agentType: "canon:scribe",
        projectDir: PROJECT_DIR,
        sessionId: SESSION_ID,
        stepId: "context-sync",
      },
      { homeDir },
    );

    expect(result.path).toBeNull();
    if (result.path === null) expect(result.reason).toBe("no_source_match");
  });

  it("re-spawn disambiguation: picks the fixture whose birthtime is closest to startedAt", () => {
    const homeDir = makeHomeDir();
    const dir = subagentsDir(homeDir, SESSION_ID);
    // Force distinguishable real birthtimes — utimes cannot retroactively set
    // birthtime, so creation order + a real gap is the only reliable lever.
    plantFixture(dir, "engineer", "implement", "aaa1111a-hash1");
    sleepSync(50);
    const newer = plantFixture(dir, "engineer", "implement", "bbb2222b-hash2");

    const result = resolveCliffTranscriptSource(
      {
        agentType: "canon:engineer",
        projectDir: PROJECT_DIR,
        sessionId: SESSION_ID,
        startedAt: new Date().toISOString(),
        stepId: "implement",
      },
      { homeDir },
    );

    expect(result.path).toBe(newer);
  });

  it("is session-scoped: a fixture in a different session dir is never matched", () => {
    const homeDir = makeHomeDir();
    const otherSessionDir = subagentsDir(homeDir, "other-session");
    plantFixture(otherSessionDir, "scribe", "context-sync", "x-hash");
    subagentsDir(homeDir, SESSION_ID); // the actual session dir — left empty

    const result = resolveCliffTranscriptSource(
      {
        agentType: "canon:scribe",
        projectDir: PROJECT_DIR,
        sessionId: SESSION_ID,
        stepId: "context-sync",
      },
      { homeDir },
    );

    expect(result.path).toBeNull();
    if (result.path === null) expect(result.reason).toBe("no_source_match");
  });

  it("never throws on an unreadable homeDir (fail-open)", () => {
    expect(() =>
      resolveCliffTranscriptSource(
        {
          agentType: "canon:scribe",
          projectDir: PROJECT_DIR,
          sessionId: SESSION_ID,
          stepId: "context-sync",
        },
        { homeDir: "/nonexistent/path/that/does/not/exist" },
      ),
    ).not.toThrow();
  });
});
