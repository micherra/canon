import { DriftStore } from "../drift/store.ts";
import type { ReportInput, ReviewEntry } from "../schema.ts";
import { generateId } from "../shared/lib/id.ts";

export type ReportOutput = {
  recorded: boolean;
  id: string;
  note: string;
};

export async function report(input: ReportInput, projectDir: string): Promise<ReportOutput> {
  const store = new DriftStore(projectDir);

  switch (input.type) {
    case "review":
      return recordReview(input, store);
    default: {
      const _exhaustive: never = input.type;
      throw new Error(`Unknown report type: ${_exhaustive}`);
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
    files: review.files,
    honored: cleanHonored,
    review_id: id,
    score: review.score,
    timestamp: new Date().toISOString(),
    verdict: review.verdict ?? deriveVerdict(review.violations),
    violations: review.violations,
  };

  await store.appendReview(entry);

  return {
    id,
    note: "Review logged. Results will appear in drift reports and inform learning suggestions.",
    recorded: true,
  };
}

function deriveVerdict(violations: { severity: string }[]): "BLOCKING" | "WARNING" | "CLEAN" {
  if (violations.some((v) => v.severity === "rule")) return "BLOCKING";
  if (violations.some((v) => v.severity === "strong-opinion")) return "WARNING";
  return "CLEAN";
}
