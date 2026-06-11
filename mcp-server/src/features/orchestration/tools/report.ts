import { validateAndPersistCraftProfile } from "@features/pr-review/tools/store-pr-review.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { generateId } from "@shared/lib/id.ts";
import type { ReportInput, ReviewEntry } from "@shared/schema.ts";
import {
  type SignalWriter,
  stripNonPersistableViolations,
  updateFileViolationHistory,
} from "./write-review.ts";

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
  // Strip correctness-scan from analytics paths only — NOT from the store.
  // The store retains the full violations list so present_review can show
  // all findings to humans. Analytics (updateFileViolationHistory, analyzer)
  // exclude correctness-scan at their own boundaries.
  const analyticsViolations = stripNonPersistableViolations(review.violations);

  // Derive verdict from analytics-only violations so correctness-scan
  // does not inflate the verdict (a correctness-scan-only review is CLEAN).
  const derivedVerdict = review.verdict ?? deriveVerdict(analyticsViolations);

  const violatedIds = new Set(analyticsViolations.map((v) => v.principle_id));
  const cleanHonored = review.honored.filter((id) => !violatedIds.has(id));
  const id = generateId("rev");

  const entry: ReviewEntry = {
    files: review.files,
    honored: cleanHonored,
    review_id: id,
    score: review.score,
    timestamp: new Date().toISOString(),
    verdict: derivedVerdict,
    violations: review.violations, // store the full list for presentation
  };

  await store.appendReview(entry);

  // Persist path effects to signal tables (non-blocking).
  // Pass analyticsViolations — correctness-scan excluded from principle-keyed stores.
  if (signals) {
    updateFileViolationHistory(signals, review.files, analyticsViolations, entry.verdict);
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
