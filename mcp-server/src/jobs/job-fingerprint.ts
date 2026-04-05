import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitExecAsync } from "../platform/adapters/git-adapter-async.ts";
import { CANON_DIR, CANON_FILES } from "../shared/constants.ts";

export type FingerprintInput = {
  projectDir: string;
  sourceDirs?: string[];
};

/**
 * Compute a deterministic fingerprint for a codebase graph job.
 * Components: git HEAD hash + config.json content hash + sorted source dirs.
 * Returns null if git HEAD cannot be determined (not a git repo).
 */
export async function computeJobFingerprint(input: FingerprintInput): Promise<string | null> {
  const { projectDir, sourceDirs } = input;

  // 1. Get git HEAD
  const headResult = await gitExecAsync(["rev-parse", "HEAD"], projectDir);
  if (!headResult.ok) return null;
  const head = headResult.stdout.trim();

  // 2. Read config.json
  let configContent = "";
  try {
    configContent = await readFile(join(projectDir, CANON_DIR, CANON_FILES.CONFIG), "utf-8");
  } catch {
    // No config file — use empty string
  }

  // 3. Compute fingerprint: sha256(HEAD + sha256(config) + sorted sourceDirs)
  const hash = createHash("sha256");
  hash.update(head);
  hash.update(createHash("sha256").update(configContent).digest("hex"));
  hash.update(JSON.stringify((sourceDirs ?? []).sort()));
  return hash.digest("hex");
}
