import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Board, ContextInjection } from "@domains/flows/flow-schema.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { computeFileInsightMaps, KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { isPathContained } from "@shared/lib/worktree-guard.ts";
import { getItemCountCap } from "./context-budget.ts";

type InjectionResult = {
  variables: Record<string, string>;
  hitl?: { prompt: string; as: string };
  warnings: string[];
};

export async function resolveContextInjections(
  injections: ContextInjection[],
  board: Board,
  workspace: string,
): Promise<InjectionResult> {
  const variables: Record<string, string> = {};
  const warnings: string[] = [];
  let hitl: { prompt: string; as: string } | undefined;

  for (const injection of injections) {
    if (injection.from === "user") {
      hitl = { as: injection.as, prompt: injection.prompt ?? "Please provide input" };
      continue;
    }

    if (injection.from === "file_context") {
      // biome-ignore lint/performance/noAwaitInLoops: each injection resolves independently; refactoring to Promise.all requires restructuring hitl detection
      const resolved = await resolveFileContextInjection(injection, board, workspace);
      warnings.push(...resolved.warnings);
      if (resolved.value !== undefined) {
        variables[injection.as] = resolved.value;
      }
      continue;
    }

    if (injection.from === "handoff") {
      // biome-ignore lint/performance/noAwaitInLoops: each injection resolves independently; refactoring to Promise.all requires restructuring hitl detection
      const resolved = await resolveHandoffInjection(injection, workspace);
      warnings.push(...resolved.warnings);
      if (resolved.value !== undefined) {
        variables[injection.as] = resolved.value;
      }
      continue;
    }

    const resolved = await resolveStateInjection(injection, board, workspace);
    warnings.push(...resolved.warnings);
    if (resolved.value !== undefined) {
      variables[injection.as] = resolved.value;
    }
  }

  return { hitl, variables, warnings };
}

/**
 * Resolve a file_context injection by reading file summaries and graph metrics
 * from the KG database for the files listed in board.metadata.affected_files.
 *
 * Gracefully degrades on all failure modes — missing metadata, parse errors,
 * unavailable KG DB, or missing KG entries all produce warnings and return
 * no value rather than throwing.
 */
/** Parse affected_files from board metadata. Returns file paths or a warning string on failure. */
function parseAffectedFiles(board: Board): string[] | string {
  const raw = board.metadata?.affected_files;
  if (raw === undefined || raw === null) {
    return "file_context: board metadata missing affected_files — skipping injection";
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return "file_context: affected_files is empty — skipping injection";
    }
    const filePaths = parsed.filter((x: unknown): x is string => typeof x === "string");
    if (filePaths.length === 0) {
      return "file_context: affected_files contains no valid string entries — skipping injection";
    }
    return filePaths;
  } catch {
    return "file_context: affected_files contains malformed JSON — skipping injection";
  }
}

/** Determine the tier and cap the file list accordingly. */
function capFilesByTier(filePaths: string[], workspace: string, warnings: string[]): string[] {
  let tier: "small" | "medium" | "large" = "medium";
  try {
    const session = getExecutionStore(workspace).getSession();
    tier = session?.tier ?? "medium";
  } catch {
    warnings.push("file_context: execution store unavailable — defaulting to medium tier");
  }
  return filePaths.slice(0, getItemCountCap(tier));
}

/** Build context lines for a single file from KG data. */
function buildFileContextLines(
  filePath: string,
  kgQuery: KgQuery,
  kgStore: KgStore,
  insightMaps: ReturnType<typeof computeFileInsightMaps>,
): string[] {
  const lines: string[] = [];
  const metrics = kgQuery.getFileMetrics(filePath, {
    cycleMemberPaths: insightMaps.cycleMemberPaths,
    hubPaths: insightMaps.hubPaths,
    layerViolationsByPath: insightMaps.layerViolationsByPath,
  });

  if (metrics) {
    const hubLabel = metrics.is_hub ? "yes" : "no";
    lines.push(
      `**${filePath}** (layer: ${metrics.layer}, in_degree: ${metrics.in_degree}, out_degree: ${metrics.out_degree}, hub: ${hubLabel})`,
    );
  } else {
    lines.push(`**${filePath}** (not indexed)`);
  }

  const fileRow = kgStore.getFile(filePath);
  if (fileRow?.file_id !== undefined) {
    const summaryRow = kgStore.getSummaryByFile(fileRow.file_id);
    if (summaryRow?.summary) lines.push(`Summary: ${summaryRow.summary}`);
  }

  lines.push("");
  return lines;
}

async function resolveFileContextInjection(
  _injection: ContextInjection,
  board: Board,
  workspace: string,
): Promise<{ value?: string; warnings: string[] }> {
  const warnings: string[] = [];

  const parseResult = parseAffectedFiles(board);
  if (typeof parseResult === "string") {
    warnings.push(parseResult);
    return { warnings };
  }

  const cappedFiles = capFilesByTier(parseResult, workspace, warnings);

  const projectDir = process.env.CANON_PROJECT_DIR ?? process.cwd();
  const dbPath = path.join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(dbPath)) {
    warnings.push("file_context: KG database unavailable — skipping file context injection");
    return { warnings };
  }

  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
  } catch {
    warnings.push("file_context: failed to open KG database — skipping file context injection");
    return { warnings };
  }

  try {
    const kgQuery = new KgQuery(db);
    const kgStore = new KgStore(db);

    const freshnessMs = kgQuery.getKgFreshnessMs();
    if (freshnessMs !== null && freshnessMs > 3_600_000) {
      warnings.push(
        `file_context: KG data is stale (${Math.round(freshnessMs / 60_000)} minutes old) — context may be outdated`,
      );
    }

    const insightMaps = computeFileInsightMaps(db);
    const lines: string[] = [`### File Context (${cappedFiles.length} files)`, ""];

    for (const filePath of cappedFiles) {
      lines.push(...buildFileContextLines(filePath, kgQuery, kgStore, insightMaps));
    }

    return { value: lines.join("\n").trimEnd(), warnings };
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}

const HANDOFF_CAP_BYTES = 50 * 1024; // 50KB

/**
 * Resolve a handoff injection by reading .md files from {workspace}/handoffs/.
 *
 * The `injection.section` field, when present, is used as a FILENAME filter:
 * it matches files whose basename (without .md extension) equals the section name
 * (case-insensitive). This is intentionally different from resolveStateInjection,
 * which uses extractSection() to filter by markdown heading within file content.
 * Do NOT use extractSection() here — section = filename, not heading.
 *
 * Files are concatenated with "## {basename}\n\n{content}" headers.
 * A 50KB cap is applied with whole-file granularity: if adding a file would
 * exceed 50KB, that file is skipped (not truncated) and a warning is emitted.
 * Remaining files continue to be checked after a skip (a smaller file may still fit).
 *
 * All fs errors produce warnings; never throws.
 */
async function resolveHandoffInjection(
  injection: ContextInjection,
  workspace: string,
): Promise<{ value?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const handoffsDir = path.resolve(workspace, "handoffs");

  // Validate path is inside workspace
  if (!isPathContained(workspace, handoffsDir)) {
    warnings.push("handoff: handoffs/ path escapes workspace — skipping injection");
    return { warnings };
  }

  // Check directory exists
  if (!existsSync(handoffsDir)) {
    warnings.push("handoff: handoffs/ directory not found — skipping injection");
    return { warnings };
  }

  // Read directory entries, filtering to .md files only
  let entries: string[];
  try {
    const all = await readdir(handoffsDir);
    entries = all.filter((f) => f.endsWith(".md")).sort();
  } catch {
    warnings.push("handoff: failed to read handoffs/ directory — skipping injection");
    return { warnings };
  }

  // Apply section filter (filename match, NOT markdown heading extraction).
  // injection.section matches basename without extension, case-insensitive.
  if (injection.section) {
    const sectionLower = injection.section.toLowerCase();
    entries = entries.filter((f) => path.basename(f, ".md").toLowerCase() === sectionLower);
  }

  if (entries.length === 0) {
    warnings.push("handoff: no matching .md files in handoffs/ — skipping injection");
    return { warnings };
  }

  // Read each file and concatenate with 50KB whole-file cap.
  // Skip files that would push total over cap; continue checking remaining files.
  const parts: string[] = [];
  let totalBytes = 0;

  for (const filename of entries) {
    const filePath = path.join(handoffsDir, filename);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      warnings.push(`handoff: failed to read "${filename}" — skipping`);
      continue;
    }

    const basename = path.basename(filename, ".md");
    const chunk = `## ${basename}\n\n${content}`;
    const chunkBytes = Buffer.byteLength(chunk, "utf-8");

    if (totalBytes + chunkBytes > HANDOFF_CAP_BYTES) {
      warnings.push(`handoff: ${filename} skipped — 50KB injection cap reached`);
      continue;
    }

    parts.push(chunk);
    totalBytes += chunkBytes;
  }

  if (parts.length === 0) {
    return { warnings };
  }

  return { value: parts.join("\n\n"), warnings };
}

async function resolveStateInjection(
  injection: ContextInjection,
  board: Board,
  workspace: string,
): Promise<{ value?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const sourceState = board.states[injection.from];

  if (!sourceState) {
    warnings.push(`inject_context: source state "${injection.from}" not found in board`);
    return { warnings };
  }

  const artifacts = sourceState.artifacts ?? [];
  if (artifacts.length === 0) {
    warnings.push(`inject_context: state "${injection.from}" has no artifacts`);
    return { warnings };
  }

  const {
    contents,
    anyFound,
    warnings: readWarnings,
  } = await readArtifacts(artifacts, workspace, injection.from);
  warnings.push(...readWarnings);

  if (!anyFound) {
    warnings.push(`inject_context: all artifacts from state "${injection.from}" are missing`);
    return { warnings };
  }

  let result = contents.join("\n\n");

  if (injection.section) {
    const extracted = extractSection(result, injection.section);
    if (extracted !== null) {
      result = extracted;
    } else {
      warnings.push(
        `inject_context: section "${injection.section}" not found in artifacts from "${injection.from}" — injecting full content`,
      );
    }
  }

  return { value: result, warnings };
}

async function readArtifacts(
  artifacts: string[],
  workspace: string,
  stateName: string,
): Promise<{ contents: string[]; anyFound: boolean; warnings: string[] }> {
  const workspaceRoot = path.resolve(workspace);

  type ArtifactResult = { content: string | null; warning: string | null };

  const results = await Promise.all(
    artifacts.map(async (artifactPath): Promise<ArtifactResult> => {
      const fullPath = path.resolve(workspace, artifactPath);
      if (!fullPath.startsWith(workspaceRoot + path.sep) && fullPath !== workspaceRoot) {
        return {
          content: null,
          warning: `inject_context: artifact path "${artifactPath}" escapes workspace — blocked`,
        };
      }
      if (!existsSync(fullPath)) {
        return {
          content: null,
          warning: `inject_context: artifact "${artifactPath}" from state "${stateName}" not found on disk`,
        };
      }
      try {
        const content = await readFile(fullPath, "utf-8");
        return { content, warning: null };
      } catch {
        return {
          content: null,
          warning: `inject_context: failed to read artifact "${artifactPath}"`,
        };
      }
    }),
  );

  const contents: string[] = [];
  const warnings: string[] = [];
  for (const r of results) {
    if (r.warning) warnings.push(r.warning);
    if (r.content !== null) contents.push(r.content);
  }

  return { anyFound: contents.length > 0, contents, warnings };
}

/**
 * Extract content under a markdown heading (any level).
 * Returns content from the heading to the next heading of same or higher level, or end of string.
 * Returns null if heading not found.
 */
export function extractSection(markdown: string, sectionName: string): string | null {
  const lines = markdown.split("\n");
  const captured: string[] = [];
  let captureLevel = 0;
  const target = sectionName.toLowerCase();

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (captured.length === 0) {
      // Not yet capturing — look for the target heading
      if (headingMatch && headingMatch[2].trim().toLowerCase() === target) {
        captureLevel = headingMatch[1].length;
        captured.push(line);
      }
      continue;
    }

    // Currently capturing — stop at same or higher level heading
    if (headingMatch && headingMatch[1].length <= captureLevel) break;
    captured.push(line);
  }

  return captured.length > 0 ? captured.join("\n").trim() : null;
}
