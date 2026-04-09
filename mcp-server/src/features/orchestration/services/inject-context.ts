import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ContextInjection } from "@domains/flows/flow-definition-schemas.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import {
  escapeDollarBrace,
  parseTaskIdsForWave,
} from "@domains/workspaces/wave-variables.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { isPathContained } from "@shared/lib/worktree-guard.ts";
import { getItemCountCap } from "./context-budget.ts";
import { buildKgFileEntries, formatKgFileContext } from "./kg-context-formatter.ts";

type InjectionResult = {
  variables: Record<string, string>;
  hitl?: { prompt: string; as: string };
  warnings: string[];
};

function applyInjectionResult(
  resolved: { value?: string; warnings: string[] },
  as: string,
  variables: Record<string, string>,
  warnings: string[],
): void {
  warnings.push(...resolved.warnings);
  if (resolved.value !== undefined) {
    variables[as] = resolved.value;
  }
}

export async function resolveContextInjections(
  injections: ContextInjection[],
  board: Board,
  workspace: string,
): Promise<InjectionResult> {
  const variables: Record<string, string> = {};
  const warnings: string[] = [];
  let hitl: { prompt: string; as: string } | undefined;

  // The outer loop must remain sequential: the "user" branch sets hitl as a side effect.
  for (const injection of injections) {
    if (injection.from === "user") {
      hitl = { as: injection.as, prompt: injection.prompt ?? "Please provide input" };
      continue;
    }

    if (injection.from === "file_context") {
      // biome-ignore lint/performance/noAwaitInLoops: each injection resolves independently; refactoring to Promise.all requires restructuring hitl detection
      const resolved = await resolveFileContextInjection(injection, board, workspace);
      applyInjectionResult(resolved, injection.as, variables, warnings);
      continue;
    }

    if (injection.from === "handoff") {
      const resolved = await resolveHandoffInjection(injection, workspace);
      applyInjectionResult(resolved, injection.as, variables, warnings);
      continue;
    }

    if (injection.from === "wave_summaries") {
      // biome-ignore lint/performance/noAwaitInLoops: each injection resolves independently
      const resolved = await resolveWaveSummaryInjection(injection, board, workspace);
      applyInjectionResult(resolved, injection.as, variables, warnings);
      continue;
    }

    if (injection.from === "prior_workspace") {
      // biome-ignore lint/performance/noAwaitInLoops: each injection resolves independently
      const resolved = await resolvePriorWorkspaceInjection(injection, workspace);
      applyInjectionResult(resolved, injection.as, variables, warnings);
      continue;
    }

    const resolved = await resolveStateInjection(injection, board, workspace);
    applyInjectionResult(resolved, injection.as, variables, warnings);
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

    const freshnessMs = kgQuery.getKgFreshnessMs();
    if (freshnessMs !== null && freshnessMs > 3_600_000) {
      warnings.push(
        `file_context: KG data is stale (${Math.round(freshnessMs / 60_000)} minutes old) — context may be outdated`,
      );
    }

    const entries = buildKgFileEntries(cappedFiles, db);
    const value = formatKgFileContext(entries);

    return { value, warnings };
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}

const HANDOFF_CAP_BYTES = 50 * 1024; // 50KB
const WAVE_SUMMARIES_CAP_BYTES = 50 * 1024; // 50KB

/**
 * Resolve a wave_summaries injection by reading *-SUMMARY.md files from prior waves.
 *
 * Steps:
 * 1. Read slug from execution store session
 * 2. Determine current wave from board.states[board.current_state].wave
 * 3. Parse INDEX.md to find tasks from waves BEFORE the current wave
 * 4. Read those *-SUMMARY.md files and concatenate them
 * 5. Apply a 50KB cap (whole-file granularity, same as handoff)
 * 6. Escape with escapeDollarBrace to prevent variable expansion
 *
 * Gracefully degrades: missing INDEX.md, no prior-wave tasks, missing summary
 * files, or no session all produce warnings and return no value rather than
 * throwing.
 */
async function resolveWaveSummaryInjection(
  _injection: ContextInjection,
  board: Board,
  workspace: string,
): Promise<{ value?: string; warnings: string[] }> {
  const warnings: string[] = [];

  // Get slug from execution store session
  let slug: string;
  try {
    const session = getExecutionStore(workspace).getSession();
    if (!session?.slug) {
      warnings.push(
        "wave_summaries: execution store session unavailable — skipping injection",
      );
      return { warnings };
    }
    slug = session.slug;
  } catch {
    warnings.push(
      "wave_summaries: failed to read execution store session — skipping injection",
    );
    return { warnings };
  }

  // Determine current wave from board current_state entry
  const currentStateEntry = board.states[board.current_state];
  const currentWave = currentStateEntry?.wave ?? 1;

  if (currentWave <= 1) {
    warnings.push(
      "wave_summaries: no prior-wave summaries exist (this is wave 1) — skipping injection",
    );
    return { warnings };
  }

  // Read INDEX.md and find tasks from all prior waves (waves < currentWave)
  const plansDir = path.join(workspace, "plans", slug);
  const indexPath = path.join(plansDir, "INDEX.md");

  if (!existsSync(indexPath)) {
    warnings.push(
      `wave_summaries: INDEX.md not found at ${indexPath} — skipping injection`,
    );
    return { warnings };
  }

  let indexContent: string;
  try {
    indexContent = await readFile(indexPath, "utf-8");
  } catch {
    warnings.push(
      `wave_summaries: failed to read INDEX.md at ${indexPath} — skipping injection`,
    );
    return { warnings };
  }

  // Collect task IDs from all prior waves (1 through currentWave - 1)
  const priorWaveTaskIds: string[] = [];
  for (let wave = 1; wave < currentWave; wave++) {
    const ids = parseTaskIdsForWave(indexContent, wave);
    priorWaveTaskIds.push(...ids);
  }

  if (priorWaveTaskIds.length === 0) {
    warnings.push(
      "wave_summaries: no prior-wave tasks found in INDEX.md — skipping injection",
    );
    return { warnings };
  }

  // Read summary files for prior-wave tasks
  type SummaryReadResult =
    | { taskId: string; chunk: string }
    | { taskId: string; missing: true };

  const readResults = await Promise.all(
    priorWaveTaskIds.map(async (taskId): Promise<SummaryReadResult> => {
      const summaryPath = path.join(plansDir, `${taskId}-SUMMARY.md`);
      if (!existsSync(summaryPath)) {
        return { missing: true, taskId };
      }
      try {
        const content = await readFile(summaryPath, "utf-8");
        return { chunk: `## ${taskId}\n\n${content}`, taskId };
      } catch {
        return { missing: true, taskId };
      }
    }),
  );

  // Apply byte cap with whole-file granularity
  const parts: string[] = [];
  let totalBytes = 0;
  for (const result of readResults) {
    if ("missing" in result) {
      // Missing summaries are silently skipped (partial data is expected)
      continue;
    }
    const rawBytes = Buffer.byteLength(result.chunk, "utf-8");
    if (totalBytes + rawBytes > WAVE_SUMMARIES_CAP_BYTES) {
      warnings.push(
        `wave_summaries: ${result.taskId}-SUMMARY.md skipped — 50KB injection cap reached`,
      );
      continue;
    }
    parts.push(result.chunk);
    totalBytes += rawBytes;
  }

  if (parts.length === 0) {
    warnings.push(
      "wave_summaries: no prior-wave summary files found — skipping injection",
    );
    return { warnings };
  }

  const value = escapeDollarBrace(parts.join("\n\n"));
  return { value, warnings };
}

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
/** Read handoff .md files with a 50KB total cap. */
async function readAndCapHandoffFiles(
  entries: string[],
  handoffsDir: string,
  warnings: string[],
): Promise<{ value?: string; warnings: string[] }> {
  type ReadResult = { filename: string; chunk: string } | { filename: string; error: true };

  const readResults = await Promise.all(
    entries.map(async (filename): Promise<ReadResult> => {
      const filePath = path.join(handoffsDir, filename);
      try {
        const content = await readFile(filePath, "utf-8");
        const basename = path.basename(filename, ".md");
        return { chunk: `## ${basename}\n\n${content}`, filename };
      } catch {
        return { error: true, filename };
      }
    }),
  );

  const parts: string[] = [];
  let totalBytes = 0;
  for (const result of readResults) {
    if ("error" in result) {
      warnings.push(`handoff: failed to read "${result.filename}" — skipping`);
      continue;
    }
    const chunkBytes = Buffer.byteLength(result.chunk, "utf-8");
    if (totalBytes + chunkBytes > HANDOFF_CAP_BYTES) {
      warnings.push(`handoff: ${result.filename} skipped — 50KB injection cap reached`);
      continue;
    }
    parts.push(result.chunk);
    totalBytes += chunkBytes;
  }

  if (parts.length === 0) return { warnings };
  return { value: parts.join("\n\n"), warnings };
}

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

  return readAndCapHandoffFiles(entries, handoffsDir, warnings);
}

/**
 * Resolve a prior_workspace injection by reading .md files from {workspace}/seeded/.
 *
 * When `injection.section === "research"`, reads from `seeded/research/`.
 * Otherwise defaults to `seeded/handoffs/`.
 *
 * If the seeded/ directory does not exist, returns a warning and no value —
 * this is expected for workspaces not seeded from a prior flow.
 *
 * Content is wrapped with a "# Prior Flow Context" header and passed through
 * readAndCapHandoffFiles for the 50KB cap and file-level error handling.
 * Dollar-brace patterns are escaped before returning.
 *
 * All fs errors produce warnings; never throws.
 */
async function resolvePriorWorkspaceInjection(
  injection: ContextInjection,
  workspace: string,
): Promise<{ value?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const seededDir = path.resolve(workspace, "seeded");

  // Validate path is inside workspace
  if (!isPathContained(workspace, seededDir)) {
    warnings.push("prior_workspace: seeded/ path escapes workspace — skipping injection");
    return { warnings };
  }

  // Check seeded/ directory exists
  if (!existsSync(seededDir)) {
    warnings.push("prior_workspace: no seeded content found — skipping injection");
    return { warnings };
  }

  // Determine subdirectory based on section
  const subdir = injection.section === "research" ? "research" : "handoffs";
  const targetDir = path.join(seededDir, subdir);

  // Check subdirectory exists
  if (!existsSync(targetDir)) {
    warnings.push(`prior_workspace: seeded/${subdir}/ not found — skipping injection`);
    return { warnings };
  }

  // Read directory entries, filtering to .md files only
  let entries: string[];
  try {
    const all = await readdir(targetDir);
    entries = all.filter((f) => f.endsWith(".md")).sort();
  } catch {
    warnings.push(`prior_workspace: failed to read seeded/${subdir}/ — skipping injection`);
    return { warnings };
  }

  if (entries.length === 0) {
    warnings.push(`prior_workspace: no .md files in seeded/${subdir}/ — skipping injection`);
    return { warnings };
  }

  const result = await readAndCapHandoffFiles(entries, targetDir, warnings);
  if (result.value === undefined) {
    return { warnings };
  }

  const value = escapeDollarBrace(`# Prior Flow Context\n\n${result.value}`);
  return { value, warnings };
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
