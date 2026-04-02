import { DriftStore } from "../drift/store.ts";
import type { ReportInput, ReviewEntry } from "../schema.ts";
import { generateId } from "../utils/id.ts";

export interface ReportOutput {
  recorded: boolean;
  id: string;
  note: string;
}

export async function report(input: ReportInput, projectDir: string): Promise<ReportOutput> {
  const store = new DriftStore(projectDir);

  switch (input.type) {
    case "review":
      return recordReview(input, store);
    default: {
      const exhaustive: never = input.type;
      throw new Error(`Unknown report type: ${exhaustive}`);
    }
  }
}

async function recordReview(
  review: Extract<ReportInput, { type: "review" }>,
  store: DriftStore,
): Promise<ReportOutput> {
  const violatedIds = new Set(review.violations.map((v) => v.principle_id));
  const cleanHonored = review.honored.filter((id) => !violatedIds.has(id));
  const id = generateId("rev");

  const entry: ReviewEntry = {
    review_id: id,
    timestamp: new Date().toISOString(),
    verdict: review.verdict ?? deriveVerdict(review.violations),
    files: review.files,
    violations: review.violations,
    honored: cleanHonored,
    score: review.score,
  };

  await store.appendReview(entry);

  return {
    recorded: true,
    id,
    note: "Review logged. Results will appear in drift reports and inform learning suggestions.",
  };
}

function deriveVerdict(violations: { severity: string }[]): "BLOCKING" | "WARNING" | "CLEAN" {
  if (violations.some((v) => v.severity === "rule")) return "BLOCKING";
  if (violations.some((v) => v.severity === "strong-opinion")) return "WARNING";
  return "CLEAN";
}
