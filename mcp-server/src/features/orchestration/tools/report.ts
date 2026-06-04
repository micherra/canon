import { validateAndPersistCraftProfile } from "@features/pr-review/tools/store-pr-review.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { generateId } from "@shared/lib/id.ts";
import type { ReportInput, ReviewEntry } from "@shared/schema.ts";
import { type SignalWriter, updateFileViolationHistory } from "./write-review.ts";

export type ReportOutput = {
  recorded: boolean;
  id: string;
  note: string;
};

export async function report(
  input: ReportInput,
  projectDir: string,
  signals?: SignalWriter,
): Promise<ReportOutput> {
  const store = new DriftStore(projectDir);

  switch (input.type) {
    case "review":
      return recordReview(input, projectDir, store, signals);
    default: {
      const _exhaustive: never = input.type;
      throw new Error(`Unknown report type: ${_exhaustive}`);
    }
  }
}

async function recordReview(
  review: Extract<ReportInput, { type: "review" }>,
  projectDir: string,
  store: DriftStore,
  signals: SignalWriter | undefined,
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

  // Persist path effects to signal tables (non-blocking)
  if (signals) {
    updateFileViolationHistory(signals, review.files, review.violations, entry.verdict);
  }

  // Persist craft profile rows via shared helper (validate-at-trust-boundaries + persist).
  // craft comes ONLY from the structured craft_profile field (Decision craft-v2-04):
  // never re-derived from recommendations. Absent → zero craft rows.
  validateAndPersistCraftProfile(review.craft_profile, review.files, projectDir);

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
