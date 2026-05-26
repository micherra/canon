/**
 * seed-workspace.ts — Seeds a new workspace from a prior workspace's artifacts.
 *
 * Extracted from init-workspace.ts to keep that file under the line limit and
 * isolate seeding responsibility.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Validate a prior workspace path for seeding.
 * Returns warnings (not errors) for invalid or missing paths.
 *
 * errors-are-values: never throws; all failures produce warnings.
 */
export async function seedFromPriorWorkspace(
  sourceWorkspace: string,
  _targetWorkspace: string,
): Promise<{ seeded: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  if (!isAbsolute(sourceWorkspace)) {
    warnings.push(`seed_from must be an absolute path; got relative path: "${sourceWorkspace}"`);
    return { seeded: false, warnings };
  }

  const normalizedSource = sourceWorkspace.replace(/\\/g, "/");
  if (!normalizedSource.includes(".canon/workspaces/")) {
    warnings.push(
      `seed_from path "${sourceWorkspace}" is not within a .canon/workspaces/ directory — invalid workspace path`,
    );
    return { seeded: false, warnings };
  }

  if (!existsSync(sourceWorkspace)) {
    warnings.push(`seed_from workspace does not exist: "${sourceWorkspace}"`);
    return { seeded: false, warnings };
  }

  return { seeded: true, warnings };
}
