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
  { id: "todo", category: "lazy" as const, regex: /\bTODO\b/i, description: "TODO marker" },
  { id: "fixme", category: "lazy" as const, regex: /\bFIXME\b/i, description: "FIXME marker" },
  { id: "hack", category: "lazy" as const, regex: /\bHACK\b/i, description: "HACK marker" },
  { id: "xxx", category: "lazy" as const, regex: /\bXXX\b/, description: "XXX marker" },
  {
    id: "placeholder",
    category: "lazy" as const,
    regex: /\bplaceholder\b/i,
    description: "Placeholder text",
  },
  {
    id: "hardcoded-secret",
    category: "lazy" as const,
    regex: /(?:password|secret|token|api_key)\s*[:=]\s*["'][^"']{3,}["']/i,
    description: "Hardcoded credential-like string",
  },
  {
    id: "as-any",
    category: "hacky" as const,
    regex: /\bas\s+any\b/,
    description: "TypeScript as any cast",
  },
  {
    id: "as-unknown",
    category: "hacky" as const,
    regex: /\bas\s+unknown\b/,
    description: "TypeScript as unknown cast",
  },
  {
    id: "eslint-disable",
    category: "hacky" as const,
    regex: /eslint-disable/,
    description: "ESLint suppression",
  },
  {
    id: "ts-ignore",
    category: "hacky" as const,
    regex: /@ts-ignore/,
    description: "TypeScript ignore directive",
  },
  {
    id: "ts-expect-error",
    category: "hacky" as const,
    regex: /@ts-expect-error/,
    description: "TypeScript expect-error directive",
  },
] as const;

// ─── Diff parser ──────────────────────────────────────────────────────────────

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

    // Skip --- a/... and diff --git ... lines
    if (rawLine.startsWith("--- ") || rawLine.startsWith("diff --git ") || rawLine.startsWith("index ")) {
      continue;
    }

    // Hunk header: @@ -X,Y +A,B @@
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentLineNumber = parseInt(hunkMatch[1], 10);
      continue;
    }

    // Skip if no file context yet
    if (!currentFile) continue;

    if (rawLine.startsWith("+")) {
      result.push({
        file_path: currentFile,
        line_number: currentLineNumber,
        content: rawLine.slice(1),
        type: "add",
      });
      currentLineNumber++;
    } else if (rawLine.startsWith("-")) {
      result.push({
        file_path: currentFile,
        line_number: currentLineNumber,
        content: rawLine.slice(1),
        type: "remove",
      });
      // Removed lines do not advance the post-patch line counter
    } else if (rawLine.startsWith(" ")) {
      result.push({
        file_path: currentFile,
        line_number: currentLineNumber,
        content: rawLine.slice(1),
        type: "context",
      });
      currentLineNumber++;
    }
    // Lines that don't match any prefix (e.g., "\ No newline at end of file") are skipped
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
          pattern_id: pattern.id,
          category: pattern.category,
          file_path: line.file_path,
          line_number: line.line_number,
          matched_text: line.content.trim(),
        });
      }
    }
  }

  return findings;
}

// ─── Bare-catch detector ──────────────────────────────────────────────────────

const CATCH_OPEN_PATTERN = /catch\s*(?:\([^)]*\))?\s*\{/;
const COMMENT_PATTERN = /\/\/|\/\*/;

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

    // Found a catch line. Check for comment on this line.
    if (COMMENT_PATTERN.test(line.content)) continue;

    // Check the preceding line for a comment.
    const prevLine = i > 0 ? addedLines[i - 1] : null;
    if (prevLine && prevLine.type === "add" && COMMENT_PATTERN.test(prevLine.content)) continue;

    // Now scan the block body between { and matching }.
    // The catch line always ends with `{` opening the catch block.
    // We start at depth 1 (the catch block is open) regardless of any `}`
    // earlier on the same line (e.g. `} catch (e) {` closes the try block
    // then opens the catch block).
    let depth = 1;
    let hasComment = false;
    let hasNonEmptyContent = false;
    let j = i + 1;

    while (j < addedLines.length && depth > 0) {
      const bodyLine = addedLines[j];
      if (bodyLine.type !== "add") {
        j++;
        continue;
      }

      const trimmed = bodyLine.content.trim();

      if (COMMENT_PATTERN.test(trimmed)) {
        hasComment = true;
      }

      // Track brace depth
      for (const ch of trimmed) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (depth === 0) break;
      }

      // Content inside block (before closing brace at depth 0)
      if (depth > 0 && trimmed !== "" && trimmed !== "}") {
        hasNonEmptyContent = true;
      }

      j++;
    }

    if (hasComment || hasNonEmptyContent) continue;

    findings.push({
      pattern_id: "bare-catch",
      category: "hacky",
      file_path: line.file_path,
      line_number: line.line_number,
      matched_text: line.content.trim(),
    });
  }

  return findings;
}

/** Count net open braces in a string (positive means more { than }) */
function countBraceDepth(s: string): number {
  let depth = 0;
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

// ─── File-scope overlap ───────────────────────────────────────────────────────

/**
 * Compare declared files against actually-changed files from the diff.
 */
export const computeFileScopeOverlap = (
  declared: string[],
  actual: string[],
): FileScopeOverlap => {
  const declaredSet = new Set(declared);
  const actualSet = new Set(actual);
  const inScope = actual.filter((f) => declaredSet.has(f));
  const outOfScope = actual.filter((f) => !declaredSet.has(f));
  const missingPlanned = declared.filter((f) => !actualSet.has(f));
  return {
    declared,
    actual,
    in_scope: inScope.length,
    out_of_scope: outOfScope.length,
    out_of_scope_files: outOfScope,
    missing_planned: missingPlanned,
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
    findings,
    file_scope: fileScope,
    diff_stats: diffStats,
    finding_counts: {
      lazy: lazyCount,
      hacky: hackyCount,
    },
  });
}
