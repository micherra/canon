/**
 * Drift effect executor — runs declarative effects after state completion.
 * Effects parse agent artifacts and persist drift data (reviews).
 * All effects are best-effort: parse failures are logged but never block the flow.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { DriftStore } from "../drift/store.ts";
import type { ReviewEntry } from "../schema.ts";
import { generateId } from "../utils/id.ts";
import { evaluatePostconditions, resolvePostconditions } from "./contract-checker.ts";
import { getExecutionStore } from "./execution-store.ts";
import type { Effect, StateDefinition } from "./flow-schema.ts";

/** Zod schema for validating REVIEW.meta.json structure before using it. */
const ReviewMetaSchema = z.object({
  _type: z.literal("review"),
  _version: z.literal(1),
  files: z.array(z.string()).optional(),
  honored: z.array(z.string()).optional(),
  score: z
    .object({
      conventions: z.object({ passed: z.number(), total: z.number() }),
      opinions: z.object({ passed: z.number(), total: z.number() }),
      rules: z.object({ passed: z.number(), total: z.number() }),
    })
    .optional(),
  verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]),
  violations: z
    .array(
      z.object({
        file_path: z.string().optional(),
        principle_id: z.string(),
        severity: z.string(),
      }),
    )
    .optional(),
});

export type EffectResult = {
  type: string;
  recorded: number;
  errors: string[];
};

/**
 * Execute all effects declared on a state definition.
 * Called by report_result after board write.
 *
 * @param stateName - Optional state name used to look up discovered postconditions on the board.
 *                    Required when check_postconditions effect is used.
 */
export type ExecuteEffectsOpts = {
  workspace: string;
  artifacts: string[];
  projectDir: string;
  stateName?: string;
};

export async function executeEffects(
  stateDef: StateDefinition,
  opts: ExecuteEffectsOpts,
): Promise<EffectResult[]> {
  const { workspace, artifacts, projectDir, stateName } = opts;
  if (!stateDef.effects?.length) return [];

  const store = new DriftStore(projectDir);
  const results: EffectResult[] = [];

  for (const effect of stateDef.effects) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: effects execute sequentially; each may have side effects that later effects depend on
      const result = await executeOneEffect(effect, store, {
        artifacts,
        projectDir,
        stateDef,
        stateName,
        workspace,
      });
      results.push(result);
    } catch (err) {
      results.push({
        errors: [err instanceof Error ? err.message : String(err)],
        recorded: 0,
        type: effect.type,
      });
    }
  }

  return results;
}

type ExecuteOneEffectOpts = {
  workspace: string;
  artifacts: string[];
  projectDir: string;
  stateName?: string;
  stateDef?: StateDefinition;
};

async function executeOneEffect(
  effect: Effect,
  store: DriftStore,
  opts: ExecuteOneEffectOpts,
): Promise<EffectResult> {
  const { workspace, artifacts, projectDir, stateName, stateDef } = opts;
  switch (effect.type) {
    case "persist_review":
      return persistReview(effect, store, workspace, artifacts);
    case "check_postconditions":
      return checkPostconditions(stateDef, workspace, projectDir, stateName);
  }
}

// check_postconditions — resolve and evaluate assertions from YAML or board

async function checkPostconditions(
  stateDef: StateDefinition | undefined,
  workspace: string,
  projectDir: string,
  stateName?: string,
): Promise<EffectResult> {
  // Read the board to get base_commit and discovered_postconditions
  let baseCommit: string | undefined;
  let discoveredPostconditions: import("./flow-schema.ts").PostconditionAssertion[] | undefined;

  try {
    const board = getExecutionStore(workspace).getBoard();
    if (board) {
      baseCommit = board.base_commit;
      if (stateName) {
        const stateEntry = board.states[stateName];
        discoveredPostconditions = stateEntry?.discovered_postconditions;
      }
    }
  } catch {
    // Board not readable — continue with no discovered postconditions
  }

  // Explicit YAML postconditions take priority; discovered are the fallback.
  const resolved = resolvePostconditions(stateDef?.postconditions, discoveredPostconditions);
  const results = evaluatePostconditions(resolved, projectDir, baseCommit);
  const errors = results.filter((r) => !r.passed).map((r) => r.output ?? "");

  return {
    errors,
    recorded: results.length,
    type: "check_postconditions",
  };
}

// persist_review — read REVIEW.meta.json first, fall back to REVIEW.md regex

async function persistReview(
  effect: Effect,
  store: DriftStore,
  workspace: string,
  artifacts: string[],
): Promise<EffectResult> {
  const artifactName = effect.artifact ?? "REVIEW.md";
  const metaName = artifactName.replace(/\.md$/i, ".meta.json");

  // Try structured read first
  const metaContent = await resolveAndRead(metaName, workspace, artifacts);
  if (metaContent) {
    try {
      const raw = JSON.parse(metaContent);
      const parsed = ReviewMetaSchema.safeParse(raw);
      if (parsed.success) {
        const meta = parsed.data;
        const entry: ReviewEntry = {
          files: meta.files ?? [],
          honored: meta.honored ?? [],
          review_id: generateId("rev"),
          score: meta.score ?? {
            conventions: { passed: 0, total: 0 },
            opinions: { passed: 0, total: 0 },
            rules: { passed: 0, total: 0 },
          },
          timestamp: new Date().toISOString(),
          verdict: meta.verdict,
          violations: meta.violations ?? [],
        };
        await store.appendReview(entry);
        return { errors: [], recorded: 1, type: "persist_review" };
      }
      // Zod validation failed — fall through to legacy parse
    } catch {
      /* fall through to legacy parse */
    }
  }

  // Legacy fallback: regex parse REVIEW.md
  const content = await resolveAndRead(artifactName, workspace, artifacts);
  if (!content) {
    return { errors: [`Artifact not found: ${artifactName}`], recorded: 0, type: "persist_review" };
  }

  const parsed = parseReviewArtifact(content);
  if (!parsed) {
    return { errors: ["Failed to parse review artifact"], recorded: 0, type: "persist_review" };
  }

  const entry: ReviewEntry = {
    files: parsed.files,
    honored: parsed.honored,
    review_id: generateId("rev"),
    score: parsed.score,
    timestamp: new Date().toISOString(),
    verdict: parsed.verdict,
    violations: parsed.violations,
  };

  await store.appendReview(entry);
  return { errors: [], recorded: 1, type: "persist_review" };
}

type ParsedReview = {
  verdict: "BLOCKING" | "WARNING" | "CLEAN";
  files: string[];
  violations: Array<{
    principle_id: string;
    severity: string;
    file_path?: string;
  }>;
  honored: string[];
  score: {
    rules: { passed: number; total: number };
    opinions: { passed: number; total: number };
    conventions: { passed: number; total: number };
  };
};

/**
 * Parse a REVIEW.md following the review-checklist template.
 * Extracts: YAML frontmatter verdict, violations table, honored list, score table.
 *
 * Exported for backward compat tests — internal callers prefer the .meta.json
 * structured path in persistReview.
 */
/** Parse verdict from YAML frontmatter and heading fallback. */
function parseVerdict(content: string): ParsedReview["verdict"] {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const verdictMatch = fmMatch[1].match(/verdict:\s*"?(BLOCKING|WARNING|CLEAN)"?/i);
    if (verdictMatch) {
      return verdictMatch[1].toUpperCase() as ParsedReview["verdict"];
    }
  }

  // Fallback: parse verdict from heading
  const headingMatch = content.match(/## Canon Review — Verdict:\s*(BLOCKING|WARNING|CLEAN)/i);
  if (headingMatch) {
    return headingMatch[1].toUpperCase() as ParsedReview["verdict"];
  }

  return "CLEAN";
}

/** Parse violations table from review content. Returns violations and collected file paths. */
function parseViolationsTable(content: string): {
  violations: ParsedReview["violations"];
  filesReviewed: string[];
} {
  const violations: ParsedReview["violations"] = [];
  const filesReviewed: string[] = [];
  const tableMatch = content.match(
    /#### Violations\s*\n(?:<!--.*?-->\s*\n)?\|.*?\|\s*\n\|[-| ]+\|\s*\n((?:\|.*\|\s*\n)*)/,
  );
  if (!tableMatch) return { filesReviewed, violations };

  const rows = tableMatch[1].trim().split("\n");
  for (const row of rows) {
    const cells = row
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length < 3) continue;
    const filePath = cells[2]?.replace(/`/g, "").split(":")[0];
    violations.push({
      principle_id: cells[0],
      severity: cells[1],
      ...(filePath ? { file_path: filePath } : {}),
    });
    if (filePath && !filesReviewed.includes(filePath)) {
      filesReviewed.push(filePath);
    }
  }
  return { filesReviewed, violations };
}

/** Parse honored principle IDs from review content. */
function parseHonoredList(content: string): string[] {
  const honored: string[] = [];
  const honoredMatch = content.match(/#### Honored\s*\n(?:<!--.*?-->\s*\n)?((?:- \*\*.*\n)*)/);
  if (!honoredMatch) return honored;

  for (const line of honoredMatch[1].trim().split("\n")) {
    const idMatch = line.match(/- \*\*([^*]+)\*\*/);
    if (idMatch) honored.push(idMatch[1]);
  }
  return honored;
}

/** Parse a "N / M" score string into { passed, total }. */
function parseScoreCell(s: string): { passed: number; total: number } {
  const m = s.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { passed: parseInt(m[1], 10), total: parseInt(m[2], 10) } : { passed: 0, total: 0 };
}

/** Parse the score table from review content. */
function parseScoreTable(content: string): ParsedReview["score"] {
  const scoreTableMatch = content.match(
    /#### Score\s*\n\|.*?\|\s*\n\|[-| ]+\|\s*\n((?:\|.*\|\s*\n)*)/,
  );
  if (!scoreTableMatch) {
    return {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 0, total: 0 },
      rules: { passed: 0, total: 0 },
    };
  }

  let rulesP = 0,
    rulesT = 0,
    opinionsP = 0,
    opinionsT = 0,
    convsP = 0,
    convsT = 0;
  for (const row of scoreTableMatch[1].trim().split("\n")) {
    const cells = row
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length < 4) continue;
    const r = parseScoreCell(cells[1]);
    const o = parseScoreCell(cells[2]);
    const c = parseScoreCell(cells[3]);
    rulesP += r.passed;
    rulesT += r.total;
    opinionsP += o.passed;
    opinionsT += o.total;
    convsP += c.passed;
    convsT += c.total;
  }
  return {
    conventions: { passed: convsP, total: convsT },
    opinions: { passed: opinionsP, total: opinionsT },
    rules: { passed: rulesP, total: rulesT },
  };
}

export function parseReviewArtifact(content: string): ParsedReview | null {
  const verdict = parseVerdict(content);
  const { violations, filesReviewed } = parseViolationsTable(content);
  const honored = parseHonoredList(content);
  const score = parseScoreTable(content);

  return { files: filesReviewed, honored, score, verdict, violations };
}

/** Check if a resolved path is contained within the workspace directory. */
function isWithinWorkspace(resolvedWorkspace: string, resolvedPath: string): boolean {
  const rel = relative(resolvedWorkspace, resolvedPath);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
}

/** Try to read an artifact from the reported artifacts list. */
async function tryReadFromArtifactsList(
  artifactName: string,
  workspace: string,
  artifacts: string[],
): Promise<string | null> {
  const resolvedWorkspace = resolve(workspace);
  const match = artifacts.find((a) => basename(a) === artifactName || a.endsWith(artifactName));
  if (!match) return null;

  const fullPath = isAbsolute(match) ? match : join(workspace, match);
  const resolvedPath = resolve(fullPath);
  if (!isWithinWorkspace(resolvedWorkspace, resolvedPath)) return null;

  try {
    return await readFile(resolvedPath, "utf-8");
  } catch {
    return null;
  }
}

/** Resolve an artifact name to a file path and read its content. */
async function resolveAndRead(
  artifactName: string,
  workspace: string,
  artifacts: string[],
): Promise<string | null> {
  // First try matching against reported artifacts list
  const fromArtifacts = await tryReadFromArtifactsList(artifactName, workspace, artifacts);
  if (fromArtifacts) return fromArtifacts;

  // Scan common artifact locations
  const reviewPath = join(workspace, "reviews", artifactName);
  const reviewContent = await readFile(reviewPath, "utf-8").catch(() => null);
  if (reviewContent) return reviewContent;

  // Search in plans subdirectories
  const plansDir = join(workspace, "plans");
  const subdirs = await readdir(plansDir).catch(() => []);
  const candidates = await Promise.all(
    subdirs.map((sub) => readFile(join(plansDir, sub, artifactName), "utf-8").catch(() => null)),
  );
  const found = candidates.find((c) => c !== null);
  if (found) return found;

  return null;
}
