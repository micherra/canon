/**
 * checker.ts — the T2 probe's fail-open Haiku checker driver.
 *
 * A throwaway measurement instrument (see PROBE-FINDINGS.md / DESIGN.md for
 * this build's slug). Forks the `canon:evaluator` agent's proven scaffold —
 * Haiku + a frozen rubric + `---VERDICT---`-delimited findings + fail-open
 * parse — NOT `evaluate_step` (which is a pure structural regex scanner with
 * no rubric seam). Never wired into any gate, hook, or verify path.
 *
 * canon:allow-unwired: throwaway T2 measurement probe, never wired to production
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell } from "@platform/adapters/process-adapter.ts";
import type { ProcessResult } from "@shared/lib/tool-result.ts";

/** A single per-file finding emitted by the checker. */
export type CheckerFinding = {
  file_path: string;
  line: number | null;
  description: string;
};

/**
 * Result of one checker run. `failed_open: true` means the model/subprocess
 * boundary degraded (error, timeout, empty output, unparseable format) and
 * `findings` is always `[]` in that case — the caller must never treat a
 * `failed_open` result as a negative (no-findings) verdict for measurement
 * purposes; the measurement harness counts it separately.
 */
export type CheckerResult = {
  findings: CheckerFinding[];
  failed_open: boolean;
};

/** Shape of the `runShell` seam — injectable so unit tests never spawn a real subprocess. */
export type ShellRunner = (command: string, cwd: string, timeout?: number) => ProcessResult;

export type RunCheckerOptions = {
  /** Working directory for the subprocess. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Subprocess timeout in ms. Defaults to 60s (Haiku + a diff-sized prompt). */
  timeout?: number;
  /** Injectable shell seam — defaults to the real `runShell` adapter. */
  shellRunner?: ShellRunner;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const VERDICT_START = "---VERDICT---";
const VERDICT_END = "---END_VERDICT---";

/**
 * Run the frozen T2 single-principle checker over a unified diff.
 *
 * Assembles `rubric + diff` into one prompt, writes it to a temp file, and
 * invokes `claude -p --model haiku` via the `runShell` subprocess seam with
 * the prompt piped in over stdin redirection — never interpolated into the
 * shell command string itself, since a diff may contain arbitrary quotes,
 * backticks, and newlines that would otherwise break out of shell quoting.
 * Parses the `---VERDICT---`/`---END_VERDICT---` delimited findings block
 * (same format as `agents/evaluator.md`).
 *
 * FAILS OPEN, exhaustively: unreadable rubric, subprocess error, non-zero
 * exit, timeout, empty stdout, missing/unparseable delimiters, OR a throw
 * from the shell-invocation step itself (the real `runShell` adapter never
 * throws, but the injectable `shellRunner` seam admits one that could) all
 * return `{ findings: [], failed_open: true }`. Never throws. There is no
 * code path in which this function returns a value that could gate a build.
 */
export function runCheckerOnDiff(
  diff: string,
  rubricPath: string,
  options: RunCheckerOptions = {},
): CheckerResult {
  const { cwd = process.cwd(), timeout = DEFAULT_TIMEOUT_MS, shellRunner = runShell } = options;

  let rubric: string;
  try {
    rubric = readFileSync(rubricPath, "utf-8");
  } catch {
    return { failed_open: true, findings: [] };
  }

  const prompt = `${rubric}\n\n\`\`\`diff\n${diff}\n\`\`\`\n`;

  let tmpDir: string;
  let promptFile: string;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "t2-probe-"));
    promptFile = join(tmpDir, "prompt.txt");
    writeFileSync(promptFile, prompt, "utf-8");
  } catch {
    return { failed_open: true, findings: [] };
  }

  let result: ProcessResult;
  try {
    const command = `claude -p --model haiku --output-format text < '${promptFile}'`;
    result = shellRunner(command, cwd, timeout);
  } catch {
    // Defensive: the real `runShell` adapter never throws, but the injectable
    // `ShellRunner` seam admits a hostile/buggy runner that could. Total
    // fail-open requires this be caught too, not just non-ok/timeout/empty
    // results — see docstring above.
    return { failed_open: true, findings: [] };
  } finally {
    try {
      rmSync(tmpDir, { force: true, recursive: true });
    } catch {
      // best-effort temp-file cleanup only — never affects the checker's result
    }
  }

  if (!result.ok || result.timedOut || result.stdout.length === 0) {
    return { failed_open: true, findings: [] };
  }

  return parseVerdict(result.stdout);
}

/** Parse the delimited verdict block; fail open on any structural mismatch. */
function parseVerdict(stdout: string): CheckerResult {
  const startIdx = stdout.indexOf(VERDICT_START);
  const endIdx = stdout.indexOf(VERDICT_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { failed_open: true, findings: [] };
  }

  const block = stdout.slice(startIdx + VERDICT_START.length, endIdx);
  return { failed_open: false, findings: parseFindings(block) };
}

/** Parse the YAML-indented `FINDINGS:` list into typed findings. Never throws. */
function parseFindings(block: string): CheckerFinding[] {
  const findingsIdx = block.indexOf("FINDINGS:");
  if (findingsIdx === -1) return [];

  const findings: CheckerFinding[] = [];
  let current: Partial<CheckerFinding> | null = null;

  const flush = () => {
    if (current?.file_path !== undefined && current.description !== undefined) {
      findings.push({
        description: current.description,
        file_path: current.file_path,
        line: current.line ?? null,
      });
    }
  };

  for (const rawLine of block.slice(findingsIdx + "FINDINGS:".length).split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("- ")) {
      flush();
      current = {};
      applyField(current, line.slice(2));
    } else if (current && line.length > 0) {
      applyField(current, line);
    }
  }
  flush();

  return findings;
}

/** Apply one `key: value` YAML-ish line to a partial finding. Unknown keys are ignored. */
function applyField(target: Partial<CheckerFinding>, fieldLine: string): void {
  const colonIdx = fieldLine.indexOf(":");
  if (colonIdx === -1) return;

  const key = fieldLine.slice(0, colonIdx).trim();
  const rawValue = fieldLine
    .slice(colonIdx + 1)
    .trim()
    .replace(/^"(.*)"$/, "$1");

  if (key === "file_path") {
    target.file_path = rawValue;
  } else if (key === "description") {
    target.description = rawValue;
  } else if (key === "line") {
    target.line = rawValue === "" || rawValue === "null" ? null : Number(rawValue);
  }
}
