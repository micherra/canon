import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { generateId } from "@shared/lib/id.ts";
import { deriveSubsystemKey } from "@shared/lib/subsystem-key.ts";
import { type CraftProfile, CraftProfileSchema, type ReviewViolation } from "@shared/schema.ts";

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
  craft_profile?: CraftProfile;
};

export type StorePrReviewOutput = {
  recorded: boolean;
  review_id: string;
};

/**
 * Validate craft_profile at the trust boundary and throw on invalid input.
 * Returns the validated profile unchanged (or undefined when absent).
 * validate-at-trust-boundaries: reject malformed input before any write.
 *
 * Used internally and by report.ts to share a single validation path.
 */
function validateCraftProfile(craft_profile: CraftProfile | undefined): CraftProfile | undefined {
  if (craft_profile === undefined) return undefined;
  const parsed = CraftProfileSchema.safeParse(craft_profile);
  if (!parsed.success) {
    throw new Error(
      `Invalid craft_profile: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return craft_profile;
}

/**
 * Persist one craft_profiles row per distinct subsystem area derived from files.
 * craft comes ONLY from the structured craft_profile field (Decision craft-v2-04):
 * never re-derived from recommendations. Empty files → no rows, no error.
 *
 * Used internally and by report.ts to share a single persist path.
 */
function persistCraftRows(profile: CraftProfile, files: string[], projectDir: string): void {
  if (files.length === 0) return;
  const distinctKeys = new Set(files.map(deriveSubsystemKey));
  const craftDao = getDriftDb(projectDir).getCraftProfiles();
  for (const subsystem_key of distinctKeys) {
    craftDao.insertProfile({
      ratings: profile.ratings,
      source: "review",
      subsystem_key,
      ...(profile.rollup !== undefined ? { rollup: profile.rollup } : {}),
    });
  }
}

/**
 * Shared helper: validate then persist craft profile rows.
 * Throws on invalid profile; silently no-ops when profile is undefined or files is empty.
 * Used by both store-pr-review.ts and report.ts so the validate+persist contract is defined once.
 */
export function validateAndPersistCraftProfile(
  craft_profile: CraftProfile | undefined,
  files: string[],
  projectDir: string,
): void {
  const profile = validateCraftProfile(craft_profile);
  if (profile !== undefined) {
    persistCraftRows(profile, files, projectDir);
  }
}

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

  // validate-at-trust-boundaries + persist craft rows via shared helper
  validateAndPersistCraftProfile(input.craft_profile, input.files, projectDir);

  return { recorded: true, review_id };
}
