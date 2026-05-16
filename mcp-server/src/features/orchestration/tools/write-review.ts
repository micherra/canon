import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

/**
 * Structural interface for signal persistence — describes only the 4 methods
 * that updateFileViolationHistory needs. Callers (app layer) provide a
 * DriftDbSignals instance; write-review never imports from platform/storage/drift.
 */
export type SignalWriter = {
  getFileViolationHistory(filePaths: string[]): Array<{
    file_path: string;
    principle_id: string;
    violation_count: number;
    first_seen: string;
    last_seen: string;
  }>;
  upsertFileViolation(input: {
    file_path: string;
    principle_id: string;
    violation_count: number;
    first_seen: string;
    last_seen: string;
  }): void;
  getPathEffects(filePaths: string[]): Array<{
    file_path: string;
    total_violations: number;
    total_reviews: number;
    last_violation_at: string | null;
    last_clean_at: string | null;
    clean_streak: number;
    violation_streak: number;
  }>;
  upsertPathEffect(input: {
    file_path: string;
    total_violations: number;
    total_reviews: number;
    last_violation_at: string | null;
    last_clean_at: string | null;
    clean_streak: number;
    violation_streak: number;
  }): void;
};

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, " ");
}

export type WriteReviewInput = {
  workspace: string;
  slug: string;
  verdict: "approved" | "approved_with_concerns" | "changes_required" | "blocked";
  violations: Array<{
    principle_id: string;
    severity: string;
    file_path?: string;
    description?: string;
    fix?: string;
  }>;
  honored: string[];
  score: {
    rules: { passed: number; total: number };
    opinions: { passed: number; total: number };
    conventions: { passed: number; total: number };
  };
  files: string[];
};

export type WriteReviewResult = {
  path: string;
  meta_path: string;
  verdict: "BLOCKING" | "WARNING" | "CLEAN";
  violation_count: number;
};

export const VERDICT_MAP: Record<WriteReviewInput["verdict"], "BLOCKING" | "WARNING" | "CLEAN"> = {
  approved: "CLEAN",
  approved_with_concerns: "WARNING",
  blocked: "BLOCKING",
  changes_required: "WARNING",
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Generate normalized REVIEW.md content.
 *
 * Format:
 * - YAML frontmatter with mapped verdict
 * - ## Canon Review — Verdict: {MAPPED}
 * - #### Violations table (principle_id | severity | file_path)
 * - #### Honored list (- **principle_id**)
 * - #### Score table (layer | rules | opinions | conventions)
 */
function generateMarkdown(
  input: WriteReviewInput,
  mappedVerdict: "BLOCKING" | "WARNING" | "CLEAN",
): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`verdict: ${mappedVerdict}`);
  lines.push("---");
  lines.push("");

  // Heading
  lines.push(`## Canon Review — Verdict: ${mappedVerdict}`);
  lines.push("");

  // Violations section
  lines.push("#### Violations");
  lines.push("");
  lines.push("| Principle | Severity | Location |");
  lines.push("|-----------|----------|----------|");
  for (const v of input.violations) {
    const filePath = v.file_path ?? "(none)";
    lines.push(
      `| ${escapeMdCell(v.principle_id)} | ${escapeMdCell(v.severity)} | ${escapeMdCell(filePath)} |`,
    );
  }
  lines.push("");

  // Honored section
  lines.push("#### Honored");
  lines.push("");
  for (const id of input.honored) {
    lines.push(`- **${id}**`);
  }
  lines.push("");

  // Score section
  lines.push("#### Score");
  lines.push("");
  lines.push("| Layer | Rules | Opinions | Conventions |");
  lines.push("|-------|-------|----------|-------------|");
  lines.push(
    `| overall | ${input.score.rules.passed} / ${input.score.rules.total} | ${input.score.opinions.passed} / ${input.score.opinions.total} | ${input.score.conventions.passed} / ${input.score.conventions.total} |`,
  );
  lines.push("");

  return lines.join("\n");
}

// Internal violation type used by signal persistence helpers
type ViolationEntry = { principle_id: string; severity: string; file_path?: string };

/**
 * Group violations by (file_path::principle_id) key, accumulating counts.
 * Violations without file_path are skipped (validate-at-trust-boundaries).
 */
function groupViolations(
  violations: ViolationEntry[],
): Map<string, { count: number; principle_id: string }> {
  const violationMap = new Map<string, { count: number; principle_id: string }>();
  for (const v of violations) {
    if (!v.file_path) continue;
    const key = `${v.file_path}::${v.principle_id}`;
    const existing = violationMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      violationMap.set(key, { count: 1, principle_id: v.principle_id });
    }
  }
  return violationMap;
}

/** Persist accumulated violation counts to file_violation_history. */
function persistViolationHistory(
  signals: SignalWriter,
  violationMap: Map<string, { count: number; principle_id: string }>,
  now: string,
): void {
  for (const [key, data] of violationMap) {
    const filePath = key.split("::")[0];
    const existing = signals
      .getFileViolationHistory([filePath])
      .find((r) => r.principle_id === data.principle_id);

    signals.upsertFileViolation({
      file_path: filePath,
      first_seen: existing?.first_seen ?? now,
      last_seen: now,
      principle_id: data.principle_id,
      violation_count: (existing?.violation_count ?? 0) + data.count,
    });
  }
}

/** Payload shape for a path_effects upsert (mirrors UpsertPathEffectInput). */
type PathEffectPayload = {
  file_path: string;
  total_violations: number;
  total_reviews: number;
  last_violation_at: string | null;
  last_clean_at: string | null;
  clean_streak: number;
  violation_streak: number;
};

/** Existing path-effect row shape (subset of PathEffectRow fields we read). */
type ExistingPathEffect = {
  clean_streak: number;
  last_clean_at: string | null;
  last_violation_at: string | null;
  total_reviews: number;
  total_violations: number;
  violation_streak: number;
};

/**
 * Build the upsert payload for a single file's path effect.
 * Encapsulates the streak and timestamp logic for readability.
 */
function buildPathEffectPayload(
  filePath: string,
  violationCount: number,
  existing: ExistingPathEffect | undefined,
  now: string,
): PathEffectPayload {
  return {
    clean_streak: violationCount > 0 ? 0 : (existing?.clean_streak ?? 0) + 1,
    file_path: filePath,
    last_clean_at: violationCount > 0 ? (existing?.last_clean_at ?? null) : now,
    last_violation_at: violationCount > 0 ? now : (existing?.last_violation_at ?? null),
    total_reviews: (existing?.total_reviews ?? 0) + 1,
    total_violations: (existing?.total_violations ?? 0) + violationCount,
    violation_streak: violationCount > 0 ? (existing?.violation_streak ?? 0) + 1 : 0,
  };
}

/** Persist per-file review metadata to path_effects. */
function persistPathEffects(
  signals: SignalWriter,
  files: string[],
  violationCountByFile: Map<string, number>,
  now: string,
): void {
  for (const filePath of files) {
    const existing = signals.getPathEffects([filePath])[0];
    const violationCount = violationCountByFile.get(filePath) ?? 0;
    signals.upsertPathEffect(buildPathEffectPayload(filePath, violationCount, existing, now));
  }
}

/**
 * Update file_violation_history and path_effects tables after a review.
 *
 * Non-blocking: catches all errors internally. Signal persistence
 * failures must never prevent a review from being written.
 *
 * @param signals - SignalWriter instance provided by the caller (app layer)
 * @param files - files that were reviewed
 * @param violations - violations found in the review
 * @param _verdict - review verdict (reserved for future use)
 */
export function updateFileViolationHistory(
  signals: SignalWriter,
  files: string[],
  violations: ViolationEntry[],
  _verdict: "BLOCKING" | "WARNING" | "CLEAN",
): void {
  try {
    const now = new Date().toISOString();

    const violationMap = groupViolations(violations);
    persistViolationHistory(signals, violationMap, now);

    // Compute per-file violation count by summing counts from violationMap
    const violationCountByFile = new Map<string, number>();
    for (const [key, data] of violationMap) {
      const fp = key.split("::")[0];
      violationCountByFile.set(fp, (violationCountByFile.get(fp) ?? 0) + data.count);
    }
    persistPathEffects(signals, files, violationCountByFile, now);
  } catch {
    // Non-blocking: signal persistence failures are silently swallowed.
    // The review itself was already written successfully.
  }
}

export async function writeReview(
  input: WriteReviewInput,
  signals?: SignalWriter,
): Promise<ToolResult<WriteReviewResult>> {
  // Validate slug
  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }

  // Validate path traversal safety
  const reviewsDir = resolve(join(input.workspace, "reviews"));
  const workspaceResolved = resolve(input.workspace);
  const rel = relative(workspaceResolved, reviewsDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return toolError("INVALID_INPUT", `Workspace resolves outside expected path`);
  }

  // Map verdict
  const mappedVerdict = VERDICT_MAP[input.verdict];

  // Validate honored entries — reject IDs that would break markdown pattern
  const PRINCIPLE_ID_PATTERN = /^[a-zA-Z0-9_\-/.]+$/;
  for (const id of input.honored) {
    if (!PRINCIPLE_ID_PATTERN.test(id)) {
      return toolError(
        "INVALID_INPUT",
        `Invalid honored principle ID "${id}": must match /^[a-zA-Z0-9_\\-/.]+$/`,
      );
    }
  }

  // Generate markdown
  const markdown = generateMarkdown(input, mappedVerdict);

  // Write files
  await mkdir(reviewsDir, { recursive: true });
  const reviewPath = join(reviewsDir, "REVIEW.md");
  const metaPath = join(reviewsDir, "REVIEW.meta.json");

  await writeFile(reviewPath, markdown, "utf-8");

  const meta = {
    _type: "review" as const,
    _version: 1,
    files: input.files,
    honored: input.honored,
    score: input.score,
    slug: input.slug,
    verdict: mappedVerdict,
    verdict_original: input.verdict,
    violations: input.violations,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  // Persist path effects to signal tables (non-blocking)
  if (signals) {
    updateFileViolationHistory(signals, input.files, input.violations, mappedVerdict);
  }

  return toolOk({
    meta_path: metaPath,
    path: reviewPath,
    verdict: mappedVerdict,
    violation_count: input.violations.length,
  });
}
