/**
 * record.test.ts — coverage for the T2 probe live recorder CLI.
 *
 * `runRecorder` is the pure(ish) core: all subprocess/filesystem seams are
 * injectable, so the unit tests below never spawn a real `claude` process
 * or touch the real `.canon/t2-probe/` store — see mocking-boundaries primer
 * ("mock at the system boundary, not the class boundary"). The one CLI-level
 * integration test at the bottom exercises the real subprocess boundary in a
 * disposable tmp git repo, verifying the exit-0 total-fail-open guarantee
 * end-to-end (AC2 / dc-02).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessResult } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRecorder } from "../record.ts";

function processResult(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    duration_ms: 1,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: "",
    timedOut: false,
    ...overrides,
  };
}

const PASS_STDOUT = `---VERDICT---
VERDICT: PASS
SUMMARY: No misses found.
FINDINGS:
---END_VERDICT---
`;

describe("runRecorder — happy path (dc-01)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "t2-record-test-"));
    spawnSync("git", ["init", "-q"], { cwd: tmpDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\n");
    spawnSync("git", ["add", "."], { cwd: tmpDir });
    spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("appends a well-formed record with all fields for a real reviewed diff", () => {
    const baseSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).stdout.trim();
    writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\nconst b = 2;\n");
    spawnSync("git", ["add", "."], { cwd: tmpDir });
    spawnSync("git", ["commit", "-q", "-m", "change"], { cwd: tmpDir });
    const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).stdout.trim();

    const lines: string[] = [];
    const result = runRecorder(
      { base: baseSha, slug: "test-slug", worktree: tmpDir },
      {
        appendLine: (_path, line) => lines.push(line),
        shellRunner: () => processResult({ ok: true, stdout: PASS_STDOUT }),
      },
    );

    expect(result.ok).toBe(true);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.slug).toBe("test-slug");
    expect(record.base_sha).toBe(baseSha);
    expect(record.head_sha).toBe(headSha);
    expect(record.branch).toBeTruthy();
    expect(record.touched_files).toEqual(["a.ts"]);
    expect(record.findings).toEqual([]);
    expect(record.failed_open).toBe(false);
    expect(typeof record.checker_elapsed_ms).toBe("number");
    expect(typeof record.rubric_hash).toBe("string");
    expect(record.rubric_hash.length).toBeGreaterThan(0);
    expect(record.record_id).toMatch(/^t2r_/);
    expect(record.review_id).toBeUndefined();
  });

  it("includes review_id when passed", () => {
    const baseSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).stdout.trim();
    const lines: string[] = [];

    runRecorder(
      { base: baseSha, reviewId: "rev_abc123", slug: "test-slug", worktree: tmpDir },
      {
        appendLine: (_path, line) => lines.push(line),
        shellRunner: () => processResult({ ok: true, stdout: PASS_STDOUT }),
      },
    );

    const record = JSON.parse(lines[0]);
    expect(record.review_id).toBe("rev_abc123");
  });
});

describe("runRecorder — total fail-open envelope (AC2 / dc-02)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "t2-record-test-"));
    spawnSync("git", ["init", "-q"], { cwd: tmpDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\n");
    spawnSync("git", ["add", "."], { cwd: tmpDir });
    spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("a failing shellRunner still appends a failed_open:true record and returns ok", () => {
    const baseSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).stdout.trim();
    const lines: string[] = [];

    const result = runRecorder(
      { base: baseSha, slug: "test-slug", worktree: tmpDir },
      {
        appendLine: (_path, line) => lines.push(line),
        shellRunner: () => processResult({ exitCode: 1, ok: false, stderr: "boom" }),
      },
    );

    expect(result.ok).toBe(true);
    const record = JSON.parse(lines[0]);
    expect(record.failed_open).toBe(true);
  });

  it("a throwing appendLine seam returns a warning result, never throws", () => {
    const baseSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).stdout.trim();

    expect(() => {
      const result = runRecorder(
        { base: baseSha, slug: "test-slug", worktree: tmpDir },
        {
          appendLine: () => {
            throw new Error("disk full");
          },
          shellRunner: () => processResult({ ok: true, stdout: PASS_STDOUT }),
        },
      );
      expect(result.ok).toBe(false);
    }).not.toThrow();
  });

  it("a bad base sha (git failure) still appends a failed_open:true record", () => {
    const lines: string[] = [];

    const result = runRecorder(
      { base: "0000000000000000000000000000000000000000", slug: "test-slug", worktree: tmpDir },
      {
        appendLine: (_path, line) => lines.push(line),
        shellRunner: () => processResult({ ok: true, stdout: PASS_STDOUT }),
      },
    );

    expect(result.ok).toBe(true);
    const record = JSON.parse(lines[0]);
    expect(record.failed_open).toBe(true);
  });

  it("a throwing shellRunner (hostile/buggy seam) still appends a failed_open:true record", () => {
    const baseSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).stdout.trim();
    const lines: string[] = [];

    const result = runRecorder(
      { base: baseSha, slug: "test-slug", worktree: tmpDir },
      {
        appendLine: (_path, line) => lines.push(line),
        shellRunner: (): never => {
          throw new Error("hostile runner exploded");
        },
      },
    );

    expect(result.ok).toBe(true);
    const record = JSON.parse(lines[0]);
    expect(record.failed_open).toBe(true);
  });
});

describe("runRecorder — CLI-level integration (AC2 induced-failure verification)", () => {
  let tmpDir: string;
  let fakeBinDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "t2-record-cli-test-"));
    spawnSync("git", ["init", "-q"], { cwd: tmpDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\n");
    spawnSync("git", ["add", "."], { cwd: tmpDir });
    spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: tmpDir });

    fakeBinDir = mkdtempSync(join(tmpdir(), "t2-record-fakebin-"));
    const fakeClaude = join(fakeBinDir, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeClaude, 0o755);
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    rmSync(fakeBinDir, { force: true, recursive: true });
  });

  it("real CLI invocation with a sabotaged `claude` on PATH exits 0 and persists a failed_open record", () => {
    const baseSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).stdout.trim();
    const outPath = join(tmpDir, "checker-runs.jsonl");
    const recordScript = join(dirname(new URL(import.meta.url).pathname), "..", "record.ts");

    const result = spawnSync(
      "npx",
      ["tsx", recordScript, "--worktree", tmpDir, "--base", baseSha, "--slug", "cli-test", "--out", outPath],
      {
        cwd: join(dirname(new URL(import.meta.url).pathname), "..", "..", ".."),
        encoding: "utf-8",
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
        timeout: 60_000,
      },
    );

    expect(result.status).toBe(0);
    const persisted = readFileSync(outPath, "utf-8").trim();
    const record = JSON.parse(persisted);
    expect(record.failed_open).toBe(true);
    expect(record.slug).toBe("cli-test");
  }, 60_000);
});
