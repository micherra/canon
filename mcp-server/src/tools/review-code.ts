import { readFile } from "fs/promises";
import { join } from "path";
import { matchPrinciples, loadAllPrinciples } from "../matcher.js";

export interface ReviewCodeInput {
  code: string;
  file_path: string;
  context?: string;
}

export interface PrincipleForReview {
  principle_id: string;
  principle_title: string;
  severity: string;
  body: string;
}

export interface ReviewCodeOutput {
  summary: string;
  principles_to_evaluate: PrincipleForReview[];
  code: string;
  file_path: string;
  context?: string;
}

const DEFAULT_MAX_REVIEW_PRINCIPLES = 15;

async function loadMaxReviewPrinciples(projectDir: string): Promise<number> {
  try {
    const configPath = join(projectDir, ".canon", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    return config?.review?.max_review_principles ?? DEFAULT_MAX_REVIEW_PRINCIPLES;
  } catch {
    return DEFAULT_MAX_REVIEW_PRINCIPLES;
  }
}

export async function reviewCode(
  input: ReviewCodeInput,
  projectDir: string,
  pluginDir: string
): Promise<ReviewCodeOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const maxReviewPrinciples = await loadMaxReviewPrinciples(projectDir);

  const matched = matchPrinciples(allPrinciples, {
    file_path: input.file_path,
  });

  // Cap matched principles to prevent unbounded context consumption.
  // Rules are always included (safety-critical), then fill remaining budget
  // with strong-opinions and conventions. Already sorted by severity.
  const capped = matched.slice(0, maxReviewPrinciples);

  const principlesToEvaluate: PrincipleForReview[] = capped.map((p) => ({
    principle_id: p.id,
    principle_title: p.title,
    severity: p.severity,
    body: p.body,
  }));

  const ruleCount = capped.filter((p) => p.severity === "rule").length;
  const opinionCount = capped.filter((p) => p.severity === "strong-opinion").length;
  const conventionCount = capped.filter((p) => p.severity === "convention").length;

  const truncated = matched.length > maxReviewPrinciples
    ? ` (${matched.length - maxReviewPrinciples} lower-priority principles omitted)`
    : "";
  const summary = `${capped.length} principle(s) matched for review (${ruleCount} rules, ${opinionCount} strong-opinions, ${conventionCount} conventions)${truncated}. Evaluate each against the code below.`;

  return {
    summary,
    principles_to_evaluate: principlesToEvaluate,
    code: input.code,
    file_path: input.file_path,
    context: input.context,
  };
}
