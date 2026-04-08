/**
 * Best-effort migration of legacy summaries.json to KG SQLite DB (ADR-005).
 * Called from initWorkspace. Non-blocking — failures are logged but do not
 * prevent workspace initialization.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inferLanguageFromExtension } from "@features/diagnostics/tools/store-summaries.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";

/** Shape of a single entry in the legacy summaries.json file. */
type LegacySummaryEntry = {
  summary: string;
  updated_at?: string;
};

/** Shape of the legacy summaries.json file. */
type LegacySummariesFile = Record<string, LegacySummaryEntry | string>;

/**
 * Migrate legacy `.canon/summaries.json` to KG SQLite DB.
 *
 * Returns `{ migrated, skipped }` counts on success, or `null` if:
 * - The file does not exist (nothing to migrate)
 * - Any error occurs during the migration (best-effort; never throws)
 */
function parseLegacySummaries(raw: string): LegacySummariesFile | null {
  try {
    return JSON.parse(raw) as LegacySummariesFile;
  } catch {
    console.warn("[migrate-summaries] summaries.json is malformed — skipping migration");
    return null;
  }
}

function migrateEntry(
  store: KgStore,
  filePath: string,
  value: LegacySummaryEntry | string,
  now: string,
): "migrated" | "skipped" {
  const summaryText = typeof value === "string" ? value : value.summary;
  if (!summaryText) return "skipped";

  const normalizedPath = filePath.replace(/\\/g, "/");

  const existingFile = store.getFile(normalizedPath);
  if (existingFile?.file_id !== undefined) {
    if (store.getSummaryByFile(existingFile.file_id) !== undefined) return "skipped";
  }

  let fileRow = store.getFile(normalizedPath);
  if (fileRow?.file_id === undefined) {
    fileRow = store.upsertFile({
      content_hash: "stub",
      language: inferLanguageFromExtension(normalizedPath),
      last_indexed_at: Date.now(),
      layer: "unknown",
      mtime_ms: Date.now(),
      path: normalizedPath,
    });
  }

  store.upsertSummary({
    content_hash: fileRow.content_hash,
    entity_id: null,
    file_id: fileRow.file_id!,
    model: null,
    scope: "file",
    summary: summaryText,
    updated_at: typeof value === "object" && value.updated_at ? value.updated_at : now,
  });
  return "migrated";
}

export async function migrateSummaries(
  projectDir: string,
): Promise<{ migrated: number; skipped: number } | null> {
  try {
    const summariesPath = join(projectDir, CANON_DIR, "summaries.json");
    if (!existsSync(summariesPath)) return null;

    const parsed = parseLegacySummaries(await readFile(summariesPath, "utf-8"));
    if (!parsed) return null;

    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    await mkdir(dirname(dbPath), { recursive: true });

    const db = initDatabase(dbPath);
    let migrated = 0;
    let skipped = 0;
    const now = new Date().toISOString();

    try {
      const store = new KgStore(db);
      for (const [filePath, value] of Object.entries(parsed)) {
        try {
          if (migrateEntry(store, filePath, value, now) === "migrated") migrated += 1;
          else skipped += 1;
        } catch (entryErr) {
          console.warn(`[migrate-summaries] failed to migrate entry "${filePath}":`, entryErr);
          skipped += 1;
        }
      }
    } finally {
      db.close();
    }

    await rename(summariesPath, `${summariesPath}.migrated`);
    return { migrated, skipped };
  } catch (err) {
    console.warn("[migrate-summaries] migration failed (non-fatal):", err);
    return null;
  }
}
