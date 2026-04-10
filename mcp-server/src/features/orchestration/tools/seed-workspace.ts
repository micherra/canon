/**
 * seed-workspace.ts — Seeds a new workspace from a prior workspace's artifacts.
 *
 * Extracted from init-workspace.ts to keep that file under the line limit and
 * isolate seeding responsibility.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Maximum total bytes copied from a single source directory (1 MB). */
const MAX_COPY_BYTES_PER_DIR = 1_048_576;

type SubdirCopyResult = {
  subdir: string;
  existed: boolean;
  warnings: string[];
};

/**
 * Copy .md files from one source subdir to target, applying a 1MB cap.
 * Reads all files in parallel, then copies sequentially to enforce the byte cap.
 */
async function copySubdir(
  subdir: string,
  sourceDir: string,
  targetDir: string,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];

  await mkdir(targetDir, { recursive: true });

  let files: string[];
  try {
    files = await readdir(sourceDir);
  } catch {
    warnings.push(`seed_from: failed to read directory "${sourceDir}" — skipping`);
    return { warnings };
  }

  const mdFiles = files.filter((f) => f.endsWith(".md"));

  // Read all file sizes in parallel to make cap decisions
  type FileRead = { file: string; content: Buffer } | { file: string; error: true };
  const reads: FileRead[] = await Promise.all(
    mdFiles.map(async (file): Promise<FileRead> => {
      try {
        const content = await readFile(join(sourceDir, file));
        return { content, file };
      } catch {
        return { error: true, file };
      }
    }),
  );

  let totalBytes = 0;
  for (const read of reads) {
    if ("error" in read) {
      warnings.push(`seed_from: failed to copy "${read.file}" from "${subdir}" — skipping`);
      continue;
    }
    if (totalBytes + read.content.length > MAX_COPY_BYTES_PER_DIR) {
      warnings.push(
        `seed_from: skipping "${read.file}" in "${subdir}" — 1MB per-directory copy cap reached`,
      );
      continue;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential copy enforces byte-cap accumulation (totalBytes depends on prior iterations)
      await copyFile(join(sourceDir, read.file), join(targetDir, read.file));
      totalBytes += read.content.length;
    } catch {
      warnings.push(`seed_from: failed to copy "${read.file}" from "${subdir}" — skipping`);
    }
  }

  return { warnings };
}

/** Process one subdir from source to target workspace. */
async function processSubdir(
  subdir: string,
  sourceWorkspace: string,
  targetWorkspace: string,
): Promise<SubdirCopyResult> {
  const sourceDir = join(sourceWorkspace, subdir);
  const targetDir = join(targetWorkspace, "seeded", subdir);

  if (!existsSync(sourceDir)) {
    return {
      existed: false,
      subdir,
      warnings: [
        `seed_from: source directory "${subdir}" not found in "${sourceWorkspace}" — skipping`,
      ],
    };
  }

  const { warnings } = await copySubdir(subdir, sourceDir, targetDir);
  return { existed: true, subdir, warnings };
}

/**
 * Copy .md artifacts from a prior workspace into seeded/ subdirectories
 * of the new workspace. Returns warnings (not errors) for missing paths.
 *
 * errors-are-values: never throws; all failures produce warnings.
 * information-hiding: seeded/ is an implementation detail; callers only see seeded_from.
 */
export async function seedFromPriorWorkspace(
  sourceWorkspace: string,
  targetWorkspace: string,
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

  const subdirs = ["handoffs", "research"] as const;
  const results = await Promise.all(
    subdirs.map((subdir) => processSubdir(subdir, sourceWorkspace, targetWorkspace)),
  );

  const anySubdirExists = results.some((r) => r.existed);
  for (const r of results) warnings.push(...r.warnings);

  if (!anySubdirExists) {
    await Promise.all([
      mkdir(join(targetWorkspace, "seeded", "handoffs"), { recursive: true }),
      mkdir(join(targetWorkspace, "seeded", "research"), { recursive: true }),
    ]);
  }

  return { seeded: true, warnings };
}
