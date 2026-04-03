/**
 * Stage 6: inject-wave-briefing
 *
 * Assembles and appends wave briefing content to the basePrompt.
 *
 * Active when: state type is "wave" or "parallel-per" AND wave != null.
 *
 * This stage is the trust boundary for consultation output summaries, wave
 * guidance content, and KG file summary text. It calls escapeDollarBrace on
 * each summary before passing to assembleWaveBriefing, and on the entire KG
 * section before appending to basePrompt.
 *
 * This stage operates on ctx.basePrompt (pre-fanout). The fanout stage (7)
 * will copy basePrompt into each fanned-out prompt entry, so every agent
 * receives the briefing identically. This is equivalent to the original code
 * that appended briefing per-entry after fanout.
 *
 * Canon: validate-at-trust-boundaries — escaping happens at the read boundary,
 * not at the caller.
 * Canon: graceful-degradation — missing KG, unavailable DB, DB errors skip
 * injection with warnings rather than failing the pipeline.
 * Canon: deep-modules — KG injection hidden inside existing stage 6; no new
 * pipeline stage added.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { escapeDollarBrace } from "../../orchestration/wave-variables.ts";
import { assembleWaveBriefing, readWaveGuidance } from "../../orchestration/wave-briefing.ts";
import { getExecutionStore } from "../../orchestration/execution-store.ts";
import { getItemCountCap } from "../../orchestration/context-budget.ts";
import { KgQuery, computeFileInsightMaps } from "../../graph/kg-query.ts";
import { KgStore } from "../../graph/kg-store.ts";
import { initDatabase } from "../../graph/kg-schema.ts";
import { CANON_DIR, CANON_FILES } from "../../constants.ts";
import type { PromptContext, TaskItem } from "./types.ts";

// ---------------------------------------------------------------------------
// KG staleness threshold: 1 hour (matches show_pr_impact UI banner)
// ---------------------------------------------------------------------------
const KG_STALENESS_THRESHOLD_MS = 3_600_000;

// ---------------------------------------------------------------------------
// File path extraction from task items
// ---------------------------------------------------------------------------

/**
 * Extract file paths from task items. Items can be:
 * - strings (file paths directly)
 * - objects with a `files` field (string[])
 * - objects with an `affected_files` field (string[])
 *
 * Returns an empty array if no file paths can be extracted.
 */
function extractFilePaths(items: TaskItem[]): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      paths.push(item);
    } else if (item !== null && typeof item === "object") {
      const filesField = item["files"];
      const affectedField = item["affected_files"];
      if (Array.isArray(filesField)) {
        for (const f of filesField) {
          if (typeof f === "string") paths.push(f);
        }
      } else if (Array.isArray(affectedField)) {
        for (const f of affectedField) {
          if (typeof f === "string") paths.push(f);
        }
      }
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// KG section formatting
// ---------------------------------------------------------------------------

/**
 * Format a compact file context section from KG metrics and summary.
 * Returns raw (unescaped) text — caller is responsible for escaping.
 */
function formatKgSection(
  files: Array<{ path: string; layer: string; inDegree: number; outDegree: number; summary: string | null }>,
): string {
  if (files.length === 0) return "";

  const lines: string[] = ["## File Context (from Knowledge Graph)", ""];
  for (const file of files) {
    lines.push(`**${file.path}** — layer: ${file.layer}, in: ${file.inDegree}, out: ${file.outDegree}`);
    if (file.summary) {
      lines.push(`Summary: ${file.summary}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// KG injection implementation
// ---------------------------------------------------------------------------

/**
 * Attempt to inject KG file context for the given file paths.
 * Returns { section: string; warnings: string[] } — section may be empty if
 * no KG data is available. Never throws.
 */
function injectKgSection(
  filePaths: string[],
  projectDir: string,
  workspace: string,
): { section: string; warnings: string[] } {
  const warnings: string[] = [];

  // Resolve project dir — fall back to env var then cwd
  const resolvedProjectDir = projectDir || process.env["CANON_PROJECT_DIR"] || process.cwd();

  // Get tier from execution store for item count cap
  let tier: "small" | "medium" | "large" = "medium";
  try {
    const store = getExecutionStore(workspace);
    const session = store.getSession();
    if (session?.tier) {
      tier = session.tier;
    }
  } catch {
    // Execution store unavailable — proceed with medium defaults
  }

  const uniquePaths = [...new Set(filePaths)];
  const cap = getItemCountCap(tier);
  const cappedPaths = uniquePaths.slice(0, cap);

  // Check KG DB availability
  const dbPath = join(resolvedProjectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(dbPath)) {
    warnings.push("KG not indexed: knowledge-graph.db not found, skipping file context injection");
    return { section: "", warnings };
  }

  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
    const kgQuery = new KgQuery(db);
    const kgStore = new KgStore(db);

    // Check KG freshness
    const freshnessMs = kgQuery.getKgFreshnessMs();
    if (freshnessMs !== null && freshnessMs > KG_STALENESS_THRESHOLD_MS) {
      warnings.push(`WARNING: KG data is ${freshnessMs}ms old (>1hr) — file context may be stale`);
    }

    // Compute insight maps once (prevents N+1 queries)
    const insightMaps = computeFileInsightMaps(db);

    // Collect file context entries
    const fileEntries: Array<{
      path: string;
      layer: string;
      inDegree: number;
      outDegree: number;
      summary: string | null;
    }> = [];

    for (const filePath of cappedPaths) {
      const metrics = kgQuery.getFileMetrics(filePath, {
        hubPaths: insightMaps.hubPaths,
        cycleMemberPaths: insightMaps.cycleMemberPaths,
        layerViolationsByPath: insightMaps.layerViolationsByPath,
      });

      // Get summary from files table via KgStore
      let summary: string | null = null;
      if (metrics !== null) {
        const fileRow = kgStore.getFile(filePath);
        if (fileRow?.file_id !== undefined) {
          const summaryRow = kgStore.getSummaryByFile(fileRow.file_id);
          summary = summaryRow?.summary ?? null;
        }

        fileEntries.push({
          path: filePath,
          layer: metrics.layer,
          inDegree: metrics.in_degree,
          outDegree: metrics.out_degree,
          summary,
        });
      } else {
        // File not in KG — include with unknown metrics
        fileEntries.push({
          path: filePath,
          layer: "unknown",
          inDegree: 0,
          outDegree: 0,
          summary: null,
        });
      }
    }

    if (fileEntries.length === 0) {
      return { section: "", warnings };
    }

    const rawSection = formatKgSection(fileEntries);
    return { section: rawSection, warnings };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`KG injection skipped due to error: ${msg}`);
    return { section: "", warnings };
  } finally {
    // better-sqlite3 databases should be closed when done
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 6: injectWaveBriefing
// ---------------------------------------------------------------------------

/**
 * Inject wave guidance and wave briefing into the base prompt.
 * Only active for wave/parallel-per states with a non-null wave number.
 *
 * Also injects KG file context summaries when task items include file paths.
 */
export async function injectWaveBriefing(ctx: PromptContext): Promise<PromptContext> {
  const { state } = ctx;
  const { wave, workspace, consultation_outputs, items, project_dir } = ctx.input;

  // Only active for wave/parallel-per states with a wave number
  if ((state.type !== "wave" && state.type !== "parallel-per") || wave == null) {
    return ctx;
  }

  let basePrompt = ctx.basePrompt;
  const warnings = [...ctx.warnings];

  // Inject wave guidance — escape at read boundary before appending
  const rawGuidance = await readWaveGuidance(workspace);
  if (rawGuidance) {
    const escapedGuidance = escapeDollarBrace(rawGuidance);
    basePrompt += `\n\n## Wave Guidance (from user)\n\n${escapedGuidance}`;
  }

  // Inject wave briefing from consultation outputs (if provided)
  if (consultation_outputs) {
    // Escape summaries at trust boundary before passing to assembleWaveBriefing
    const escapedOutputs: Record<string, { section?: string; summary: string }> = {};
    for (const [key, output] of Object.entries(consultation_outputs)) {
      escapedOutputs[key] = {
        ...output,
        ...(output.section != null ? { section: escapeDollarBrace(output.section) } : {}),
        summary: escapeDollarBrace(output.summary),
      };
    }

    const briefing = assembleWaveBriefing({
      wave,
      summaries: [],
      consultationOutputs: escapedOutputs,
    });

    if (briefing) {
      basePrompt += `\n\n${briefing}`;
    }
  }

  // Inject KG file context summaries when items contain file paths
  if (items && items.length > 0) {
    const filePaths = extractFilePaths(items);

    if (filePaths.length > 0) {
      const resolvedProjectDir = project_dir || process.env["CANON_PROJECT_DIR"] || process.cwd();
      const { section, warnings: kgWarnings } = injectKgSection(filePaths, resolvedProjectDir, workspace);
      warnings.push(...kgWarnings);

      if (section) {
        // Escape at trust boundary before appending to basePrompt
        const escapedSection = escapeDollarBrace(section);
        basePrompt += `\n\n${escapedSection}`;
      }
    }
  }

  return { ...ctx, basePrompt, warnings };
}
