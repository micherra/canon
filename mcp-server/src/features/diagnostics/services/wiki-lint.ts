/**
 * Wiki-Lint Service — Pure lint check functions for Canon meta-layer artifacts.
 *
 * Checks for:
 * 1. Cross-file contradictions (conflicting imperative statements about same entity)
 * 2. Orphan principles (no violations and no references)
 * 3. Stale file references (backtick-quoted paths that no longer exist)
 * 4. Missing examples sections in principle definitions
 *
 * All functions are pure: they receive pre-loaded data and return typed findings.
 * No I/O, no LLM calls.
 *
 * Canon principles:
 * - simplicity-first: plain exported functions, no class wrappers
 * - functions-do-one-thing: each check handles exactly one lint category
 * - no-llm-calls-in-mcp-tools: contradiction detection uses regex pattern matching only
 * - pure-io-service-split: all I/O happens in the tool layer, not here
 */

import type { Principle } from "@shared/parser.ts";

// ---- Types ----

export type ContradictionFinding = {
  entity: string;
  file_a: string;
  claim_a: string;
  file_b: string;
  claim_b: string;
};

export type OrphanPrincipleFinding = {
  principle_id: string;
  severity: string;
  file_path: string;
  reason: string;
};

export type StaleRefFinding = {
  source_file: string;
  referenced_path: string;
  line_number: number;
};

export type MissingExampleFinding = {
  principle_id: string;
  severity: string;
  file_path: string;
};

export type CitedPathFinding = {
  source_file: string;
  cited_path: string;
  line_number: number;
};

export type WikiLintOutput = {
  contradictions: ContradictionFinding[];
  orphan_principles: OrphanPrincipleFinding[];
  stale_refs: StaleRefFinding[];
  missing_examples: MissingExampleFinding[];
  cited_paths: CitedPathFinding[];
  summary: {
    total_findings: number;
    files_scanned: number;
    principles_checked: number;
  };
};

export type AssembleWikiLintInput = {
  contradictions: ContradictionFinding[];
  orphans: OrphanPrincipleFinding[];
  staleRefs: StaleRefFinding[];
  missingExamples: MissingExampleFinding[];
  citedPaths: CitedPathFinding[];
  filesScanned: number;
  principlesChecked: number;
};

// ---- Imperative statement patterns ----

/**
 * Stop words that mark the end of an entity noun phrase.
 * We capture only up to the first preposition/conjunction.
 */
const STOP_WORD_RE = /\b(?:for|in|on|with|to|from|when|as|at|by|of|and|or|via|unless|into)\b/i;

/**
 * Trim a raw entity string to just the leading noun phrase by stopping at
 * the first stop word and removing trailing punctuation.
 */
function trimToNounPhrase(raw: string): string {
  const m = STOP_WORD_RE.exec(raw);
  const clipped = m ? raw.slice(0, m.index) : raw;
  return clipped.replace(/[.,;!?]+$/, "").trim();
}

/**
 * Positive imperative patterns: must, should, always, prefer.
 * Module-level global regex (note: /gim flags) — safe to use with matchAll() because
 * matchAll() creates its own iterator and resets lastIndex internally.
 */
const POSITIVE_RE_SRC =
  /\b(?:must|should|always|prefer)\s+(?!not\b)(?:use\s+)?([a-zA-Z_][\w\s-]*?)(?:[.,;]|\s+(?:for|in|on|with|to|from|when|as|at|by|of|and|or|via|unless|into)\b|$)/gim;

/**
 * Negative imperative patterns: never, avoid, do not, don't, must not, MUST NOT.
 */
const NEGATIVE_RE_SRC =
  /\b(?:never|avoid|do\s+not|don't|must\s+not|MUST\s+NOT)\s+(?:use\s+)?([a-zA-Z_][\w\s-]*?)(?:[.,;]|\s+(?:for|in|on|with|to|from|when|as|at|by|of|and|or|via|unless|into)\b|$)/gim;

type ImperativeStatement = {
  entity: string;
  claim: string;
  polarity: "positive" | "negative";
  file: string;
};

/**
 * Normalize an entity string for comparison:
 * - lowercase
 * - strip articles (a, an, the)
 * - normalize worktree_path / worktree path aliases
 * - collapse whitespace
 * - trim
 */
function normalizeEntity(raw: string): string {
  let s = raw.toLowerCase().trim();
  s = s.replace(/\b(a|an|the)\b/g, "").trim();
  s = s.replace(/worktree[_ ]path/g, "worktree");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.,;!?]+$/, "").trim();
  return s;
}

/** Collect all imperative statements from a single file's content. */
function extractStatements(content: string, filePath: string): ImperativeStatement[] {
  const statements: ImperativeStatement[] = [];

  for (const m of content.matchAll(POSITIVE_RE_SRC)) {
    const raw = trimToNounPhrase((m[1] ?? "").trim());
    if (raw.length < 2) continue;
    statements.push({
      claim: m[0].trim(),
      entity: normalizeEntity(raw),
      file: filePath,
      polarity: "positive",
    });
  }

  for (const m of content.matchAll(NEGATIVE_RE_SRC)) {
    const raw = trimToNounPhrase((m[1] ?? "").trim());
    if (raw.length < 2) continue;
    statements.push({
      claim: m[0].trim(),
      entity: normalizeEntity(raw),
      file: filePath,
      polarity: "negative",
    });
  }

  return statements;
}

/** Detect one cross-file polarity conflict for a given entity group. */
function findConflictsForEntity(
  entity: string,
  stmts: ImperativeStatement[],
): ContradictionFinding[] {
  const positives = stmts.filter((s) => s.polarity === "positive");
  const negatives = stmts.filter((s) => s.polarity === "negative");
  const findings: ContradictionFinding[] = [];

  for (const pos of positives) {
    for (const neg of negatives) {
      if (pos.file === neg.file) continue;
      const duplicate = findings.some(
        (f) =>
          f.entity === entity &&
          ((f.file_a === pos.file && f.file_b === neg.file) ||
            (f.file_a === neg.file && f.file_b === pos.file)),
      );
      if (!duplicate) {
        findings.push({
          claim_a: pos.claim,
          claim_b: neg.claim,
          entity,
          file_a: pos.file,
          file_b: neg.file,
        });
      }
    }
  }

  return findings;
}

/**
 * Check for cross-file contradictions: conflicting imperative statements about
 * the same entity in DIFFERENT files.
 *
 * Only flags cross-file conflicts; same-file contradictions are the author's
 * responsibility.
 */
export function checkContradictions(
  claudeMdFiles: Array<{ path: string; content: string }>,
): ContradictionFinding[] {
  const allStatements: ImperativeStatement[] = claudeMdFiles.flatMap((f) =>
    extractStatements(f.content, f.path),
  );

  const byEntity = new Map<string, ImperativeStatement[]>();
  for (const stmt of allStatements) {
    const group = byEntity.get(stmt.entity) ?? [];
    group.push(stmt);
    byEntity.set(stmt.entity, group);
  }

  const findings: ContradictionFinding[] = [];
  for (const [entity, stmts] of byEntity) {
    findings.push(...findConflictsForEntity(entity, stmts));
  }
  return findings;
}

// ---- Orphan Principles ----

/**
 * Check for orphan principles: principles with zero violations AND zero references.
 *
 * A principle is orphaned when it appears in neither the violated set nor
 * the referenced set — suggesting it is never enforced or consulted.
 */
export function checkOrphanPrinciples(
  principles: Principle[],
  violatedIds: Set<string>,
  referencedIds: Set<string>,
): OrphanPrincipleFinding[] {
  return principles
    .filter((p) => !violatedIds.has(p.id) && !referencedIds.has(p.id))
    .map((p) => ({
      file_path: p.filePath,
      principle_id: p.id,
      reason: "zero violations AND zero references",
      severity: p.severity,
    }));
}

// ---- Stale References ----

/**
 * Pattern for backtick-quoted strings that look like file paths.
 * Matches backtick-wrapped strings containing a slash and a file extension.
 * Group 1: the path string inside backticks.
 */
const BACKTICK_PATH_RE = /`([a-zA-Z_.][a-zA-Z0-9_./-]*\.[a-zA-Z]{1,6})`/g;

/**
 * Compute the 1-based line number for a character offset in a string.
 */
function lineNumberOf(content: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, content.length);
  for (let i = 0; i < limit; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/** Return true if the candidate string should be excluded from stale-ref checking. */
function isExcludedRef(candidate: string): boolean {
  return (
    candidate.startsWith("http://") ||
    candidate.startsWith("https://") ||
    candidate.startsWith("#") ||
    !candidate.includes("/")
  );
}

/**
 * Collect stale-ref findings from a single file.
 */
function collectStaleRefsInFile(
  file: { path: string; content: string },
  existsOnDisk: (path: string) => boolean,
): StaleRefFinding[] {
  const findings: StaleRefFinding[] = [];
  for (const m of file.content.matchAll(BACKTICK_PATH_RE)) {
    const candidate = m[1] ?? "";
    if (isExcludedRef(candidate)) continue;
    if (!existsOnDisk(candidate)) {
      findings.push({
        line_number: lineNumberOf(file.content, m.index ?? 0),
        referenced_path: candidate,
        source_file: file.path,
      });
    }
  }
  return findings;
}

/**
 * Check for stale file references: backtick-quoted paths in file content that
 * no longer exist on disk.
 *
 * Skips:
 * - URLs (http://, https://)
 * - Anchor links (#)
 * - Bare filenames with no directory component (no slash)
 */
export function checkStaleRefs(
  files: Array<{ path: string; content: string }>,
  existsOnDisk: (path: string) => boolean,
): StaleRefFinding[] {
  return files.flatMap((f) => collectStaleRefsInFile(f, existsOnDisk));
}

// ---- Missing Examples ----

/** Check if a principle body has a non-empty Examples section. */
function hasNonEmptyExamples(body: string): boolean {
  const match = body.match(/^## Examples\s*$/im);
  if (!match) return false;
  const afterHeading = body.slice((match.index ?? 0) + match[0].length);
  const untilNext = afterHeading.split(/^## /m)[0];
  return untilNext.trim().length > 0;
}

/**
 * Check for missing Examples sections in principle definitions.
 *
 * A principle is flagged when:
 * - its body has no `## Examples` heading (case-insensitive), OR
 * - the Examples section exists but is empty (only whitespace before the next
 *   `## ` heading or end of body).
 */
export function checkMissingExamples(principles: Principle[]): MissingExampleFinding[] {
  return principles
    .filter((p) => !hasNonEmptyExamples(p.body ?? ""))
    .map((p) => ({ file_path: p.filePath, principle_id: p.id, severity: p.severity }));
}

// ---- Cited Paths ----

/**
 * Pattern for backtick-quoted strings that look like file paths in reference docs.
 * Matches a leading alpha char, then word chars / dots / slashes / hyphens, with a
 * recognized file extension. Requires at least one slash (enforced by isExcludedCitedPath).
 * Group 1: the path string inside backticks.
 */
const CITED_PATH_RE = /`([a-zA-Z][\w./-]*\.(?:sh|ts|js|md|json|yaml|yml))`/g;

/**
 * Return true if the candidate path should be excluded from cited-path checking.
 *
 * Conservative exclusions — false positives are worse than misses:
 * - Contains template variables: ${...}
 * - Contains placeholder chars: < > { }
 * - Starts with http:// or https://
 * - Starts with # (anchor)
 * - Has no slash (bare filename)
 */
export function isExcludedCitedPath(candidate: string): boolean {
  if (candidate.includes("${")) return true;
  if (/[<>{}]/.test(candidate)) return true;
  if (candidate.startsWith("http://") || candidate.startsWith("https://")) return true;
  if (candidate.startsWith("#")) return true;
  if (!candidate.includes("/")) return true;
  return false;
}

/** True if a line is the opening of an illustrative fenced block. */
function isIllustrativeFenceOpen(line: string): boolean {
  return /^```/.test(line) && /example|hypothetical|template/i.test(line);
}

/** True if a line closes a fenced block. */
function isFenceClose(line: string): boolean {
  return /^```/.test(line);
}

type CitedPathScanCtx = {
  sourceFile: string;
  existsOnDisk: (path: string) => boolean;
  findings: CitedPathFinding[];
};

/** Scan a single non-fence line for non-resolving cited paths. */
function scanLineForCitedPaths(line: string, lineNumber: number, ctx: CitedPathScanCtx): void {
  CITED_PATH_RE.lastIndex = 0;
  for (const m of line.matchAll(CITED_PATH_RE)) {
    const candidate = m[1] ?? "";
    if (isExcludedCitedPath(candidate)) continue;
    if (!ctx.existsOnDisk(candidate)) {
      ctx.findings.push({
        cited_path: candidate,
        line_number: lineNumber,
        source_file: ctx.sourceFile,
      });
    }
  }
}

/** Collect cited-path findings for one file, skipping illustrative fenced blocks. */
function collectCitedPathsInFile(
  file: { path: string; content: string },
  existsOnDisk: (path: string) => boolean,
): CitedPathFinding[] {
  const ctx: CitedPathScanCtx = { existsOnDisk, findings: [], sourceFile: file.path };
  const originalLines = file.content.split("\n");
  let inIllustrativeFence = false;

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i];
    if (!inIllustrativeFence) {
      if (isIllustrativeFenceOpen(line)) {
        inIllustrativeFence = true;
      } else {
        scanLineForCitedPaths(line, i + 1, ctx);
      }
    } else if (isFenceClose(line)) {
      inIllustrativeFence = false;
    }
  }

  return ctx.findings;
}

/**
 * Check for cited-path findings in a set of files.
 *
 * Per file: scans line-by-line for backtick-quoted paths matching CITED_PATH_RE,
 * skipping lines inside illustrative fenced blocks (labeled example/hypothetical/template).
 * Excluded paths are skipped. Non-resolving paths produce a CitedPathFinding with the
 * 1-based line number from the original content.
 *
 * Pure: existsOnDisk is the only effect seam.
 */
export function checkCitedPaths(
  files: Array<{ path: string; content: string }>,
  existsOnDisk: (path: string) => boolean,
): CitedPathFinding[] {
  return files.flatMap((f) => collectCitedPathsInFile(f, existsOnDisk));
}

// ---- Assembler ----

/**
 * Assemble all lint findings into a WikiLintOutput with summary counts.
 */
export function assembleWikiLintOutput(input: AssembleWikiLintInput): WikiLintOutput {
  const {
    contradictions,
    orphans,
    staleRefs,
    missingExamples,
    citedPaths,
    filesScanned,
    principlesChecked,
  } = input;
  return {
    cited_paths: citedPaths,
    contradictions,
    missing_examples: missingExamples,
    orphan_principles: orphans,
    stale_refs: staleRefs,
    summary: {
      files_scanned: filesScanned,
      principles_checked: principlesChecked,
      total_findings:
        contradictions.length +
        orphans.length +
        staleRefs.length +
        missingExamples.length +
        citedPaths.length,
    },
  };
}
