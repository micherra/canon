/** Shared JSONL store utilities — read, append, rotate. */

import { readFile, appendFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { isNotFound } from "../utils/errors.ts";
import { atomicWriteFile } from "../utils/atomic-write.ts";

const MAX_ENTRIES = 500;

/**
 * Read a JSONL file into an array of parsed entries.
 * Returns empty for file-not-found (new store). Throws on permission errors.
 * Individual malformed lines are skipped to tolerate partial corruption.
 */
export async function readJsonl<T>(filePath: string, filter?: (entry: T) => boolean): Promise<T[]> {
  const content = await safeReadFile(filePath);
  if (!content) return [];

  const results: T[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as T;
      if (!filter || filter(entry)) {
        results.push(entry);
      }
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

/**
 * Rotate old entries to an archive file when the store exceeds MAX_ENTRIES.
 * Uses atomic write for the active file to prevent corruption on crash.
 */
export async function rotateIfNeeded(filePath: string): Promise<void> {
  const content = await safeReadFile(filePath);
  if (!content) return;

  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= MAX_ENTRIES) return;

  const archiveLines = lines.slice(0, lines.length - MAX_ENTRIES);
  const keepLines = lines.slice(lines.length - MAX_ENTRIES);

  const archivePath = filePath.replace(/\.jsonl$/, ".archive.jsonl");
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  // Append to archive first (idempotent on crash — duplicates are acceptable)
  await appendFile(archivePath, archiveLines.join("\n") + "\n", "utf-8");
  // Atomic rewrite of active file — prevents corruption if process crashes mid-write
  await atomicWriteFile(filePath, keepLines.join("\n") + "\n");
}

/** Helper to read file safely, returning null on ENOENT. */
async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
