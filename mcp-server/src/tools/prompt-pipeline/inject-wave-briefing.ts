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
import { CANON_DIR, CANON_FILES } from "../../shared/constants.ts";
import { computeFileInsightMaps, KgQuery } from "../../graph/kg-query.ts";
import { initDatabase } from "../../graph/kg-schema.ts";
import { KgStore } from "../../graph/kg-store.ts";
import { getItemCountCap } from "../../orchestration/context-budget.ts";
import { getExecutionStore } from "../../orchestration/execution-store.ts";
import { assembleWaveBriefing, readWaveGuidance } from "../../orchestration/wave-briefing.ts";
import { escapeDollarBrace } from "../../orchestration/wave-variables.ts";
import type { PromptContext, TaskItem } from "./types.ts";

// KG staleness threshold: 1 hour (matches show_pr_impact UI banner)
const KG_STALENESS_THRESHOLD_MS = 3_600_000;

// File path extraction from task items

/**
 * Extract file paths from task items. Items can be:
 * - strings (file paths directly)
 * - objects with a `files` field (string[])
 * - objects with an `affected_files` field (string[])
 *
 * Returns an empty array if no file paths can be extracted.
 */
function extractStringArray(arr: unknown[]): string[] {
  return arr.filter((f): f is string => typeof f === "string");
}

function extractFilePathsFromItem(item: TaskItem): string[] {
  if (typeof item === "string") return [item];
  if (item === null || typeof item !== "object") return [];
  const filesField = item.files;
  if (Array.isArray(filesField)) return extractStringArray(filesField);
  const affectedField = item.affected_files;
  if (Array.isArray(affectedField)) return extractStringArray(affectedField);
  return [];
}

function extractFilePaths(items: TaskItem[]): string[] {
  return items.flatMap(extractFilePathsFromItem);
}

// KG section formatting

/**
 * Format a compact file context section from KG metrics and summary.
 * Returns raw (unescaped) text — caller is responsible for escaping.
 */
function formatKgSection(
  files: Array<{
    path: string;
    layer: string;
    inDegree: number;
    outDegree: number;
    summary: string | null;
  }>,
): string {
  if (files.length === 0) return "";

  const lines: string[] = ["## File Context (from Knowledge Graph)", ""];
  for (const file of files) {
    lines.push(
      `**${file.path}** — layer: ${file.layer}, in: ${file.inDegree}, out: ${file.outDegree}`,
    );
    if (file.summary) {
      lines.push(`Summary: ${file.summary}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// KG injection implementation

/**
 * Attempt to inject KG file context for the given file paths.
 * Returns { section: string; warnings: string[] } — section may be empty if
 * no KG data is available. Never throws.
 */
function getTierFromWorkspace(workspace: string): "small" | "medium" | "large" {
  try {
    const store = getExecutionStore(workspace);
    const session = store.getSession();
    return session?.tier ?? "medium";
  } catch {
    return "medium";
  }
}

function buildFileEntry(
  filePath: string,
  kgQuery: KgQuery,
  kgStore: KgStore,
  insightMaps: ReturnType<typeof computeFileInsightMaps>,
): { path: string; layer: string; inDegree: number; outDegree: number; summary: string | null } {
  const metrics = kgQuery.getFileMetrics(filePath, {
    cycleMemberPaths: insightMaps.cycleMemberPaths,
    hubPaths: insightMaps.hubPaths,
    layerViolationsByPath: insightMaps.layerViolationsByPath,
  });

  if (metrics === null) {
    return { inDegree: 0, layer: "unknown", outDegree: 0, path: filePath, summary: null };
  }

  let summary: string | null = null;
  const fileRow = kgStore.getFile(filePath);
  if (fileRow?.file_id !== undefined) {
    const summaryRow = kgStore.getSummaryByFile(fileRow.file_id);
    summary = summaryRow?.summary ?? null;
  }

  return {
    inDegree: metrics.in_degree,
    layer: metrics.layer,
    outDegree: metrics.out_degree,
    path: filePath,
    summary,
  };
}

function closeDb(db: ReturnType<typeof initDatabase> | undefined): void {
  if (db !== undefined) {
    try {
      db.close();
    } catch {
      /* ignore close errors */
    }
  }
}

function injectKgSection(
  filePaths: string[],
  projectDir: string,
  workspace: string,
): { section: string; warnings: string[] } {
  const warnings: string[] = [];
  const resolvedProjectDir = projectDir || process.env.CANON_PROJECT_DIR || process.cwd();

  const tier = getTierFromWorkspace(workspace);
  const uniquePaths = [...new Set(filePaths)];
  const cappedPaths = uniquePaths.slice(0, getItemCountCap(tier));

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

    const freshnessMs = kgQuery.getKgFreshnessMs();
    if (freshnessMs !== null && freshnessMs > KG_STALENESS_THRESHOLD_MS) {
      warnings.push(`WARNING: KG data is ${freshnessMs}ms old (>1hr) — file context may be stale`);
    }

    const insightMaps = computeFileInsightMaps(db);
    const fileEntries = cappedPaths.map((fp) => buildFileEntry(fp, kgQuery, kgStore, insightMaps));

    if (fileEntries.length === 0) return { section: "", warnings };
    return { section: formatKgSection(fileEntries), warnings };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`KG injection skipped due to error: ${msg}`);
    return { section: "", warnings };
  } finally {
    closeDb(db);
  }
}

// Stage 6: injectWaveBriefing

/**
 * Inject wave guidance and wave briefing into the base prompt.
 * Only active for wave/parallel-per states with a non-null wave number.
 *
 * Also injects KG file context summaries when task items include file paths.
 */
function escapeConsultationOutputs(
  outputs: Record<string, { section?: string; summary: string }>,
): Record<string, { section?: string; summary: string }> {
  const escaped: Record<string, { section?: string; summary: string }> = {};
  for (const [key, output] of Object.entries(outputs)) {
    escaped[key] = {
      ...output,
      ...(output.section != null ? { section: escapeDollarBrace(output.section) } : {}),
      summary: escapeDollarBrace(output.summary),
    };
  }
  return escaped;
}

function injectConsultationBriefing(
  basePrompt: string,
  wave: number,
  outputs: Record<string, { section?: string; summary: string }>,
): string {
  const escapedOutputs = escapeConsultationOutputs(outputs);
  const briefing = assembleWaveBriefing({
    consultationOutputs: escapedOutputs,
    summaries: [],
    wave,
  });
  return briefing ? `${basePrompt}\n\n${briefing}` : basePrompt;
}

function injectKgFileContext(
  basePrompt: string,
  opts: { warnings: string[]; items: unknown[]; projectDir: string; workspace: string },
): string {
  const { warnings, items, projectDir, workspace } = opts;
  const filePaths = extractFilePaths(items as TaskItem[]);
  if (filePaths.length === 0) return basePrompt;
  const resolvedProjectDir = projectDir || process.env.CANON_PROJECT_DIR || process.cwd();
  const { section, warnings: kgWarnings } = injectKgSection(
    filePaths,
    resolvedProjectDir,
    workspace,
  );
  warnings.push(...kgWarnings);
  return section ? `${basePrompt}\n\n${escapeDollarBrace(section)}` : basePrompt;
}

export async function injectWaveBriefing(ctx: PromptContext): Promise<PromptContext> {
  const { state } = ctx;
  const { wave, workspace, consultation_outputs, items, project_dir } = ctx.input;

  if ((state.type !== "wave" && state.type !== "parallel-per") || wave == null) {
    return ctx;
  }

  let basePrompt = ctx.basePrompt;
  const warnings = [...ctx.warnings];

  const rawGuidance = await readWaveGuidance(workspace);
  if (rawGuidance) {
    basePrompt += `\n\n## Wave Guidance (from user)\n\n${escapeDollarBrace(rawGuidance)}`;
  }

  if (consultation_outputs) {
    basePrompt = injectConsultationBriefing(basePrompt, wave, consultation_outputs);
  }

  if (items && items.length > 0) {
    basePrompt = injectKgFileContext(basePrompt, {
      items,
      projectDir: project_dir ?? "",
      warnings,
      workspace,
    });
  }

  return { ...ctx, basePrompt, warnings };
}
