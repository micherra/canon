import { matchPrinciples, loadAllPrinciples } from "../matcher.js";
import { loadConfigNumber } from "../utils/config.js";

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

function loadMaxReviewPrinciples(projectDir: string): Promise<number> {
  return loadConfigNumber(projectDir, "review.max_review_principles", DEFAULT_MAX_REVIEW_PRINCIPLES);
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
  // Rules are always included (safety-critical — they block commits),
  // then fill remaining budget with strong-opinions and conventions.
  const rules = matched.filter((p) => p.severity === "rule");
  const nonRules = matched.filter((p) => p.severity !== "rule");
  const budgetForNonRules = Math.max(0, maxReviewPrinciples - rules.length);
  const capped = [...rules, ...nonRules.slice(0, budgetForNonRules)];

  const principlesToEvaluate: PrincipleForReview[] = capped.map((p) => ({
    principle_id: p.id,
    principle_title: p.title,
    severity: p.severity,
    body: p.body,
  }));

  const ruleCount = rules.length;
  const opinionCount = capped.filter((p) => p.severity === "strong-opinion").length;
  const conventionCount = capped.filter((p) => p.severity === "convention").length;

  const omitted = matched.length - capped.length;
  const truncated = omitted > 0
    ? ` (${omitted} lower-priority principles omitted)`
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
