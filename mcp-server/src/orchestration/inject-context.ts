import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { computeFileInsightMaps, KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import { getItemCountCap } from "./context-budget.ts";
import { getExecutionStore } from "./execution-store.ts";
import type { Board, ContextInjection } from "./flow-schema.ts";

interface InjectionResult {
  variables: Record<string, string>;
  hitl?: { prompt: string; as: string };
  warnings: string[];
}

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
      hitl = { prompt: injection.prompt ?? "Please provide input", as: injection.as };
      continue;
    }

    if (injection.from === "file_context") {
      const resolved = await resolveFileContextInjection(injection, board, workspace);
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

  return { variables, hitl, warnings };
}

/**
 * Resolve a file_context injection by reading file summaries and graph metrics
 * from the KG database for the files listed in board.metadata.affected_files.
 *
 * Gracefully degrades on all failure modes — missing metadata, parse errors,
 * unavailable KG DB, or missing KG entries all produce warnings and return
 * no value rather than throwing.
 */
async function resolveFileContextInjection(
  injection: ContextInjection,
  board: Board,
  workspace: string,
): Promise<{ value?: string; warnings: string[] }> {
  const warnings: string[] = [];

  // --- 1. Read affected_files from board metadata ---
  const rawAffectedFiles = board.metadata?.affected_files;
  if (rawAffectedFiles === undefined || rawAffectedFiles === null) {
    warnings.push("file_context: board metadata missing affected_files — skipping injection");
    return { warnings };
  }

  let filePaths: string[];
  try {
    const parsed = JSON.parse(String(rawAffectedFiles));
    if (!Array.isArray(parsed) || parsed.length === 0) {
      warnings.push("file_context: affected_files is empty — skipping injection");
      return { warnings };
    }
    filePaths = parsed as string[];
  } catch {
    warnings.push("file_context: affected_files contains malformed JSON — skipping injection");
    return { warnings };
  }

  // --- 2. Determine tier and cap file list ---
  const session = getExecutionStore(workspace).getSession();
  const tier = session?.tier ?? "medium";
  const cap = getItemCountCap(tier);
  const cappedFiles = filePaths.slice(0, cap);

  // --- 3. Open KG DB ---
  const projectDir = process.env["CANON_PROJECT_DIR"] ?? process.cwd();
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

    // --- 4. Check KG staleness ---
    const freshnessMs = kgQuery.getKgFreshnessMs();
    if (freshnessMs !== null && freshnessMs > 3_600_000) {
      warnings.push(
        `file_context: KG data is stale (${Math.round(freshnessMs / 60_000)} minutes old) — context may be outdated`,
      );
    }

    // --- 5. Compute insight maps ONCE for all files ---
    const insightMaps = computeFileInsightMaps(db);

    // --- 6. Build file context entries ---
    const lines: string[] = [`### File Context (${cappedFiles.length} files)`, ""];

    for (const filePath of cappedFiles) {
      const metrics = kgQuery.getFileMetrics(filePath, {
        hubPaths: insightMaps.hubPaths,
        cycleMemberPaths: insightMaps.cycleMemberPaths,
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

      // Try to get summary from KG
      const fileRow = kgStore.getFile(filePath);
      if (fileRow?.file_id !== undefined) {
        const summaryRow = kgStore.getSummaryByFile(fileRow.file_id);
        if (summaryRow?.summary) {
          lines.push(`Summary: ${summaryRow.summary}`);
        }
      }

      lines.push("");
    }

    return { value: lines.join("\n").trimEnd(), warnings };
  } finally {
    // better-sqlite3 databases should be closed when done
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
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

  const { contents, anyFound, warnings: readWarnings } = await readArtifacts(artifacts, workspace, injection.from);
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
  const contents: string[] = [];
  const warnings: string[] = [];
  let anyFound = false;
  const workspaceRoot = path.resolve(workspace);

  for (const artifactPath of artifacts) {
    const fullPath = path.resolve(workspace, artifactPath);
    if (!fullPath.startsWith(workspaceRoot + path.sep) && fullPath !== workspaceRoot) {
      warnings.push(`inject_context: artifact path "${artifactPath}" escapes workspace — blocked`);
      continue;
    }
    if (!existsSync(fullPath)) {
      warnings.push(`inject_context: artifact "${artifactPath}" from state "${stateName}" not found on disk`);
      continue;
    }
    try {
      const content = await readFile(fullPath, "utf-8");
      contents.push(content);
      anyFound = true;
    } catch {
      warnings.push(`inject_context: failed to read artifact "${artifactPath}"`);
    }
  }

  return { contents, anyFound, warnings };
}

/**
 * Extract content under a markdown heading (any level).
 * Returns content from the heading to the next heading of same or higher level, or end of string.
 * Returns null if heading not found.
 */
export function extractSection(markdown: string, sectionName: string): string | null {
  const lines = markdown.split("\n");
  let capturing = false;
  let captureLevel = 0;
  const captured: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim().toLowerCase();

      if (!capturing && title === sectionName.toLowerCase()) {
        capturing = true;
        captureLevel = level;
        captured.push(line);
        continue;
      }

      if (capturing && level <= captureLevel) {
        break; // Next heading of same or higher level
      }
    }

    if (capturing) {
      captured.push(line);
    }
  }

  return captured.length > 0 ? captured.join("\n").trim() : null;
}
