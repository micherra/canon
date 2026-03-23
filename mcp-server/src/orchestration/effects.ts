/**
 * Drift effect executor — runs declarative effects after state completion.
 * Effects parse agent artifacts and persist drift data (reviews, decisions, patterns).
 * All effects are best-effort: parse failures are logged but never block the flow.
 */

import { readFile, readdir } from "fs/promises";
import { join, basename } from "path";
import { DriftStore } from "../drift/store.js";
import { generateId } from "../utils/id.js";
import type { StateDefinition, Effect } from "./flow-schema.js";
import type { DecisionEntry, PatternEntry, ReviewEntry } from "../schema.js";

export interface EffectResult {
  type: string;
  recorded: number;
  errors: string[];
}

/**
 * Execute all effects declared on a state definition.
 * Called by report_result after board write.
 */
export async function executeEffects(
  stateDef: StateDefinition,
  workspace: string,
  artifacts: string[],
  projectDir: string,
): Promise<EffectResult[]> {
  if (!stateDef.effects?.length) return [];

  const store = new DriftStore(projectDir);
  const results: EffectResult[] = [];

  for (const effect of stateDef.effects) {
    try {
      const result = await executeOneEffect(effect, store, workspace, artifacts);
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
): Promise<EffectResult> {
  switch (effect.type) {
    case "persist_review":
      return persistReview(effect, store, workspace, artifacts);
    case "persist_decisions":
      return persistDecisions(store, workspace);
    case "persist_patterns":
      return persistPatterns(store, workspace);
  }
}

// ---------------------------------------------------------------------------
// persist_review — parse REVIEW.md → reviews.jsonl
// ---------------------------------------------------------------------------

async function persistReview(
  effect: Effect,
  store: DriftStore,
  workspace: string,
  artifacts: string[],
): Promise<EffectResult> {
  const errors: string[] = [];
  const artifactName = effect.artifact ?? "REVIEW.md";
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
  return { type: "persist_review", recorded: 1, errors };
}

export interface ParsedReview {
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
// persist_decisions — parse *-SUMMARY.md Canon Compliance → decisions.jsonl
// ---------------------------------------------------------------------------

async function persistDecisions(
  store: DriftStore,
  workspace: string,
): Promise<EffectResult> {
  const errors: string[] = [];
  let recorded = 0;
  const summaries = await findSummaryFiles(workspace);

  for (const filePath of summaries) {
    try {
      const content = await readFile(filePath, "utf-8");
      const decisions = parseDecisionsFromSummary(content, filePath);
      for (const d of decisions) {
        await store.appendDecision(d);
        recorded++;
      }
    } catch (err) {
      errors.push(`${basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { type: "persist_decisions", recorded, errors };
}

/**
 * Parse Canon Compliance section from an implementation summary.
 * Looks for JUSTIFIED_DEVIATION entries.
 */
export function parseDecisionsFromSummary(content: string, filePath: string): DecisionEntry[] {
  const decisions: DecisionEntry[] = [];
  const complianceMatch = content.match(
    /### Canon Compliance\s*\n(?:<!--.*?-->\s*\n)?((?:- .*\n)*)/,
  );
  if (!complianceMatch) return decisions;

  const lines = complianceMatch[1].trim().split("\n");
  for (const line of lines) {
    // Match: - **principle-id** (severity): ⚠ JUSTIFIED_DEVIATION — detail
    const m = line.match(
      /- \*\*([^*]+)\*\*\s*\([^)]*\):\s*⚠?\s*JUSTIFIED_DEVIATION\s*—?\s*(.*)/i,
    );
    if (m) {
      decisions.push({
        decision_id: generateId("dec"),
        timestamp: new Date().toISOString(),
        principle_id: m[1].trim(),
        file_path: filePath,
        justification: m[2].trim() || "Justified deviation (no detail provided)",
      });
    }
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// persist_patterns — parse *-SUMMARY.md for observed patterns → patterns.jsonl
// ---------------------------------------------------------------------------

async function persistPatterns(
  store: DriftStore,
  workspace: string,
): Promise<EffectResult> {
  const errors: string[] = [];
  let recorded = 0;
  const summaries = await findSummaryFiles(workspace);

  // Collect files from all summaries for pattern context
  const allFiles: string[] = [];
  const patternTexts: string[] = [];

  for (const filePath of summaries) {
    try {
      const content = await readFile(filePath, "utf-8");

      // Collect file paths from the Files table
      const filesTableMatch = content.match(
        /### Files\s*\n\|.*?\|\s*\n\|[-| ]+\|\s*\n((?:\|.*\|\s*\n)*)/,
      );
      if (filesTableMatch) {
        const rows = filesTableMatch[1].trim().split("\n");
        for (const row of rows) {
          const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
          if (cells.length >= 1) {
            const fp = cells[0].replace(/`/g, "");
            if (fp && !allFiles.includes(fp)) allFiles.push(fp);
          }
        }
      }

      // Check for Canon Compliance patterns — COMPLIANT entries that follow conventions
      const complianceMatch = content.match(
        /### Canon Compliance\s*\n(?:<!--.*?-->\s*\n)?((?:- .*\n)*)/,
      );
      if (complianceMatch) {
        const lines = complianceMatch[1].trim().split("\n");
        for (const line of lines) {
          const m = line.match(
            /- \*\*([^*]+)\*\*\s*\([^)]*\):\s*[✓✔]?\s*COMPLIANT\s*—?\s*(.*)/i,
          );
          if (m && m[2].trim()) {
            patternTexts.push(`${m[1].trim()}: ${m[2].trim()}`);
          }
        }
      }
    } catch (err) {
      errors.push(`${basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Only persist if we found meaningful patterns
  if (patternTexts.length > 0 && allFiles.length > 0) {
    const entry: PatternEntry = {
      pattern_id: generateId("pat"),
      timestamp: new Date().toISOString(),
      pattern: patternTexts.join("; "),
      file_paths: allFiles,
      context: "Extracted from implementation summaries at ship time",
    };
    await store.appendPattern(entry);
    recorded = 1;
  }

  return { type: "persist_patterns", recorded, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find *-SUMMARY.md files in workspace plans directory.
 * Scans one level of subdirectories (plans/{slug}/*-SUMMARY.md).
 */
async function findSummaryFiles(workspace: string): Promise<string[]> {
  const plansDir = join(workspace, "plans");
  const results: string[] = [];
  let subdirs: string[];
  try {
    subdirs = await readdir(plansDir);
  } catch {
    return results;
  }
  for (const sub of subdirs) {
    const subPath = join(plansDir, sub);
    let files: string[];
    try {
      files = await readdir(subPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith("-SUMMARY.md")) {
        results.push(join(subPath, f));
      }
    }
  }
  return results;
}

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
  try {
    const subdirs = await readdir(plansDir);
    for (const sub of subdirs) {
      const candidate = join(plansDir, sub, artifactName);
      try {
        return await readFile(candidate, "utf-8");
      } catch { /* continue */ }
    }
  } catch { /* plans dir doesn't exist */ }

  return null;
}
