/**
 * Git Log Parser
 *
 * Parses output of:
 *   git log --format="COMMIT:%H %at" --name-only --after="YYYY-MM-DD"
 *
 * Output format:
 *   COMMIT:<sha> <unix_timestamp>
 *
 *   file1.ts
 *   file2.ts
 *
 *   COMMIT:<sha2> <unix_timestamp2>
 *
 *   file3.ts
 *
 * Pure function — takes string, returns structured data.
 * Never throws — malformed lines are skipped silently.
 */

import type { GitCommitRecord } from "./git-intel-types.ts";

const COMMIT_HEADER_RE = /^COMMIT:([0-9a-f]+)\s+(\d+)$/;

/**
 * Parse git log stdout into an array of GitCommitRecord.
 * Commits with no files are skipped.
 * Malformed COMMIT headers are skipped.
 * Empty output returns [].
 */
export const parseGitLog = (stdout: string): GitCommitRecord[] => {
  const results: GitCommitRecord[] = [];

  if (!stdout || !stdout.trim()) {
    return results;
  }

  // Split the output on COMMIT: markers to get per-commit blocks.
  // Each block starts with the header line (sha + timestamp) followed by file paths.
  const blocks = stdout.split(/(?=^COMMIT:)/m);

  for (const block of blocks) {
    const lines = block.split("\n");
    const headerLine = lines[0].trim();

    if (!headerLine.startsWith("COMMIT:")) {
      // Not a commit block — skip
      continue;
    }

    const match = COMMIT_HEADER_RE.exec(headerLine);
    if (!match) {
      // Malformed header (e.g., non-numeric timestamp) — skip silently
      continue;
    }

    const sha = match[1];
    const timestamp = parseInt(match[2], 10);

    // Collect non-empty lines after the header as file paths
    const files = lines
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (files.length === 0) {
      // No files in this commit — skip
      continue;
    }

    results.push({ sha, timestamp, files });
  }

  return results;
};
