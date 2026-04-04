import { DriftStore } from "../drift/store.ts";
import type { ReviewViolation } from "../schema.ts";
import { generateId } from "../utils/id.ts";

export type StorePrReviewInput = {
  pr_number?: number;
  branch?: string;
  last_reviewed_sha?: string;
  verdict: "BLOCKING" | "WARNING" | "CLEAN";
  files: string[];
  violations: Array<{
    principle_id: string;
    severity: string;
    file_path?: string;
    impact_score?: number;
    message?: string;
  }>;
  honored: string[];
  score: {
    rules: { passed: number; total: number };
    opinions: { passed: number; total: number };
    conventions: { passed: number; total: number };
  };
  file_priorities?: Array<{ path: string; priority_score: number }>;
  recommendations?: Array<{
    file_path?: string;
    title: string;
    message: string;
    source: "principle" | "holistic";
  }>;
};

export type StorePrReviewOutput = {
  recorded: boolean;
  review_id: string;
};

export async function storePrReview(
  input: StorePrReviewInput,
  projectDir: string,
): Promise<StorePrReviewOutput> {
  const store = new DriftStore(projectDir);
  const review_id = generateId("rev");
  const timestamp = new Date().toISOString();

  await store.appendReview({
    review_id,
    timestamp,
    ...(input.pr_number !== undefined ? { pr_number: input.pr_number } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.last_reviewed_sha !== undefined
      ? { last_reviewed_sha: input.last_reviewed_sha }
      : {}),
    files: input.files,
    honored: input.honored,
    score: input.score,
    verdict: input.verdict,
    violations: input.violations as ReviewViolation[],
    ...(input.file_priorities !== undefined ? { file_priorities: input.file_priorities } : {}),
    ...(input.recommendations !== undefined ? { recommendations: input.recommendations } : {}),
  });

  return { recorded: true, review_id };
}
