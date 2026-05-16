import { gitDiff } from "@platform/adapters/git-adapter.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export type EvaluateStepInput = {
  workspace: string;
  slug: string;
  base_commit: string;
  worktree_path: string;
  declared_files: string[];
};

export type PatternFinding = {
  pattern_id: string;
  category: "lazy" | "hacky";
  file_path: string;
  line_number: number;
  matched_text: string;
};

export type FileScopeOverlap = {
  declared: string[];
  actual: string[];
  in_scope: number;
  out_of_scope: number;
  out_of_scope_files: string[];
  missing_planned: string[];
};

export type DiffStats = {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
};

export type EvaluateStepOutput = {
  findings: PatternFinding[];
  file_scope: FileScopeOverlap;
  diff_stats: DiffStats;
  finding_counts: {
    lazy: number;
    hacky: number;
  };
};

// ─── Internal types ───────────────────────────────────────────────────────────

type DiffLine = {
  file_path: string;
  line_number: number;
  content: string;
  type: "add" | "remove" | "context";
};

// ─── Constants ────────────────────────────────────────────────────────────────

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

const PATTERN_CATALOG = [
  { category: "lazy" as const, description: "TODO marker", id: "todo", regex: /\bTODO\b/i },
  { category: "lazy" as const, description: "FIXME marker", id: "fixme", regex: /\bFIXME\b/i },
  { category: "lazy" as const, description: "HACK marker", id: "hack", regex: /\bHACK\b/i },
  { category: "lazy" as const, description: "XXX marker", id: "xxx", regex: /\bXXX\b/ },
  {
    category: "lazy" as const,
    description: "Placeholder text",
    id: "placeholder",
    regex: /\bplaceholder\b/i,
  },
  {
    category: "lazy" as const,
    description: "Hardcoded credential-like string",
    id: "hardcoded-secret",
    regex: /(?:password|secret|token|api_key)\s*[:=]\s*["'][^"']{3,}["']/i,
  },
  {
    category: "hacky" as const,
    description: "TypeScript as any cast",
    id: "as-any",
    regex: /\bas\s+any\b/,
  },
  {
    category: "hacky" as const,
    description: "TypeScript as unknown cast",
    id: "as-unknown",
    regex: /\bas\s+unknown\b/,
  },
  {
    category: "hacky" as const,
    description: "ESLint suppression",
    id: "eslint-disable",
    regex: /eslint-disable/,
  },
  {
    category: "hacky" as const,
    description: "TypeScript ignore directive",
    id: "ts-ignore",
    regex: /@ts-ignore/,
  },
  {
    category: "hacky" as const,
    description: "TypeScript expect-error directive",
    id: "ts-expect-error",
    regex: /@ts-expect-error/,
  },
] as const;

// ─── Diff parser ──────────────────────────────────────────────────────────────

/** Returns true if the line is a diff meta-header to skip entirely. */
function isDiffMetaHeader(rawLine: string): boolean {
  return (
    rawLine.startsWith("--- ") || rawLine.startsWith("diff --git ") || rawLine.startsWith("index ")
  );
}

/**
 * Classify and push a content line (add / remove / context) onto result.
 * Returns the updated line number.
 */
function classifyDiffLine(
  rawLine: string,
  currentFile: string,
  currentLineNumber: number,
  result: DiffLine[],
): number {
  if (rawLine.startsWith("+")) {
    result.push({
      content: rawLine.slice(1),
      file_path: currentFile,
      line_number: currentLineNumber,
      type: "add",
    });
    return currentLineNumber + 1;
  }
  if (rawLine.startsWith("-")) {
    result.push({
      content: rawLine.slice(1),
      file_path: currentFile,
      line_number: currentLineNumber,
      type: "remove",
    });
    // Removed lines do not advance the post-patch line counter
    return currentLineNumber;
  }
  if (rawLine.startsWith(" ")) {
    result.push({
      content: rawLine.slice(1),
      file_path: currentFile,
      line_number: currentLineNumber,
      type: "context",
    });
    return currentLineNumber + 1;
  }
  // Lines that don't match any prefix (e.g., "\ No newline at end of file") are skipped
  return currentLineNumber;
}

/**
 * Parse a unified git diff output into structured DiffLine entries.
 *
 * Tracks the current file via `--- a/` and `+++ b/` lines.
 * Extracts line numbers from `@@ -X,Y +A,B @@` hunk headers.
 * Classifies lines by prefix: `+` = add, `-` = remove, space = context.
 */
export function parseDiff(diffOutput: string): DiffLine[] {
  const lines = diffOutput.split("\n");
  const result: DiffLine[] = [];

  let currentFile = "";
  let currentLineNumber = 0;

  for (const rawLine of lines) {
    // File header: `+++ b/path/to/file`
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice(6); // strip "+++ b/"
      currentLineNumber = 0;
      continue;
    }

    if (isDiffMetaHeader(rawLine)) continue;

    // Hunk header: @@ -X,Y +A,B @@
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLineNumber = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Skip if no file context yet
    if (!currentFile) continue;

    currentLineNumber = classifyDiffLine(rawLine, currentFile, currentLineNumber, result);
  }

  return result;
}

// ─── Pattern scanner ──────────────────────────────────────────────────────────

/**
 * Scan added lines only against the pattern catalog.
 * Returns a PatternFinding for every match.
 */
export function scanPatterns(addedLines: DiffLine[]): PatternFinding[] {
  const findings: PatternFinding[] = [];

  for (const line of addedLines) {
    if (line.type !== "add") continue;

    for (const pattern of PATTERN_CATALOG) {
      if (pattern.regex.test(line.content)) {
        findings.push({
          category: pattern.category,
          file_path: line.file_path,
          line_number: line.line_number,
          matched_text: line.content.trim(),
          pattern_id: pattern.id,
        });
      }
    }
  }

  return findings;
}

// ─── Bare-catch detector ──────────────────────────────────────────────────────

const CATCH_OPEN_PATTERN = /catch\s*(?:\([^)]*\))?\s*\{/;
const COMMENT_PATTERN = /\/\/|\/\*/;

/** Count net open braces in a string (positive means more { than }) */
function countBraceDepth(s: string): number {
  let depth = 0;
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

/** Returns true when an added line immediately preceding the catch line has a comment. */
function hasPrecedingComment(addedLines: DiffLine[], catchIndex: number): boolean {
  if (catchIndex === 0) return false;
  const prev = addedLines[catchIndex - 1];
  return prev.type === "add" && COMMENT_PATTERN.test(prev.content);
}

type CatchBodyResult = { hasComment: boolean; hasNonEmptyContent: boolean };

/**
 * Scan the body of a catch block starting at `startIndex`.
 * Returns whether the block contains a comment or non-empty content.
 */
function scanCatchBody(addedLines: DiffLine[], startIndex: number): CatchBodyResult {
  let depth = 1;
  let hasComment = false;
  let hasNonEmptyContent = false;

  for (let j = startIndex; j < addedLines.length && depth > 0; j++) {
    const bodyLine = addedLines[j];
    if (bodyLine.type !== "add") continue;

    const trimmed = bodyLine.content.trim();

    if (COMMENT_PATTERN.test(trimmed)) {
      hasComment = true;
    }

    depth += countBraceDepth(trimmed);

    // Content inside block (before closing brace at depth 0)
    if (depth > 0 && trimmed !== "" && trimmed !== "}") {
      hasNonEmptyContent = true;
    }
  }

  return { hasComment, hasNonEmptyContent };
}

/**
 * Stateful bare-catch detector.
 *
 * Scans added lines for `catch { ... }` blocks that have no explanatory
 * comment. Per CONVENTIONS.md: a catch block with a comment is allowed.
 *
 * Logic:
 * 1. Detect catch block opening
 * 2. Look at: the catch line itself, the preceding line, and lines inside the block
 * 3. If no comment found and block body is empty/whitespace-only → flag as bare-catch
 */
export function detectBareCatches(addedLines: DiffLine[]): PatternFinding[] {
  const findings: PatternFinding[] = [];

  for (let i = 0; i < addedLines.length; i++) {
    const line = addedLines[i];
    if (line.type !== "add") continue;
    if (!CATCH_OPEN_PATTERN.test(line.content)) continue;

    // Skip: comment on the catch line itself
    if (COMMENT_PATTERN.test(line.content)) continue;

    // Skip: comment on the preceding line
    if (hasPrecedingComment(addedLines, i)) continue;

    // Scan the block body for comment or content
    // We start at depth 1 (the catch block is open) regardless of any `}`
    // earlier on the same line (e.g. `} catch (e) {` closes the try block
    // then opens the catch block).
    const { hasComment, hasNonEmptyContent } = scanCatchBody(addedLines, i + 1);
    if (hasComment || hasNonEmptyContent) continue;

    findings.push({
      category: "hacky",
      file_path: line.file_path,
      line_number: line.line_number,
      matched_text: line.content.trim(),
      pattern_id: "bare-catch",
    });
  }

  return findings;
}

// ─── File-scope overlap ───────────────────────────────────────────────────────

/**
 * Compare declared files against actually-changed files from the diff.
 */
export const computeFileScopeOverlap = (declared: string[], actual: string[]): FileScopeOverlap => {
  const declaredSet = new Set(declared);
  const actualSet = new Set(actual);
  const inScope = actual.filter((f) => declaredSet.has(f));
  const outOfScope = actual.filter((f) => !declaredSet.has(f));
  const missingPlanned = declared.filter((f) => !actualSet.has(f));
  return {
    actual,
    declared,
    in_scope: inScope.length,
    missing_planned: missingPlanned,
    out_of_scope: outOfScope.length,
    out_of_scope_files: outOfScope,
  };
};

// ─── Diff statistics ──────────────────────────────────────────────────────────

/**
 * Compute diff statistics from parsed diff lines.
 * Returns file count, lines added, lines removed.
 */
function computeDiffStats(allLines: DiffLine[]): DiffStats {
  const files = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of allLines) {
    files.add(line.file_path);
    if (line.type === "add") linesAdded++;
    else if (line.type === "remove") linesRemoved++;
  }

  return {
    files_changed: files.size,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  };
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Extract structural signals from a git diff for step-transition evaluation.
 *
 * Pure structural analysis — no LLM calls.
 */
export async function evaluateStep(
  input: EvaluateStepInput,
): Promise<ToolResult<EvaluateStepOutput>> {
  // 1. Validate slug
  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }

  // 2. Run git diff
  const diffResult = gitDiff(["--unified=0", `${input.base_commit}..HEAD`], input.worktree_path);

  if (!diffResult.ok) {
    return toolError(
      "UNEXPECTED",
      `git diff failed: ${diffResult.stderr || diffResult.stdout || "unknown error"}`,
    );
  }

  // 3. Parse diff into structured lines
  const allLines = parseDiff(diffResult.stdout);
  const addedLines = allLines.filter((l) => l.type === "add");

  // 4. Scan added lines against pattern catalog
  const patternFindings = scanPatterns(addedLines);

  // 5. Run bare-catch detection
  const catchFindings = detectBareCatches(allLines);

  // 6. Combine all findings
  const findings = [...patternFindings, ...catchFindings];

  // 7. Compute file-scope overlap
  const actualFiles = [...new Set(allLines.map((l) => l.file_path))];
  const fileScope = computeFileScopeOverlap(input.declared_files, actualFiles);

  // 8. Compute diff stats
  const diffStats = computeDiffStats(allLines);

  // 9. Compute finding counts
  const lazyCount = findings.filter((f) => f.category === "lazy").length;
  const hackyCount = findings.filter((f) => f.category === "hacky").length;

  return toolOk({
    diff_stats: diffStats,
    file_scope: fileScope,
    finding_counts: {
      hacky: hackyCount,
      lazy: lazyCount,
    },
    findings,
  });
}
