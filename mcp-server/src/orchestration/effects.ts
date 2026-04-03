/**
 * Drift effect executor — runs declarative effects after state completion.
 * Effects parse agent artifacts and persist drift data (reviews).
 * All effects are best-effort: parse failures are logged but never block the flow.
 */

import { readFile, readdir } from "fs/promises";
import { join, basename } from "path";
import { z } from "zod";
import { DriftStore } from "../drift/store.ts";
import { generateId } from "../utils/id.ts";
import type { StateDefinition, Effect } from "./flow-schema.ts";
import type { ReviewEntry } from "../schema.ts";
import { getExecutionStore } from "./execution-store.ts";
import { resolvePostconditions, evaluatePostconditions } from "./contract-checker.ts";

/** Zod schema for validating REVIEW.meta.json structure before using it. */
const ReviewMetaSchema = z.object({
  _type: z.literal("review"),
  _version: z.literal(1),
  verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]),
  files: z.array(z.string()).optional(),
  violations: z.array(z.object({
    principle_id: z.string(),
    severity: z.string(),
    file_path: z.string().optional(),
  })).optional(),
  honored: z.array(z.string()).optional(),
  score: z.object({
    rules: z.object({ passed: z.number(), total: z.number() }),
    opinions: z.object({ passed: z.number(), total: z.number() }),
    conventions: z.object({ passed: z.number(), total: z.number() }),
  }).optional(),
});

export interface EffectResult {
  type: string;
  recorded: number;
  errors: string[];
}

/**
 * Execute all effects declared on a state definition.
 * Called by report_result after board write.
 *
 * @param stateName - Optional state name used to look up discovered postconditions on the board.
 *                    Required when check_postconditions effect is used.
 */
export async function executeEffects(
  stateDef: StateDefinition,
  workspace: string,
  artifacts: string[],
  projectDir: string,
  stateName?: string,
): Promise<EffectResult[]> {
  if (!stateDef.effects?.length) return [];

  const store = new DriftStore(projectDir);
  const results: EffectResult[] = [];

  for (const effect of stateDef.effects) {
    try {
      const result = await executeOneEffect(effect, store, workspace, artifacts, projectDir, stateName, stateDef);
      results.push(result);
    } catch (err) {
      results.push({
        type: effect.type,
        recorded: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  return results;
}

async function executeOneEffect(
  effect: Effect,
  store: DriftStore,
  workspace: string,
  artifacts: string[],
  projectDir: string,
  stateName?: string,
  stateDef?: StateDefinition,
): Promise<EffectResult> {
  switch (effect.type) {
    case "persist_review":
      return persistReview(effect, store, workspace, artifacts);
    case "check_postconditions":
      return checkPostconditions(stateDef, workspace, projectDir, stateName);
  }
}

// ---------------------------------------------------------------------------
// check_postconditions — resolve and evaluate assertions from YAML or board
// ---------------------------------------------------------------------------

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
    type: "check_postconditions",
    recorded: results.length,
    errors,
  };
}

// ---------------------------------------------------------------------------
// persist_review — read REVIEW.meta.json first, fall back to REVIEW.md regex
// ---------------------------------------------------------------------------

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
          review_id: generateId("rev"),
          timestamp: new Date().toISOString(),
          verdict: meta.verdict,
          files: meta.files ?? [],
          violations: meta.violations ?? [],
          honored: meta.honored ?? [],
          score: meta.score ?? { rules: { passed: 0, total: 0 }, opinions: { passed: 0, total: 0 }, conventions: { passed: 0, total: 0 } },
        };
        await store.appendReview(entry);
        return { type: "persist_review", recorded: 1, errors: [] };
      }
      // Zod validation failed — fall through to legacy parse
    } catch { /* fall through to legacy parse */ }
  }

  // Legacy fallback: regex parse REVIEW.md
  const content = await resolveAndRead(artifactName, workspace, artifacts);
  if (!content) {
    return { type: "persist_review", recorded: 0, errors: ["Artifact not found: " + artifactName] };
  }

  const parsed = parseReviewArtifact(content);
  if (!parsed) {
    return { type: "persist_review", recorded: 0, errors: ["Failed to parse review artifact"] };
  }

  const entry: ReviewEntry = {
    review_id: generateId("rev"),
    timestamp: new Date().toISOString(),
    verdict: parsed.verdict,
    files: parsed.files,
    violations: parsed.violations,
    honored: parsed.honored,
    score: parsed.score,
  };

  await store.appendReview(entry);
  return { type: "persist_review", recorded: 1, errors: [] };
}

interface ParsedReview {
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
}

/**
 * Parse a REVIEW.md following the review-checklist template.
 * Extracts: YAML frontmatter verdict, violations table, honored list, score table.
 *
 * Exported for backward compat tests — internal callers prefer the .meta.json
 * structured path in persistReview.
 */
export function parseReviewArtifact(content: string): ParsedReview | null {
  // Parse YAML frontmatter for verdict
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let verdict: ParsedReview["verdict"] = "CLEAN";
  const filesReviewed: string[] = [];

  if (fmMatch) {
    const fm = fmMatch[1];
    const verdictMatch = fm.match(/verdict:\s*"?(BLOCKING|WARNING|CLEAN)"?/i);
    if (verdictMatch) {
      verdict = verdictMatch[1].toUpperCase() as ParsedReview["verdict"];
    }
  }

  // Fallback: parse verdict from heading
  const headingMatch = content.match(/## Canon Review — Verdict:\s*(BLOCKING|WARNING|CLEAN)/i);
  if (headingMatch) {
    verdict = headingMatch[1].toUpperCase() as ParsedReview["verdict"];
  }

  // Parse violations table
  const violations: ParsedReview["violations"] = [];
  const violationTableMatch = content.match(
    /#### Violations\s*\n(?:<!--.*?-->\s*\n)?\|.*?\|\s*\n\|[-| ]+\|\s*\n((?:\|.*\|\s*\n)*)/,
  );
  if (violationTableMatch) {
    const rows = violationTableMatch[1].trim().split("\n");
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 3) {
        const filePath = cells[2]?.replace(/`/g, "").split(":")[0];
        violations.push({
          principle_id: cells[0],
          severity: cells[1],
          ...(filePath ? { file_path: filePath } : {}),
        });
        // Collect files from violations for the files array
        if (filePath && !filesReviewed.includes(filePath)) {
          filesReviewed.push(filePath);
        }
      }
    }
  }

  // Parse honored list
  const honored: string[] = [];
  const honoredMatch = content.match(/#### Honored\s*\n(?:<!--.*?-->\s*\n)?((?:- \*\*.*\n)*)/);
  if (honoredMatch) {
    const lines = honoredMatch[1].trim().split("\n");
    for (const line of lines) {
      const idMatch = line.match(/- \*\*([^*]+)\*\*/);
      if (idMatch) {
        honored.push(idMatch[1]);
      }
    }
  }

  // Parse score table
  let score: ParsedReview["score"] = {
    rules: { passed: 0, total: 0 },
    opinions: { passed: 0, total: 0 },
    conventions: { passed: 0, total: 0 },
  };
  const scoreTableMatch = content.match(
    /#### Score\s*\n\|.*?\|\s*\n\|[-| ]+\|\s*\n((?:\|.*\|\s*\n)*)/,
  );
  if (scoreTableMatch) {
    const rows = scoreTableMatch[1].trim().split("\n");
    // Aggregate across all layer rows
    let rulesP = 0, rulesT = 0, opinionsP = 0, opinionsT = 0, convsP = 0, convsT = 0;
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 4) {
        const parseScore = (s: string) => {
          const m = s.match(/(\d+)\s*\/\s*(\d+)/);
          return m ? { passed: parseInt(m[1]), total: parseInt(m[2]) } : { passed: 0, total: 0 };
        };
        const r = parseScore(cells[1]);
        const o = parseScore(cells[2]);
        const c = parseScore(cells[3]);
        rulesP += r.passed; rulesT += r.total;
        opinionsP += o.passed; opinionsT += o.total;
        convsP += c.passed; convsT += c.total;
      }
    }
    score = {
      rules: { passed: rulesP, total: rulesT },
      opinions: { passed: opinionsP, total: opinionsT },
      conventions: { passed: convsP, total: convsT },
    };
  }

  return { verdict, files: filesReviewed, violations, honored, score };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve an artifact name to a file path and read its content. */
async function resolveAndRead(
  artifactName: string,
  workspace: string,
  artifacts: string[],
): Promise<string | null> {
  // First try matching against reported artifacts list
  const match = artifacts.find((a) => basename(a) === artifactName || a.endsWith(artifactName));
  if (match) {
    const fullPath = match.startsWith("/") ? match : join(workspace, match);
    try {
      return await readFile(fullPath, "utf-8");
    } catch {
      // fall through to directory scan
    }
  }

  // Scan common artifact locations
  const directPaths = [
    join(workspace, "reviews", artifactName),
  ];

  for (const p of directPaths) {
    try {
      return await readFile(p, "utf-8");
    } catch { /* continue */ }
  }

  // Search in plans subdirectories
  const plansDir = join(workspace, "plans");
  const subdirs = await readdir(plansDir).catch(() => []);
  for (const sub of subdirs) {
    const candidate = join(plansDir, sub, artifactName);
    const content = await readFile(candidate, "utf-8").catch(() => null);
    if (content) return content;
  }

  return null;
}
