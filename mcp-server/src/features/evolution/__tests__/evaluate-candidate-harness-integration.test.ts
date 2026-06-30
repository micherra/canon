/**
 * evaluate-candidate-harness-integration.test.ts
 *
 * REAL-HARNESS integration tests. These tests exercise the ACTUAL run-evals.sh
 * script end-to-end with --dry-run so they make ZERO model calls and run fast.
 *
 * Coverage purpose (coverage gap from engineer's Known Gaps):
 * - The unit tests mock runShell. This test calls the REAL shell script through
 *   the REAL runSplit + withInjectedCandidate path to prove the TS tool and the
 *   bash harness agree on the frozen contract (flag names, baseline.json shape,
 *   summary line format).
 *
 * AC coverage:
 * - AC#3 (split selection): --split holdout selects 3 holdout cases
 * - AC#4 (--emit-baseline + baseline.json shape): { split, passed, failed, errors, skipped, total }
 * - parser-vs-real-producer contract: parseSummary parses the REAL stdout line
 * - sad-path: invalid --judge-votes exits non-zero → surfaces as error/ToolResult-error
 * - isolation: real eval tree is byte-unchanged after withInjectedCandidate runs
 */

import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withInjectedCandidate } from "../services/candidate-injection.ts";
import { parseSummary, runSplit } from "../services/eval-runner.ts";

// Resolve paths: __tests__/ is inside mcp-server/src/features/evolution/
// Go up: __tests__ → evolution → features → src → mcp-server → worktree
// Use the same 5-level path as candidate-injection.test.ts which passes.
// Note: import.meta.dirname in vitest resolves to the __tests__/ directory.
const WORKTREE_ROOT = join(import.meta.dirname ?? __dirname, "../../../../..");
const EVALS_DIR = join(WORKTREE_ROOT, "skills", "canon", "evals");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Hash every file in a directory deterministically (alphabetical order).
 * Used to assert the real evals dir is unchanged before/after injection.
 */
async function hashDir(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? dir, e.name))
    .sort();

  for (const filePath of files) {
    // biome-ignore lint/performance/noAwaitInLoops: deterministic hashing requires sequential, ordered reads
    const content = await readFile(filePath);
    hash.update(filePath.replace(dir, ""));
    hash.update(content);
  }
  return hash.digest("hex");
}

// ── Test 1 — parseSummary parses the REAL summary line produced by run-evals.sh ──

describe("parseSummary vs real harness stdout (parser-producer contract)", () => {
  /**
   * This test proves that parseSummary() correctly parses the exact format that
   * run-evals.sh actually emits — not a hand-written fixture.
   *
   * In dry-run with --split holdout: 3 cases, all DRYRUN (skipped), 0 passed, 0 failed.
   * Expected real stdout line: "Total: 3 | Passed: 0 | Failed: 0 | Errors: 0 | Skipped: 3"
   */
  it("parseSummary correctly parses REAL run-evals.sh --dry-run stdout", async () => {
    // Run the real script in the real evals dir (dry-run, no model calls)
    // We use withInjectedCandidate to get a safe copy of the evals tree,
    // then call runSplit against the real script.
    let capturedStdout: string | undefined;

    await withInjectedCandidate(
      WORKTREE_ROOT,
      // Use the unmodified eval-set.json (identity injection — content unchanged)
      await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8"),
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const result = runSplit(tmpDir, "holdout", { dryRun: true, structuredJudge: false });
        capturedStdout = result.stdout;

        // The script must exit 0 in dry-run mode (all cases are DRYRUN/skipped, not errors)
        expect(result.ok).toBe(true);
        expect(result.timedOut).toBe(false);
      },
    );

    expect(capturedStdout).toBeDefined();

    // parseSummary must parse the REAL stdout correctly
    const parsed = parseSummary(capturedStdout!);

    // In dry-run holdout: 3 holdout cases, all DRYRUN → skipped, 0 passed, 0 failed
    // The real summary line is: "Total: 3 | Passed: 0 | Failed: 0 | Errors: 0 | Skipped: 3"
    expect(parsed.total).toBe(3);
    expect(parsed.passed).toBe(0);
    expect(parsed.failed).toBe(0);
  });

  it("real stdout contains the frozen summary line format", async () => {
    let capturedStdout: string | undefined;

    await withInjectedCandidate(
      WORKTREE_ROOT,
      await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8"),
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const result = runSplit(tmpDir, "holdout", { dryRun: true, structuredJudge: false });
        capturedStdout = result.stdout;
      },
    );

    // Assert the FROZEN summary line format contract — parseSummary depends on this exact string
    expect(capturedStdout).toMatch(
      /Total:\s*3\s*\|\s*Passed:\s*0\s*\|\s*Failed:\s*0\s*\|\s*Errors:\s*0\s*\|\s*Skipped:\s*3/,
    );
  });
});

// ── Test 2 — --emit-baseline produces frozen { split, passed, failed, errors, skipped, total } ──

describe("--emit-baseline produces the frozen baseline.json shape (AC#4)", () => {
  let emitBaselineTmpDir: string;

  beforeAll(async () => {
    emitBaselineTmpDir = await mkdtemp(join(tmpdir(), "canon-emit-baseline-test-"));
  });

  afterAll(async () => {
    await rm(emitBaselineTmpDir, { force: true, recursive: true });
  });

  it("--split holdout --emit-baseline produces baseline.json with exact frozen shape", async () => {
    const baselineOutPath = join(emitBaselineTmpDir, "baseline.json");

    await withInjectedCandidate(
      WORKTREE_ROOT,
      await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8"),
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        // run-evals.sh --emit-baseline writes a JSON file to the given path.
        // runSplit does NOT support --emit-baseline directly, so we call the script
        // with the real runShell adapter to test the full flag path.
        const { runShell } = await import("@platform/adapters/process-adapter.ts");
        const scriptPath = join(tmpDir, "skills", "canon", "evals", "run-evals.sh");
        const result = runShell(
          `bash "${scriptPath}" --split holdout --dry-run --emit-baseline "${baselineOutPath}"`,
          tmpDir,
          30_000,
        );

        // The script must exit 0 in dry-run (skipped ≠ failure)
        expect(result.ok).toBe(true);
        expect(result.timedOut).toBe(false);
      },
    );

    // baseline.json must exist and be parseable
    const baselineRaw = await readFile(baselineOutPath, "utf-8");
    let baseline: unknown;
    expect(() => {
      baseline = JSON.parse(baselineRaw);
    }).not.toThrow();

    // Frozen shape assertion: { split, passed, failed, errors, skipped, total }
    expect(baseline).toEqual({
      errors: 0,
      failed: 0,
      passed: 0,
      skipped: 3,
      split: "holdout",
      total: 3,
    });
  });

  it("baseline.json has all 6 required fields with correct types", async () => {
    const baselineOutPath = join(emitBaselineTmpDir, "baseline-fields.json");

    await withInjectedCandidate(
      WORKTREE_ROOT,
      await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8"),
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const { runShell } = await import("@platform/adapters/process-adapter.ts");
        const scriptPath = join(tmpDir, "skills", "canon", "evals", "run-evals.sh");
        runShell(
          `bash "${scriptPath}" --split holdout --dry-run --emit-baseline "${baselineOutPath}"`,
          tmpDir,
          30_000,
        );
      },
    );

    const baseline = JSON.parse(await readFile(baselineOutPath, "utf-8")) as Record<
      string,
      unknown
    >;

    // All 6 fields must be present
    expect(Object.keys(baseline).sort()).toEqual([
      "errors",
      "failed",
      "passed",
      "skipped",
      "split",
      "total",
    ]);

    // Type checks: split is a string, counts are numbers
    expect(typeof baseline.split).toBe("string");
    expect(typeof baseline.passed).toBe("number");
    expect(typeof baseline.failed).toBe("number");
    expect(typeof baseline.errors).toBe("number");
    expect(typeof baseline.skipped).toBe("number");
    expect(typeof baseline.total).toBe("number");

    // split: "holdout" — confirms --split flag is correctly forwarded into baseline.json
    expect(baseline.split).toBe("holdout");

    // total must match the count of holdout cases in eval-set.json (3 seed holdout cases)
    expect(baseline.total).toBe(3);
  });
});

// ── Test 3 — --split selection: holdout selects only 3 holdout cases (AC#3) ──

describe("--split flag selects the correct cases (AC#3)", () => {
  it("--split holdout runs exactly 3 cases and total=3", async () => {
    let capturedStdout: string | undefined;

    await withInjectedCandidate(
      WORKTREE_ROOT,
      await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8"),
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const result = runSplit(tmpDir, "holdout", { dryRun: true, structuredJudge: false });
        capturedStdout = result.stdout;
      },
    );

    const parsed = parseSummary(capturedStdout!);
    expect(parsed.total).toBe(3);
  });

  it("all 3 holdout cases are DRYRUN-skipped (none passed, none failed)", async () => {
    let capturedStdout: string | undefined;

    await withInjectedCandidate(
      WORKTREE_ROOT,
      await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8"),
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const result = runSplit(tmpDir, "holdout", { dryRun: true, structuredJudge: false });
        capturedStdout = result.stdout;
      },
    );

    // In dry-run, DRYRUN lines are "skipped" — not passed, not failed
    const parsed = parseSummary(capturedStdout!);
    expect(parsed.passed).toBe(0);
    expect(parsed.failed).toBe(0);
    // total = 3 (parsed), and total = passed + failed + skipped + errors
    // parseSummary only returns { passed, failed, total } — total is the TOTAL count
    expect(parsed.total).toBe(3);
  });

  it("holdout stdout contains all 3 holdout case IDs", async () => {
    let capturedStdout: string | undefined;

    await withInjectedCandidate(
      WORKTREE_ROOT,
      await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8"),
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const result = runSplit(tmpDir, "holdout", { dryRun: true, structuredJudge: false });
        capturedStdout = result.stdout;
      },
    );

    // The 3 seed holdout cases from eval-set.json
    expect(capturedStdout).toContain("holdout-intent-classify-explore");
    expect(capturedStdout).toContain("holdout-principle-match-errors-are-values");
    expect(capturedStdout).toContain("holdout-review-verdict-warning");
  });
});

// ── Test 4 — sad path: invalid --judge-votes exits non-zero ──

describe("sad-path: invalid arguments exit non-zero (fail-closed)", () => {
  it("--judge-votes 0 exits non-zero (0 is not a positive integer)", async () => {
    await withInjectedCandidate(
      WORKTREE_ROOT,
      await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8"),
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const { runShell } = await import("@platform/adapters/process-adapter.ts");
        const scriptPath = join(tmpDir, "skills", "canon", "evals", "run-evals.sh");
        const result = runShell(`bash "${scriptPath}" --judge-votes 0 --dry-run`, tmpDir, 10_000);

        // Must exit non-zero — invalid argument validation is fail-closed
        expect(result.ok).toBe(false);
        expect(result.exitCode).not.toBe(0);
        // Script prints an error message to stderr
        expect(result.stderr).toMatch(/must be a positive integer/i);
      },
    );
  });

  it("--judge-votes non-integer exits non-zero", async () => {
    await withInjectedCandidate(
      WORKTREE_ROOT,
      await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8"),
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const { runShell } = await import("@platform/adapters/process-adapter.ts");
        const scriptPath = join(tmpDir, "skills", "canon", "evals", "run-evals.sh");
        const result = runShell(`bash "${scriptPath}" --judge-votes abc --dry-run`, tmpDir, 10_000);

        expect(result.ok).toBe(false);
        expect(result.stderr).toMatch(/must be a positive integer/i);
      },
    );
  });

  it("unknown option exits non-zero", async () => {
    await withInjectedCandidate(
      WORKTREE_ROOT,
      await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8"),
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const { runShell } = await import("@platform/adapters/process-adapter.ts");
        const scriptPath = join(tmpDir, "skills", "canon", "evals", "run-evals.sh");
        const result = runShell(`bash "${scriptPath}" --unknown-flag --dry-run`, tmpDir, 10_000);

        expect(result.ok).toBe(false);
        expect(result.exitCode).not.toBe(0);
      },
    );
  });
});

// ── Test 5 — isolation: real evals dir is byte-unchanged after a real --dry-run ──

describe("isolation: real skills/canon/evals/ unchanged after real harness run (AC: isolation)", () => {
  it("real eval tree is byte-unchanged after withInjectedCandidate with dry-run", async () => {
    const hashBefore = await hashDir(EVALS_DIR);

    // Run the real harness (dry-run) against the real eval tree through withInjectedCandidate
    await withInjectedCandidate(
      WORKTREE_ROOT,
      "# modified candidate — should only land in temp dir",
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        // Verify inside the tmp dir: the modified content is visible
        const tmpContent = await readFile(
          join(tmpDir, "skills", "canon", "evals", "eval-set.json"),
          "utf-8",
        );
        expect(tmpContent).toBe("# modified candidate — should only land in temp dir");

        // Run the real harness on the modified tree
        const result = runSplit(tmpDir, "holdout", { dryRun: true, structuredJudge: false });

        // Dry-run exits 0 even with invalid JSON (jq parses the eval-set.json;
        // if the modified content is not valid JSON, the script may exit 1 or skip all cases)
        // We only verify the real EVALS_DIR is intact — the harness result is secondary here
        expect(typeof result.stdout).toBe("string");
      },
    );

    const hashAfter = await hashDir(EVALS_DIR);
    expect(hashAfter).toBe(hashBefore);
  });

  it("real eval tree is byte-unchanged even when the injected candidate is valid JSON", async () => {
    const hashBefore = await hashDir(EVALS_DIR);

    const identicalEvalSetContent = await readFile(join(EVALS_DIR, "eval-set.json"), "utf-8");

    await withInjectedCandidate(
      WORKTREE_ROOT,
      identicalEvalSetContent,
      "skills/canon/evals/eval-set.json",
      async (tmpDir) => {
        const result = runSplit(tmpDir, "holdout", { dryRun: true, structuredJudge: false });
        // With identity injection and dry-run: 3 holdout cases skipped, exit 0
        expect(result.ok).toBe(true);
      },
    );

    const hashAfter = await hashDir(EVALS_DIR);
    expect(hashAfter).toBe(hashBefore);
  });
});
