import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { generateId } from "@shared/lib/id.ts";
import { deriveSubsystemKey } from "@shared/lib/subsystem-key.ts";
import { CraftProfileSchema, type ReportInput, type ReviewEntry } from "@shared/schema.ts";
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
  // validate-at-trust-boundaries: validate craft_profile before any write
  if (review.craft_profile !== undefined) {
    const parsed = CraftProfileSchema.safeParse(review.craft_profile);
    if (!parsed.success) {
      throw new Error(
        `Invalid craft_profile: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
  }

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

  // Persist craft profile rows — one per distinct subsystem area.
  // craft comes ONLY from the structured craft_profile field (Decision craft-v2-04):
  // never re-derived from recommendations. Absent → zero craft rows.
  if (review.craft_profile !== undefined && review.files.length > 0) {
    const profile = review.craft_profile;
    const distinctKeys = new Set(review.files.map(deriveSubsystemKey));
    const db = getDriftDb(projectDir);
    const craftDao = db.getCraftProfiles();

    for (const subsystem_key of distinctKeys) {
      craftDao.insertProfile({
        ratings: profile.ratings,
        source: "review",
        subsystem_key,
        ...(profile.rollup !== undefined ? { rollup: profile.rollup } : {}),
      });
    }
  }

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
