import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CANON_DIR } from "@shared/constants.ts";

/** Shape of a correction record written by correction-capture.sh */
export type CorrectionRecord = {
  agent_type: string;
  commit_sha: string;
  commit_subject: string;
  correction_command: string;
  file_path: string;
  timestamp: string;
};

/**
 * Result type for readCorrections — distinguishes success (including
 * legitimately-empty results) from I/O failures the caller should surface.
 */
export type ReadCorrectionsResult =
  | { ok: true; records: CorrectionRecord[] }
  | { ok: false; error: string };

/** Parse one correction file, returning null if invalid or too old. */
function parseCorrectionFile(
  filePath: string,
  now: number,
  maxAge: number,
  fileSet: Set<string> | null,
): CorrectionRecord | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let record: CorrectionRecord;
  try {
    record = JSON.parse(raw) as CorrectionRecord;
  } catch {
    return null;
  }

  if (!record.file_path || !record.timestamp) return null;

  const age = now - new Date(record.timestamp).getTime();
  if (age > maxAge) return null;

  if (fileSet && !fileSet.has(record.file_path)) return null;

  return record;
}

/**
 * Read all correction records from `.canon/corrections/`, optionally
 * filtered to those affecting specific file paths.
 *
 * Returns a discriminated union so callers can distinguish between:
 *  - `{ ok: true; records: [] }` — directory absent or empty (legitimately no corrections)
 *  - `{ ok: true; records: [...] }` — corrections found
 *  - `{ ok: false; error: string }` — I/O failure reading an existing directory
 *
 * Malformed JSON files are skipped silently.
 * Results are sorted by timestamp DESC (most recent first).
 *
 * @param projectDir - project root directory
 * @param filePaths - optional filter; when provided, only corrections
 *                    matching these file paths are returned
 * @param maxAge - max age in milliseconds (default: 24 hours);
 *                 corrections older than this are skipped
 */
export function readCorrections(
  projectDir: string,
  filePaths?: string[],
  maxAge = 24 * 60 * 60 * 1000,
): ReadCorrectionsResult {
  const correctionsDir = join(projectDir, CANON_DIR, "corrections");
  const now = Date.now();

  let fileNames: string[];
  try {
    fileNames = readdirSync(correctionsDir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT means the directory simply doesn't exist yet — no corrections recorded.
    if (code === "ENOENT") {
      return { ok: true, records: [] };
    }
    // Any other I/O error (EACCES, ENOTDIR, etc.) is a real failure callers should see.
    return {
      error: `corrections directory unreadable: ${err instanceof Error ? err.message : String(err)}`,
      ok: false,
    };
  }

  const fileSet = filePaths ? new Set(filePaths) : null;
  const records: CorrectionRecord[] = [];

  for (const fileName of fileNames) {
    const record = parseCorrectionFile(join(correctionsDir, fileName), now, maxAge, fileSet);
    if (record) records.push(record);
  }

  // Most recent first
  records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { ok: true, records };
}

/**
 * Format correction records into a markdown section for injection
 * into agent preload prompts.
 *
 * Returns empty string when no corrections exist.
 */
export function formatCorrectionsSection(corrections: CorrectionRecord[]): string {
  if (corrections.length === 0) return "";

  const lines = [
    "## Recent User Corrections",
    "",
    "The following files were recently corrected by the user after an agent commit. Pay extra attention to these patterns:",
    "",
  ];

  for (const c of corrections) {
    lines.push(`- **${c.file_path}**: Correction at ${c.timestamp}`);
    lines.push(`  - Agent commit: \`${c.commit_sha.slice(0, 8)}\` — "${c.commit_subject}"`);
    lines.push(`  - Correction: \`${c.correction_command}\``);
    lines.push("");
  }

  return lines.join("\n");
}
