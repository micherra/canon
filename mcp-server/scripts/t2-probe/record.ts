#!/usr/bin/env tsx
/**
 * record.ts — T2 probe live recorder CLI (throwaway measurement instrument).
 *
 * Invoked by the orchestrator as a background command immediately after the
 * initial full review returns (see root CLAUDE.md § Post-Step Effects "After
 * reviewer"). Resolves the reviewer's own diff (`{base}..{head}` in the
 * build worktree), runs it through the T2 checker (checker.ts), and appends
 * ONE JSON record to `.canon/t2-probe/checker-runs.jsonl`.
 *
 * TOTAL fail-open (AC2): every stage of the pipeline — head/branch
 * resolution, diff resolution, touched-files listing, rubric hashing, and
 * the checker call itself — is individually guarded. ANY failure in ANY of
 * those stages degrades the record to `failed_open: true` with whatever
 * fields did resolve; it never prevents the record from being appended, and
 * `main()` NEVER sets a non-zero exit code. This is an observation
 * instrument, never a gate — see DESIGN.md's deliberate fail-closed-by-default
 * exception (same class as the evaluator gate).
 *
 * Usage (from repo root):
 *   cd mcp-server && npx tsx scripts/t2-probe/record.ts \
 *     --worktree <path> --base <sha> --slug <slug> [--review-id <id>] \
 *     [--head <sha>] [--out <path>] [--timeout <ms>] [--root <dir>]
 *
 * canon:allow-unwired: T2 live-forward measurement instrument, CLI-invoked (not tool-registered)
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitDiff, gitExec } from "@platform/adapters/git-adapter.ts";
import { runShell } from "@platform/adapters/process-adapter.ts";
import { runCheckerOnDiff, type CheckerFinding, type ShellRunner } from "./checker.ts";

const DEFAULT_TIMEOUT_MS = 120_000; // probe-measured 28.5s on a tiny diff (PROBE-FINDINGS.md Probe 1); real diffs need headroom.
const RUBRIC_PATH = join(dirname(fileURLToPath(import.meta.url)), "rubric.md");

/** One recorded checker run — the unit persisted to `checker-runs.jsonl`. */
export type CheckerRunRecord = {
  record_id: string;
  timestamp: string;
  slug: string;
  branch: string;
  base_sha: string;
  head_sha: string;
  review_id?: string;
  touched_files: string[];
  findings: CheckerFinding[];
  failed_open: boolean;
  checker_elapsed_ms: number;
  rubric_hash: string;
};

export type RecorderOptions = {
  worktree: string;
  base: string;
  slug: string;
  reviewId?: string;
  head?: string;
  out?: string;
  timeout?: number;
  root?: string;
};

/** Injectable seams — defaults mirror checker.ts's pattern so tests never spawn real subprocesses. */
export type RecorderSeams = {
  shellRunner?: ShellRunner;
  gitExecFn?: typeof gitExec;
  gitDiffFn?: typeof gitDiff;
  appendLine?: (path: string, line: string) => void;
  readRubric?: (path: string) => string;
  now?: () => Date;
  randomSuffix?: () => string;
};

export type RunRecorderResult =
  | { ok: true; record: CheckerRunRecord }
  | { ok: false; reason: string; record: CheckerRunRecord };

function defaultAppendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`, "utf-8");
}

function defaultReadRubric(path: string): string {
  return readFileSync(path, "utf-8");
}

function defaultRandomSuffix(): string {
  return randomBytes(4).toString("hex");
}

function parseTouchedFiles(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Resolve the project root the same way sibling scripts do (measure.ts / regen-context-manifest.ts pattern). */
function resolveProjectDir(argRoot: string | undefined): string {
  if (argRoot) return argRoot;
  if (process.env.CANON_PROJECT_DIR) return process.env.CANON_PROJECT_DIR;
  const scriptDir = dirname(fileURLToPath(import.meta.url)); // mcp-server/scripts/t2-probe/
  return join(scriptDir, "..", "..", ".."); // three levels up -> repo root
}

/**
 * Run one recorder pass: resolve the reviewed diff, run the checker on it,
 * and append a record. TOTAL fail-open — see file header. Never throws.
 */
export function runRecorder(opts: RecorderOptions, seams: RecorderSeams = {}): RunRecorderResult {
  const {
    shellRunner,
    gitExecFn = gitExec,
    gitDiffFn = gitDiff,
    appendLine = defaultAppendLine,
    readRubric = defaultReadRubric,
    now = () => new Date(),
    randomSuffix = defaultRandomSuffix,
  } = seams;

  const timestamp = now().toISOString();
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const projectDir = resolveProjectDir(opts.root);
  const outPath = opts.out ?? join(projectDir, ".canon", "t2-probe", "checker-runs.jsonl");

  let degraded = false;

  let head = opts.head ?? "";
  if (!opts.head) {
    try {
      const result = gitExecFn(["rev-parse", "HEAD"], opts.worktree);
      if (result.ok) {
        head = result.stdout.trim();
      } else {
        degraded = true;
        head = "unknown";
      }
    } catch {
      degraded = true;
      head = "unknown";
    }
  }

  let branch = "unknown";
  try {
    const result = gitExecFn(["rev-parse", "--abbrev-ref", "HEAD"], opts.worktree);
    if (result.ok) {
      branch = result.stdout.trim();
    } else {
      degraded = true;
    }
  } catch {
    degraded = true;
  }

  let diff = "";
  try {
    const result = gitDiffFn([`${opts.base}..${head}`], opts.worktree);
    if (result.ok) {
      diff = result.stdout;
    } else {
      degraded = true;
    }
  } catch {
    degraded = true;
  }

  let touchedFiles: string[] = [];
  try {
    const result = gitExecFn(["diff", "--name-only", `${opts.base}..${head}`], opts.worktree);
    if (result.ok) {
      touchedFiles = parseTouchedFiles(result.stdout);
    } else {
      degraded = true;
    }
  } catch {
    degraded = true;
  }

  let rubricHash = "";
  try {
    rubricHash = createHash("sha256").update(readRubric(RUBRIC_PATH)).digest("hex");
  } catch {
    degraded = true;
  }

  let findings: CheckerFinding[] = [];
  let checkerFailedOpen = true;
  const checkerStart = performance.now();
  try {
    const checkerResult = runCheckerOnDiff(diff, RUBRIC_PATH, { cwd: opts.worktree, shellRunner, timeout });
    findings = checkerResult.findings;
    checkerFailedOpen = checkerResult.failed_open;
  } catch {
    degraded = true;
  }
  const checkerElapsedMs = Math.round(performance.now() - checkerStart);

  const record: CheckerRunRecord = {
    base_sha: opts.base,
    branch,
    checker_elapsed_ms: checkerElapsedMs,
    failed_open: degraded || checkerFailedOpen,
    findings,
    head_sha: head,
    record_id: `t2r_${now().getTime()}_${randomSuffix()}`,
    review_id: opts.reviewId,
    rubric_hash: rubricHash,
    slug: opts.slug,
    timestamp,
    touched_files: touchedFiles,
  };

  try {
    appendLine(outPath, JSON.stringify(record));
    return { ok: true, record };
  } catch (err) {
    process.stderr.write(`record.ts: failed to append record: ${String(err)}\n`);
    return { ok: false, reason: "append_failed", record };
  }
}

function parseArgs(argv: string[]): RecorderOptions {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };
  const timeoutArg = get("--timeout");
  return {
    base: get("--base") ?? "",
    head: get("--head"),
    out: get("--out"),
    reviewId: get("--review-id"),
    root: get("--root"),
    slug: get("--slug") ?? "",
    timeout: timeoutArg ? Number(timeoutArg) : undefined,
    worktree: get("--worktree") ?? "",
  };
}

/** Never throws, never sets a non-zero exit code — total fail-open at the CLI boundary too. */
function main(): void {
  try {
    const opts = parseArgs(process.argv.slice(2));
    runRecorder(opts);
  } catch (err) {
    process.stderr.write(`record.ts: recorder failed unexpectedly: ${String(err)}\n`);
  }
}

// Only run main() when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
