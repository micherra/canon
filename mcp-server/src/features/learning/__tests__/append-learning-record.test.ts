/**
 * `appendLearningRecord` — the sanctioned agent-facing append seam for
 * `.canon/learning.jsonl` (ADR-0056). Barrier-validated, no target-path
 * parameter (see append-learning-record.ts doc comment for why), routes
 * through `appendJsonlLine` for the newline-safe write.
 *
 * mkdtemp per test — never the repo's real `.canon/` (drift-db-leak-guard).
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendLearningRecord } from "../append-learning-record.ts";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "append-learning-record-test-"));
  // Realistic precondition: a Canon-initialized project always has .canon/
  // already present (config.json, etc.) by the time any agent is spawned
  // and able to call this tool.
  await mkdir(join(projectDir, ".canon"), { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { force: true, recursive: true });
});

function learningJsonlPath(dir: string): string {
  return join(dir, ".canon", "learning.jsonl");
}

describe("appendLearningRecord", () => {
  it("happy path: appends the record to .canon/learning.jsonl under project_dir", async () => {
    const result = await appendLearningRecord(
      {
        project_dir: projectDir,
        record: { run_id: "learn_test_1", timestamp: "2026-07-14T00:00:00Z" },
      },
      projectDir,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.error_code}: ${result.message}`);
    expect(result.appended).toBe(true);
    expect(result.healed).toBe(false);
    expect(result.path).toBe(learningJsonlPath(projectDir));

    const raw = await readFile(learningJsonlPath(projectDir), "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      run_id: "learn_test_1",
      timestamp: "2026-07-14T00:00:00Z",
    });
  });

  it("heals a newline-less predecessor and reports healed: true", async () => {
    const jsonlPath = learningJsonlPath(projectDir);
    await writeFile(jsonlPath, JSON.stringify({ run_id: "predecessor" }), "utf-8");

    const result = await appendLearningRecord(
      {
        project_dir: projectDir,
        record: { run_id: "successor" },
      },
      projectDir,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.error_code}: ${result.message}`);
    expect(result.healed).toBe(true);

    const raw = await readFile(jsonlPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ run_id: "predecessor" });
    expect(JSON.parse(lines[1])).toEqual({ run_id: "successor" });
  });

  it("INVALID_INPUT on a relative project_dir path", async () => {
    const result = await appendLearningRecord(
      { project_dir: "relative/path", record: {} },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("INVALID_INPUT on a project_dir containing a '..' segment", async () => {
    const result = await appendLearningRecord(
      {
        project_dir: `${projectDir}/../etc`,
        record: {},
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("INVALID_INPUT on a project_dir containing a control character", async () => {
    const result = await appendLearningRecord(
      {
        project_dir: `${projectDir}\x00evil`,
        record: {},
      },
      projectDir,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("INVALID_INPUT on a multi-line record (primitive's throw mapped to a ToolResult error)", async () => {
    // See jsonl-append.test.ts for why this is spy-forced: JSON.stringify
    // escapes real newlines to the two-char \\n, so no legitimate record
    // reaches this branch through ordinary serialization. This test proves
    // the handler correctly MAPS the primitive's throw to INVALID_INPUT
    // rather than letting it escape as an unexpected error.
    const spy = vi.spyOn(JSON, "stringify").mockReturnValueOnce('{"a":"line one\nline two"}');
    const result = await appendLearningRecord(
      { project_dir: projectDir, record: { a: "x" } },
      projectDir,
    );
    spy.mockRestore();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("rejects a project_dir outside the resolved session scope, with zero writes (validate-at-trust-boundaries)", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "append-learning-record-outside-"));
    await mkdir(join(outsideDir, ".canon"), { recursive: true });

    try {
      const result = await appendLearningRecord(
        { project_dir: outsideDir, record: { action: "accepted", attacker: "controlled" } },
        projectDir, // resolved session scope — distinct from outsideDir
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error result");
      expect(result.error_code).toBe("INVALID_INPUT");

      await expect(readFile(learningJsonlPath(outsideDir), "utf-8")).rejects.toThrow();
    } finally {
      await rm(outsideDir, { force: true, recursive: true });
    }
  });

  it("accepts a project_dir equal to the resolved session scope (same-path is contained)", async () => {
    const result = await appendLearningRecord(
      { project_dir: projectDir, record: { run_id: "in_scope" } },
      projectDir,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a project_dir/.canon symlink that resolves outside the resolved scope, with zero out-of-scope writes (round-3 PoC — same class as reconcileLearnings, one directory level down)", async () => {
    // project_dir is a genuine in-scope directory (passes the round-2
    // project_dir-level guard) — the escape moves to project_dir/.canon,
    // which the round-2 fix never re-validated after joining onto it.
    const outsideDir = await mkdtemp(join(tmpdir(), "append-learning-record-canon-victim-"));

    // The pre-created .canon/ from beforeEach must be removed first — a
    // symlink cannot be created where a real directory already exists.
    await rm(join(projectDir, ".canon"), { force: true, recursive: true });
    await symlink(outsideDir, join(projectDir, ".canon"));

    try {
      const result = await appendLearningRecord(
        { project_dir: projectDir, record: { action: "accepted", attacker: "controlled" } },
        projectDir,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected the .canon symlink escape to be rejected");
      expect(result.error_code).toBe("INVALID_INPUT");

      await expect(readFile(join(outsideDir, "learning.jsonl"), "utf-8")).rejects.toThrow();
    } finally {
      await rm(outsideDir, { force: true, recursive: true });
    }
  });
});

describe("appendLearningRecord — fresh project with no pre-existing .canon/ (first-run)", () => {
  // Deliberately does NOT pre-create .canon/ (unlike the top-level
  // `beforeEach` above) — this is the exact case the round-2 fix's
  // predecessor worried a naive containment tightening would wrongly
  // reject. It must still succeed after the round-3 fix.
  let freshProjectDir: string;

  beforeEach(async () => {
    freshProjectDir = await mkdtemp(join(tmpdir(), "append-learning-record-firstrun-"));
  });

  afterEach(async () => {
    await rm(freshProjectDir, { force: true, recursive: true });
  });

  it("still succeeds and creates .canon/learning.jsonl when .canon/ does not exist yet", async () => {
    const result = await appendLearningRecord(
      { project_dir: freshProjectDir, record: { run_id: "first_run" } },
      freshProjectDir,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.error_code}: ${result.message}`);
    expect(result.appended).toBe(true);

    const raw = await readFile(join(freshProjectDir, ".canon", "learning.jsonl"), "utf-8");
    expect(JSON.parse(raw.trim())).toEqual({ run_id: "first_run" });
  });
});
