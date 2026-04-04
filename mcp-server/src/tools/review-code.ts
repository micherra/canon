import { existsSync } from "node:fs";
import { join } from "node:path";
import { CANON_DIR, CANON_FILES } from "../shared/constants.ts";
import { computeFileInsightMaps, KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import type { FileMetrics } from "../graph/kg-types.ts";
import { loadAllPrinciples, matchPrinciples } from "../matcher.ts";
import { loadConfigNumber } from "../utils/config.ts";

export type ReviewCodeInput = {
  code: string;
  file_path: string;
  context?: string;
};

export type PrincipleForReview = {
  principle_id: string;
  principle_title: string;
  severity: string;
  body: string;
  review_hint: "likely-honored" | "check-carefully" | "neutral";
};

export type ReviewGraphContext = Pick<
  FileMetrics,
  "in_degree" | "out_degree" | "is_hub" | "in_cycle" | "layer" | "impact_score" | "layer_violations"
>;

export type ReviewCodeOutput = {
  summary: string;
  principles_to_evaluate: PrincipleForReview[];
  code: string;
  file_path: string;
  context?: string;
  graph_context?: ReviewGraphContext;
};

/**
 * Quick heuristic to hint whether a principle is likely honored or needs careful review.
 * This reduces false positives by giving the reviewer a signal before evaluation.
 * The reviewer can override these hints — they're suggestions, not verdicts.
 */
function computeReviewHint(principleId: string, code: string): PrincipleForReview["review_hint"] {
  switch (principleId) {
    case "secrets-never-in-code": {
      // Look for common secret patterns
      const secretPatterns = [
        /(?:api[_-]?key|secret|password|token|credential)\s*[:=]\s*["'][^"']{8,}/i,
        /(?:sk_live|sk_test|pk_live|pk_test)_[a-zA-Z0-9]/,
        /(?:postgres|mysql|mongodb|redis):\/\/[^/]*:[^@]*@/,
        /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
      ];
      return secretPatterns.some((p) => p.test(code)) ? "check-carefully" : "likely-honored";
    }
    case "validate-at-trust-boundaries": {
      // Check for validation patterns (zod, joi, yup, manual checks)
      const hasValidation = /safeParse|validate|schema\.|\.parse\(|Joi\.|yup\.|z\.object/i.test(
        code,
      );
      return hasValidation ? "likely-honored" : "check-carefully";
    }
    case "fail-closed-by-default": {
      // Check for try/catch that returns/throws on error (not silently continuing)
      const hasTryCatch = /try\s*\{/.test(code);
      const hasFailOpen = /catch[^}]*return\s+true|catch[^}]*Infinity|catch[^}]*allow/i.test(code);
      if (hasFailOpen) return "check-carefully";
      if (hasTryCatch) return "likely-honored";
      return "neutral";
    }
    case "thin-handlers": {
      // Short handlers are likely thin
      const lines = code.split("\n").filter((l) => l.trim()).length;
      return lines <= 20 ? "likely-honored" : "check-carefully";
    }
    default:
      return "neutral";
  }
}

const DEFAULT_MAX_REVIEW_PRINCIPLES = 15;

function loadMaxReviewPrinciples(projectDir: string): Promise<number> {
  return loadConfigNumber(
    projectDir,
    "review.max_review_principles",
    DEFAULT_MAX_REVIEW_PRINCIPLES,
  );
}

type PrincipleEntry = Awaited<ReturnType<typeof loadAllPrinciples>>[number];

/** Cap matched principles: rules always included, non-rules fill remaining budget. */
function capPrinciples(matched: PrincipleEntry[], maxReviewPrinciples: number): PrincipleEntry[] {
  const rules = matched.filter((p) => p.severity === "rule");
  const nonRules = matched.filter((p) => p.severity !== "rule");
  const budgetForNonRules = Math.max(0, maxReviewPrinciples - rules.length);
  return [...rules, ...nonRules.slice(0, budgetForNonRules)];
}

/** Load graph context using KgQuery. Returns null graph context when DB is absent. */
async function loadGraphContext(
  projectDir: string,
  filePath: string,
  allPrinciples: PrincipleEntry[],
  capped: PrincipleEntry[],
): Promise<{
  graphContext?: ReviewGraphContext;
  metrics: FileMetrics | null;
  injected: PrincipleEntry[];
}> {
  const injected: PrincipleEntry[] = [];
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(dbPath)) return { graphContext: undefined, injected, metrics: null };

  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
    const kgQuery = new KgQuery(db);
    const insightMaps = computeFileInsightMaps(db);
    const metrics = kgQuery.getFileMetrics(filePath, {
      cycleMemberPaths: insightMaps.cycleMemberPaths,
      hubPaths: insightMaps.hubPaths,
      layerViolationsByPath: insightMaps.layerViolationsByPath,
    });
    if (!metrics) return { graphContext: undefined, injected, metrics: null };

    const graphContext: ReviewGraphContext = {
      impact_score: metrics.impact_score,
      in_cycle: metrics.in_cycle,
      in_degree: metrics.in_degree,
      is_hub: metrics.is_hub,
      layer: metrics.layer,
      layer_violations: metrics.layer_violations,
      out_degree: metrics.out_degree,
    };

    if (
      metrics.layer_violation_count > 0 &&
      !capped.some((c) => c.id === "bounded-context-boundaries")
    ) {
      const found = allPrinciples.find((a) => a.id === "bounded-context-boundaries");
      if (found) injected.push(found);
    }
    if (metrics.in_cycle && !capped.some((c) => c.id === "architectural-fitness-functions")) {
      const found = allPrinciples.find((a) => a.id === "architectural-fitness-functions");
      if (found) injected.push(found);
    }

    return { graphContext, injected, metrics };
  } catch {
    return { graphContext: undefined, injected, metrics: null };
  } finally {
    db?.close();
  }
}

/** Build a human-readable graph hint string from metrics. */
function buildGraphHint(metrics: FileMetrics | null): string {
  if (!metrics) return "";
  const hints: string[] = [];
  if (metrics.is_hub) hints.push(`hub file (${metrics.in_degree} dependents)`);
  if (metrics.in_cycle)
    hints.push(`in circular dependency with ${metrics.cycle_peers.length} file(s)`);
  if (metrics.layer_violation_count > 0)
    hints.push(`${metrics.layer_violation_count} layer boundary violation(s)`);
  return hints.length > 0 ? ` Graph context: ${hints.join("; ")}.` : "";
}

/** Build a hint note about heuristic review hints. */
function buildHintNote(principlesToEvaluate: PrincipleForReview[]): string {
  const likelyHonored = principlesToEvaluate.filter(
    (p) => p.review_hint === "likely-honored",
  ).length;
  if (likelyHonored === 0) return "";
  const checkCarefully = principlesToEvaluate.filter(
    (p) => p.review_hint === "check-carefully",
  ).length;
  return ` Heuristic hints: ${likelyHonored} likely-honored, ${checkCarefully} check-carefully. Principles marked "likely-honored" appear to be satisfied by the code — verify but do not flag as violated unless you find a concrete bad pattern. Focus review effort on "check-carefully" and "neutral" principles.`;
}

export async function reviewCode(
  input: ReviewCodeInput,
  projectDir: string,
  pluginDir: string,
): Promise<ReviewCodeOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const maxReviewPrinciples = await loadMaxReviewPrinciples(projectDir);

  const matched = matchPrinciples(allPrinciples, { file_path: input.file_path });
  const capped = capPrinciples(matched, maxReviewPrinciples);

  const { graphContext, metrics, injected } = await loadGraphContext(
    projectDir,
    input.file_path,
    allPrinciples,
    capped,
  );

  const allForReview = [...capped, ...injected];
  const principlesToEvaluate: PrincipleForReview[] = allForReview.map((p) => ({
    body: p.body,
    principle_id: p.id,
    principle_title: p.title,
    review_hint: computeReviewHint(p.id, input.code),
    severity: p.severity,
  }));

  const ruleCount = allForReview.filter((p) => p.severity === "rule").length;
  const opinionCount = allForReview.filter((p) => p.severity === "strong-opinion").length;
  const conventionCount = allForReview.filter((p) => p.severity === "convention").length;

  const omitted = matched.length - capped.length;
  const truncated = omitted > 0 ? ` (${omitted} lower-priority principles omitted)` : "";
  const graphHint = buildGraphHint(metrics);
  const hintNote = buildHintNote(principlesToEvaluate);

  const summary = `${allForReview.length} principle(s) matched for review (${ruleCount} rules, ${opinionCount} strong-opinions, ${conventionCount} conventions)${truncated}.${graphHint}${hintNote} Evaluate each against the code below.`;

  return {
    code: input.code,
    context: input.context,
    file_path: input.file_path,
    graph_context: graphContext,
    principles_to_evaluate: principlesToEvaluate,
    summary,
  };
}
