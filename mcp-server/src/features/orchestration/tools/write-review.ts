import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ConfidenceAnnotation } from "@shared/lib/confidence.ts";
import { deriveSubsystemKey } from "@shared/lib/subsystem-key.ts";
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

/**
 * Structural interface for area memory writes — describes only the method needed
 * to store area observations. Callers (app layer) provide an AreaMemoryDao instance;
 * write-review never imports AreaMemoryDao directly.
 */
export type AreaMemoryWriter = {
  insertObservation(input: {
    subsystem_key: string;
    content: string;
    source: string;
    workflow_slug?: string;
  }): void;
};

/** Format a violation description for area observation content. */
function formatViolationDesc(v: {
  principle_id: string;
  severity: string;
  description?: string;
}): string {
  return v.description
    ? `${v.principle_id}: ${v.description}`
    : `${v.principle_id} (${v.severity})`;
}

/** Format a compact content string from a list of violation descriptions. */
function formatSubsystemContent(violations: string[]): string {
  if (violations.length === 1) return violations[0];
  const preview = violations.slice(0, 3).join("; ");
  const overflow = violations.length > 3 ? ` (+${violations.length - 3} more)` : "";
  return `${violations.length} violations: ${preview}${overflow}`;
}

/** Group violations by subsystem key. Violations without file_path are skipped. */
function groupViolationsBySubsystem(
  violations: WriteReviewInput["violations"],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const v of violations) {
    if (!v.file_path) continue;
    const key = deriveSubsystemKey(v.file_path);
    const existing = grouped.get(key) ?? [];
    existing.push(formatViolationDesc(v));
    grouped.set(key, existing);
  }
  return grouped;
}

/**
 * Extract area observations from review violations and store them.
 * Only runs for BLOCKING or WARNING reviews (CLEAN reviews produce no observations).
 * Groups violations by subsystem to minimize observation count.
 * Fail-open: errors in observation writes never surface to callers.
 */
function extractAndStoreAreaObservations(
  input: WriteReviewInput,
  mappedVerdict: string,
  areaMemoryWriter?: AreaMemoryWriter,
): void {
  if (!areaMemoryWriter) return;
  if (mappedVerdict !== "BLOCKING" && mappedVerdict !== "WARNING") return;

  for (const [subsystemKey, violations] of groupViolationsBySubsystem(input.violations)) {
    try {
      areaMemoryWriter.insertObservation({
        content: formatSubsystemContent(violations),
        source: "reviewer",
        subsystem_key: subsystemKey,
        workflow_slug: input.slug,
      });
    } catch (err) {
      console.warn(
        "[write-review] area observation insert failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** Escape a value for safe inclusion in a markdown table cell. */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/\r\n?|\n/g, " ");
}

export type WriteReviewInput = {
  workspace: string;
  slug: string;
  verdict: "approved" | "approved_with_concerns" | "changes_required" | "blocked" | "pending";
  violations: Array<{
    principle_id: string;
    severity: string;
    file_path?: string;
    description?: string;
    fix?: string;
    confidence?: ConfidenceAnnotation;
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
  verdict: "BLOCKING" | "WARNING" | "CLEAN" | "IN_PROGRESS";
  violation_count: number;
};

export const VERDICT_MAP: Record<
  WriteReviewInput["verdict"],
  "BLOCKING" | "WARNING" | "CLEAN" | "IN_PROGRESS"
> = {
  approved: "CLEAN",
  approved_with_concerns: "WARNING",
  blocked: "BLOCKING",
  changes_required: "WARNING",
  pending: "IN_PROGRESS",
};

const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;
const PRINCIPLE_ID_PATTERN = /^[a-zA-Z0-9_\-/.]+$/;

/**
 * Validate write-review inputs. Returns a ToolResult error on the first
 * validation failure, or null when all inputs are valid.
 */
function validateInput(input: WriteReviewInput): { reviewsDir: string } | ToolResult<never> {
  if (!isAbsolute(input.workspace)) {
    return toolError(
      "INVALID_INPUT",
      `workspace must be an absolute path; got: "${input.workspace}"`,
    );
  }

  if (!SLUG_PATTERN.test(input.slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${input.slug}": must match /^[a-zA-Z0-9_-]+$/`,
    );
  }

  const reviewsDir = resolve(join(input.workspace, "reviews"));
  const workspaceResolved = resolve(input.workspace);
  const rel = relative(workspaceResolved, reviewsDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return toolError("INVALID_INPUT", "Workspace resolves outside expected path");
  }

  for (const id of input.honored) {
    if (!PRINCIPLE_ID_PATTERN.test(id)) {
      return toolError(
        "INVALID_INPUT",
        `Invalid honored principle ID "${id}": must match /^[a-zA-Z0-9_\\-/.]+$/`,
      );
    }
  }

  return { reviewsDir };
}

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
  mappedVerdict: "BLOCKING" | "WARNING" | "CLEAN" | "IN_PROGRESS",
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
  lines.push("| Principle | Severity | Location | Confidence |");
  lines.push("|-----------|----------|----------|------------|");
  for (const v of input.violations) {
    const filePath = v.file_path ?? "(none)";
    const confidenceTier = v.confidence ? v.confidence.tier.toUpperCase() : "—";
    lines.push(
      `| ${escapeMdCell(v.principle_id)} | ${escapeMdCell(v.severity)} | ${escapeMdCell(filePath)} | ${confidenceTier} |`,
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
 * The reserved principle_id used by Stage 1.5 correctness-scan findings.
 * These are advisory human-facing annotations, not Canon principle violations.
 * They must NEVER be persisted to file_violation_history or path_effects,
 * which are principle-keyed analytics stores.
 */
export const CORRECTNESS_SCAN_PRINCIPLE_ID = "correctness-scan";

/**
 * Update file_violation_history and path_effects tables after a review.
 *
 * Non-blocking: catches all errors internally. Signal persistence
 * failures must never prevent a review from being written.
 *
 * correctness-scan violations are intentionally excluded — they use a
 * reserved pseudo-principle_id and must not pollute principle-keyed
 * analytics or drift signals.
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
  _verdict: "BLOCKING" | "WARNING" | "CLEAN" | "IN_PROGRESS",
): void {
  try {
    const now = new Date().toISOString();

    // Filter out correctness-scan pseudo-violations before persisting to
    // principle-keyed history. They appear in the human-readable review
    // output but must not skew drift signals or file-violation analytics.
    const principleViolations = violations.filter(
      (v) => v.principle_id !== CORRECTNESS_SCAN_PRINCIPLE_ID,
    );

    const violationMap = groupViolations(principleViolations);
    persistViolationHistory(signals, violationMap, now);

    // Compute per-file violation count by summing counts from violationMap
    const violationCountByFile = new Map<string, number>();
    for (const [key, data] of violationMap) {
      const fp = key.split("::")[0];
      violationCountByFile.set(fp, (violationCountByFile.get(fp) ?? 0) + data.count);
    }
    persistPathEffects(signals, files, violationCountByFile, now);
  } catch (err) {
    // best-effort: signal persistence is background telemetry; review already written
    console.warn(
      "[canon] write-review: signal persistence failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Optional adapter for computing server-side confidence on violations. */
export type ConfidenceAdapter = {
  computeViolationConfidence: (violation: {
    principle_id: string;
    severity: string;
    file_path?: string;
  }) => ConfidenceAnnotation;
};

export async function writeReview(
  input: WriteReviewInput,
  signals?: SignalWriter,
  confidenceAdapter?: ConfidenceAdapter,
  areaMemoryWriter?: AreaMemoryWriter,
): Promise<ToolResult<WriteReviewResult>> {
  const validated = validateInput(input);
  if ("ok" in validated && !validated.ok) return validated;
  const { reviewsDir } = validated as { reviewsDir: string };

  // Populate missing confidence annotations server-side when adapter is provided.
  // Runs before generateMarkdown so the Confidence column reflects computed values.
  if (confidenceAdapter) {
    for (const violation of input.violations) {
      if (!violation.confidence) {
        violation.confidence = confidenceAdapter.computeViolationConfidence(violation);
      }
    }
  }

  const mappedVerdict = VERDICT_MAP[input.verdict];
  const markdown = generateMarkdown(input, mappedVerdict);

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

  if (signals) {
    updateFileViolationHistory(signals, input.files, input.violations, mappedVerdict);
  }

  try {
    extractAndStoreAreaObservations(input, mappedVerdict, areaMemoryWriter);
  } catch (err) {
    console.warn(
      "[write-review] area observation extraction failed:",
      err instanceof Error ? err.message : err,
    );
  }

  return toolOk({
    meta_path: metaPath,
    path: reviewPath,
    verdict: mappedVerdict,
    violation_count: input.violations.length,
  });
}
