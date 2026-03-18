/** Shared JSONL store utilities — read, append, rotate with fail-closed error handling. */

import { readFile, writeFile, appendFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { isNotFound } from "../utils/errors.js";

const MAX_ENTRIES = 500;

/**
 * Read a JSONL file into an array of parsed entries.
 * Returns entries for file-not-found (new store). Throws on permission errors
 * or corruption to surface real problems (fail-closed).
 */
export async function readJsonl<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    // File not existing is expected for new stores — return empty
    if (isNotFound(err)) return [];
    // Permission denied, I/O errors, etc. — surface the failure
    throw err;
  }

  const results: T[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // skip individual malformed lines but continue reading
    }
  }
  return results;
}

/** Append a single entry as a JSON line, creating the directory if needed. */
export async function appendJsonl<T>(filePath: string, entry: T): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

/** Rotate old entries to an archive file when the store exceeds MAX_ENTRIES. */
export async function rotateIfNeeded(filePath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isNotFound(err)) return;
    throw err;
  }

  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= MAX_ENTRIES) return;

  const archiveLines = lines.slice(0, lines.length - MAX_ENTRIES);
  const keepLines = lines.slice(lines.length - MAX_ENTRIES);

  const archivePath = filePath.replace(/\.jsonl$/, ".archive.jsonl");
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await appendFile(archivePath, archiveLines.join("\n") + "\n", "utf-8");
  await writeFile(filePath, keepLines.join("\n") + "\n", "utf-8");
}

