/**
 * File claim tracking — manages .canon/claims.json
 *
 * Claims record which workflow "owns" which files during active execution.
 * Overlapping claims on the same file from different workflows produce warnings
 * so concurrent workflows get early notice of potential conflicts.
 *
 * All functions are synchronous (claims file is small) and never throw.
 * Every read prunes stale entries (TTL = 24h) automatically.
 * Writes use atomic rename to prevent partial reads.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How long a claim stays valid before automatic pruning. */
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** A single claim entry recording which workflow owns a file and when. */
type ClaimEntry = {
  workflow: string;
  claimed_at: string; // ISO-8601
};

/** The on-disk claims file structure. */
type ClaimsFile = {
  version: 1;
  claims: Record<string, ClaimEntry[]>; // file_path -> claim entries
};

/** Describes a file claimed by multiple concurrent workflows. */
type ClaimOverlap = {
  file_path: string;
  workflows: string[]; // other workflow slugs that claim this file
};

/** Absolute path to claims.json inside the project's .canon/ directory. */
const claimsPath = (projectDir: string): string =>
  join(projectDir, ".canon", "claims.json");

/** Return an empty, valid ClaimsFile. */
const emptyFile = (): ClaimsFile => ({ version: 1, claims: {} });

/**
 * Read claims.json, prune stale entries (>24h), return parsed data.
 * Returns empty structure if file doesn't exist, is corrupt, or has a wrong version.
 * Never throws.
 */
export const readClaims = (projectDir: string): ClaimsFile => {
  const path = claimsPath(projectDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // File not found or unreadable — start fresh
    return emptyFile();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyFile();
  }

  // Validate version field
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).version !== 1
  ) {
    return emptyFile();
  }

  const file = parsed as ClaimsFile;
  const now = Date.now();
  const pruned: Record<string, ClaimEntry[]> = {};

  for (const [filePath, entries] of Object.entries(file.claims)) {
    if (!Array.isArray(entries)) continue;

    const fresh = entries.filter((e) => {
      if (typeof e !== "object" || e === null) return false;
      if (typeof e.workflow !== "string" || typeof e.claimed_at !== "string") return false;
      const age = now - new Date(e.claimed_at).getTime();
      return age <= CLAIM_TTL_MS;
    });

    if (fresh.length > 0) {
      pruned[filePath] = fresh;
    }
    // Empty arrays are dropped — removes file_path keys with no live claims
  }

  return { version: 1, claims: pruned };
};

/**
 * Write claims to disk atomically (write-to-temp + renameSync).
 * Creates the .canon/ directory if it does not exist.
 */
export const writeClaims = (projectDir: string, claims: ClaimsFile): void => {
  const canonDir = join(projectDir, ".canon");
  mkdirSync(canonDir, { recursive: true });

  const path = claimsPath(projectDir);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(claims, null, 2), "utf-8");
  renameSync(tmpPath, path);
};

/**
 * Add claim entries for the given workflow and file paths.
 * Reads existing claims, merges, then writes atomically.
 * Idempotent — re-registering the same workflow+file is a no-op.
 */
export const registerClaims = (
  projectDir: string,
  workflow: string,
  filePaths: string[],
): void => {
  const data = readClaims(projectDir);
  const now = new Date().toISOString();

  for (const filePath of filePaths) {
    const existing = data.claims[filePath] ?? [];
    const alreadyClaimed = existing.some((e) => e.workflow === workflow);
    if (!alreadyClaimed) {
      data.claims[filePath] = [...existing, { workflow, claimed_at: now }];
    }
  }

  writeClaims(projectDir, data);
};

/**
 * Remove all claim entries for the given workflow.
 * Writes atomically. No-op if workflow has no claims.
 */
export const releaseClaims = (projectDir: string, workflow: string): void => {
  const data = readClaims(projectDir);
  const updated: Record<string, ClaimEntry[]> = {};

  for (const [filePath, entries] of Object.entries(data.claims)) {
    const remaining = entries.filter((e) => e.workflow !== workflow);
    if (remaining.length > 0) {
      updated[filePath] = remaining;
    }
    // Drop keys that become empty after release
  }

  writeClaims(projectDir, { version: 1, claims: updated });
};

/**
 * Check if any of the given file paths are claimed by OTHER workflows.
 * Returns an array of overlapping files. Empty array means no conflicts.
 */
export const checkClaimOverlaps = (
  projectDir: string,
  workflow: string,
  filePaths: string[],
): ClaimOverlap[] => {
  const data = readClaims(projectDir);
  const overlaps: ClaimOverlap[] = [];

  for (const filePath of filePaths) {
    const entries = data.claims[filePath] ?? [];
    const otherWorkflows = entries
      .filter((e) => e.workflow !== workflow)
      .map((e) => e.workflow);

    if (otherWorkflows.length > 0) {
      overlaps.push({ file_path: filePath, workflows: otherWorkflows });
    }
  }

  return overlaps;
};
