/**
 * backfill.test.ts — coverage for the one-shot T2 record backfill script.
 *
 * `computeFirstFourLinesMd5`, `makeBackfillAppendLine`, and
 * `selectPendingTargets` are the pure(ish) exported units — all filesystem
 * effects are seam-injected (`appendLine`'s callback, `runRecorder`'s own
 * subprocess seams), so these tests never spawn a real `claude` process. The
 * integration test at the bottom exercises `runRecorder` for real (as
 * `backfill.ts`'s target-loop does) against a disposable tmp git fixture —
 * mirroring record.test.ts's own mocking-boundary pattern — and reads the
 * REAL shipped rubric.md, proving the reconstructed `rubric_hash` equals the
 * frozen constant without depending on this machine's actual lost-record
 * worktrees (which `backfill.ts`'s hardcoded `TARGETS` point at operationally,
 * but which a portable test suite must not require).
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckerRunRecord } from "../record.ts";
import { runRecorder } from "../record.ts";
import { computeFirstFourLinesMd5, makeBackfillAppendLine, selectPendingTargets } from "../backfill.ts";

const FROZEN_RUBRIC_HASH = "315696f6415cbd7097d9c2ae978fa5f0cddeb71332c2f98470bf1f598193d30e";

function baseRecord(overrides: Partial<CheckerRunRecord> = {}): CheckerRunRecord {
  return {
    base_sha: "base123",
    branch: "main",
    checker_elapsed_ms: 42_000,
    failed_open: false,
    findings: [],
    head_sha: "head456",
    record_id: "t2r_1_abc",
    rubric_hash: FROZEN_RUBRIC_HASH,
    slug: "some-slug",
    timestamp: "2026-07-19T00:00:00.000Z",
    touched_files: ["a.ts", "b.ts"],
    ...overrides,
  };
}

describe("computeFirstFourLinesMd5", () => {
  it("matches `head -4 <file> | md5` semantics (each line newline-terminated, joined)", () => {
    const lines = ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}'];
    const expected = createHash("md5")
      .update(lines.map((l) => `${l}\n`).join(""))
      .digest("hex");
    expect(computeFirstFourLinesMd5(lines)).toBe(expected);
  });

  it("only hashes the first 4 lines — a 5th extra line does not change the result", () => {
    const four = ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}'];
    const five = [...four, '{"e":5}'];
    expect(computeFirstFourLinesMd5(five)).toBe(computeFirstFourLinesMd5(four));
  });
});

describe("selectPendingTargets — idempotency selector", () => {
  const targets = [{ slug: "a" }, { slug: "b" }, { slug: "c" }];

  it("returns every target when none are already backfilled", () => {
    expect(selectPendingTargets(targets, [])).toEqual(["a", "b", "c"]);
  });

  it("excludes a target whose slug already has a backfilled:true record", () => {
    const existing = [baseRecord({ backfilled: true, slug: "b" })];
    expect(selectPendingTargets(targets, existing)).toEqual(["a", "c"]);
  });

  it("ignores a same-slug record that is NOT backfilled (native record, no collision)", () => {
    const existing = [baseRecord({ slug: "b" })]; // backfilled absent
    expect(selectPendingTargets(targets, existing)).toEqual(["a", "b", "c"]);
  });

  it("all targets already backfilled -> empty pending list (fully idempotent re-run)", () => {
    const existing = targets.map((t) => baseRecord({ backfilled: true, slug: t.slug }));
    expect(selectPendingTargets(targets, existing)).toEqual([]);
  });
});

describe("makeBackfillAppendLine — provenance-stamping seam", () => {
  let tmpDir: string;

  function withTmpDir<T>(fn: (dir: string) => T): T {
    tmpDir = mkdtempSync(join(tmpdir(), "t2-backfill-test-"));
    try {
      return fn(tmpDir);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  }

  it("stamps backfilled:true + checker_elapsed_ms:0 and preserves every other field", () => {
    withTmpDir((dir) => {
      const targetPath = join(dir, "checker-runs.jsonl");
      let appendedEntry: { slug: string; rubric_hash: string; touched_files: number } | undefined;
      const seam = makeBackfillAppendLine(targetPath, "some-slug", (entry) => {
        appendedEntry = entry;
      });

      const record = baseRecord();
      seam(targetPath, JSON.stringify(record));

      const written = JSON.parse(readFileSync(targetPath, "utf-8").trim()) as CheckerRunRecord;
      expect(written.backfilled).toBe(true);
      expect(written.checker_elapsed_ms).toBe(0);
      expect(written.base_sha).toBe(record.base_sha);
      expect(written.head_sha).toBe(record.head_sha);
      expect(written.slug).toBe(record.slug);
      expect(written.touched_files).toEqual(record.touched_files);
      expect(written.findings).toEqual(record.findings);
      expect(written.rubric_hash).toBe(record.rubric_hash);
      expect(appendedEntry).toEqual({ rubric_hash: record.rubric_hash, slug: record.slug, touched_files: 2 });
    });
  });

  it("refuses (throws) and appends nothing when the record is failed_open:true", () => {
    withTmpDir((dir) => {
      const targetPath = join(dir, "checker-runs.jsonl");
      const seam = makeBackfillAppendLine(targetPath, "some-slug", () => {
        throw new Error("onAppended must not be called");
      });

      expect(() => seam(targetPath, JSON.stringify(baseRecord({ failed_open: true })))).toThrow(/degraded/);
      expect(() => readFileSync(targetPath, "utf-8")).toThrow();
    });
  });

  it("refuses (throws) and appends nothing when rubric_hash does not match the frozen constant", () => {
    withTmpDir((dir) => {
      const targetPath = join(dir, "checker-runs.jsonl");
      const seam = makeBackfillAppendLine(targetPath, "some-slug", () => {
        throw new Error("onAppended must not be called");
      });

      expect(() => seam(targetPath, JSON.stringify(baseRecord({ rubric_hash: "deadbeef" })))).toThrow(/rubric_hash mismatch/);
      expect(() => readFileSync(targetPath, "utf-8")).toThrow();
    });
  });

  it("md5-of-first-4-lines invariant: seeding 4 lines then appending 4 more leaves the first 4 byte-identical", () => {
    withTmpDir((dir) => {
      const targetPath = join(dir, "checker-runs.jsonl");
      const seed = [
        baseRecord({ slug: "seed-1" }),
        baseRecord({ slug: "seed-2" }),
        baseRecord({ slug: "seed-3" }),
        baseRecord({ slug: "seed-4" }),
      ];
      const seedLines = seed.map((r) => JSON.stringify(r));
      writeFileSync(targetPath, `${seedLines.join("\n")}\n`, "utf-8");

      const md5Before = computeFirstFourLinesMd5(seedLines);

      for (const slug of ["new-1", "new-2", "new-3", "new-4"]) {
        const seam = makeBackfillAppendLine(targetPath, slug, () => {});
        seam(targetPath, JSON.stringify(baseRecord({ slug })));
      }

      const allLines = readFileSync(targetPath, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(allLines).toHaveLength(8);

      const md5After = computeFirstFourLinesMd5(allLines);
      expect(md5After).toBe(md5Before);

      const seedParsedAfter = allLines.slice(0, 4).map((l) => JSON.parse(l) as CheckerRunRecord);
      expect(seedParsedAfter.every((r) => r.backfilled === undefined)).toBe(true);

      const newParsedAfter = allLines.slice(4).map((l) => JSON.parse(l) as CheckerRunRecord);
      expect(newParsedAfter.every((r) => r.backfilled === true)).toBe(true);
      expect(newParsedAfter.map((r) => r.slug)).toEqual(["new-1", "new-2", "new-3", "new-4"]);
    });
  });
});

describe("backfill reconstruction via runRecorder — integration (real rubric.md, mocked checker)", () => {
  let tmpDir: string;

  function processResult(overrides: { ok: boolean; stdout?: string }) {
    return {
      duration_ms: 1,
      exitCode: overrides.ok ? 0 : 1,
      ok: overrides.ok,
      stderr: "",
      stdout: overrides.stdout ?? "",
      timedOut: false,
    };
  }

  const PASS_STDOUT = `---VERDICT---
VERDICT: PASS
SUMMARY: No misses found.
FINDINGS:
---END_VERDICT---
`;

  it("reconstructs a record whose rubric_hash equals the frozen constant, stamped with backfill provenance", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "t2-backfill-integration-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: tmpDir });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });
      writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\n");
      spawnSync("git", ["add", "."], { cwd: tmpDir });
      spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: tmpDir });
      const baseSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).stdout.trim();
      writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\nconst b = 2;\n");
      spawnSync("git", ["add", "."], { cwd: tmpDir });
      spawnSync("git", ["commit", "-q", "-m", "reviewed head"], { cwd: tmpDir });
      const reviewedHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" }).stdout.trim();
      // A post-review commit the reconstruction must NOT see if head is pinned correctly.
      writeFileSync(join(tmpDir, "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
      spawnSync("git", ["add", "."], { cwd: tmpDir });
      spawnSync("git", ["commit", "-q", "-m", "post-review merge"], { cwd: tmpDir });

      const targetPath = join(tmpDir, "checker-runs.jsonl");
      writeFileSync(targetPath, "", "utf-8");

      let appendedEntry: { slug: string; rubric_hash: string; touched_files: number } | undefined;
      const result = runRecorder(
        { base: baseSha, head: reviewedHead, out: targetPath, slug: "pr520-fixture", worktree: tmpDir },
        {
          appendLine: makeBackfillAppendLine(targetPath, "pr520-fixture", (entry) => {
            appendedEntry = entry;
          }),
          shellRunner: () => processResult({ ok: true, stdout: PASS_STDOUT }),
        },
      );

      expect(result.ok).toBe(true);
      const written = JSON.parse(readFileSync(targetPath, "utf-8").trim()) as CheckerRunRecord;
      expect(written.rubric_hash).toBe(FROZEN_RUBRIC_HASH);
      expect(written.backfilled).toBe(true);
      expect(written.checker_elapsed_ms).toBe(0);
      expect(written.head_sha).toBe(reviewedHead);
      expect(written.touched_files).toEqual(["a.ts"]); // pinned to reviewed head, not the post-review commit
      expect(appendedEntry?.rubric_hash).toBe(FROZEN_RUBRIC_HASH);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
