import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { deriveSubsystemKey } from "@shared/lib/subsystem-key.ts";
import { type CraftProfile, CraftProfileSchema } from "@shared/schema.ts";

/**
 * Validate craft_profile at the trust boundary and throw on invalid input.
 * Returns the validated profile unchanged (or undefined when absent).
 * validate-at-trust-boundaries: reject malformed input before any write.
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
