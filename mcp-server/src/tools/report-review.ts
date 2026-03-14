import { DriftStore, ReviewEntry } from "../drift/store.js";
import { randomBytes } from "crypto";

export interface ReviewViolationInput {
  principle_id: string;
  severity: string;
}

export interface ReviewScoreInput {
  rules: { passed: number; total: number };
  opinions: { passed: number; total: number };
  conventions: { passed: number; total: number };
}

export interface ReportReviewInput {
  files: string[];
  violations: ReviewViolationInput[];
  honored: string[];
  score: ReviewScoreInput;
  verdict?: "BLOCKING" | "WARNING" | "CLEAN";
}

export interface ReportReviewOutput {
  recorded: boolean;
  review_id: string;
  note: string;
}

export async function reportReview(
  input: ReportReviewInput,
  projectDir: string
): Promise<ReportReviewOutput> {
  // Remove any principle from honored if it also appears in violations
  const violatedIds = new Set(input.violations.map((v) => v.principle_id));
  const cleanHonored = input.honored.filter((id) => !violatedIds.has(id));

  const reviewId = `rev_${formatDate()}_${randomBytes(2).toString("hex")}`;
  const timestamp = new Date().toISOString();

  const verdict = input.verdict ?? deriveVerdict(input);

  const entry: ReviewEntry = {
    review_id: reviewId,
    timestamp,
    verdict,
    files: input.files,
    violations: input.violations,
    honored: cleanHonored,
    score: input.score,
  };

  const store = new DriftStore(projectDir);
  await store.appendReview(entry);

  return {
    recorded: true,
    review_id: reviewId,
    note: "Review logged. Results will appear in drift reports and inform learning suggestions.",
  };
}

function deriveVerdict(input: ReportReviewInput): "BLOCKING" | "WARNING" | "CLEAN" {
  const hasRuleViolation = input.violations.some((v) => v.severity === "rule");
  if (hasRuleViolation) return "BLOCKING";
  const hasOpinionViolation = input.violations.some((v) => v.severity === "strong-opinion");
  if (hasOpinionViolation) return "WARNING";
  return "CLEAN";
}

function formatDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
