/**
 * Stage 10 — Unresolved variable validation.
 *
 * Scans all assembled prompts for ${...} patterns that are not in the
 * PIPELINE_ALLOWED_VARIABLES allowlist. Each unresolved pattern is added
 * to ctx.warnings as an "ERROR:" prefixed string.
 *
 * Prompts are still returned — the caller decides whether to proceed or abort
 * based on the presence of ERROR: warnings. This honors fail-closed-by-default
 * while allowing the orchestrator to make the final decision.
 */

import { RUNTIME_VARIABLES } from "../../orchestration/flow-parser.ts";
import type { PromptContext } from "./types.ts";

/**
 * Extended allowlist of variables that are valid at pipeline time.
 *
 * This is a superset of RUNTIME_VARIABLES from flow-parser.ts, adding
 * variables that are either:
 * (a) populated by the pipeline stages themselves (e.g., messages, enrichment)
 * (b) runtime variables not yet in the RUNTIME_VARIABLES set
 * (c) dynamic patterns that cannot be enumerated (item.* prefix)
 *
 * Maintaining this list is the cost of the warning-based approach — each new
 * variable added to any flow must be added here to avoid false positives.
 */
export const PIPELINE_ALLOWED_VARIABLES: Set<string> = new Set([
  ...RUNTIME_VARIABLES,
  // New variables populated by pipeline stages
  "handoff_context",    // Handoff file content injected by injectHandoffs stage
  "enrichment",         // Spawn enrichment context injection
  // Additional runtime variables not in RUNTIME_VARIABLES
  "item",          // Exact ${item} (covered by item.* pattern too, but be explicit)
  "review_scope",  // Review scope filter
  "open_questions",// Consultation open questions
  "directory",     // Adopt flow directory
  "severity_filter",// Adopt flow severity filter
  "top_n",         // Adopt flow top N
  "user_write_tests",// Verify flow
  "write_tests",   // Verify flow
]);

/**
 * Returns true when a variable name is in the allowlist.
 *
 * Special case: any name starting with "item." is allowed (item.* pattern).
 * This supports ${item.field}, ${item.principle_id}, ${item.my_custom_field}, etc.
 */
function isAllowed(name: string): boolean {
  if (PIPELINE_ALLOWED_VARIABLES.has(name)) return true;
  if (name.startsWith("item.")) return true;
  return false;
}

/**
 * Stage 10: Validate assembled prompts for unresolved variable references.
 *
 * Scans ctx.prompts[].prompt (or ctx.basePrompt when prompts is empty).
 * For each ${...} pattern not in the allowlist, appends an ERROR: warning.
 * Escaped \\${...} patterns (preceded by backslash) are skipped.
 *
 * Returns a new ctx with error warnings appended — does not modify prompts.
 */
export async function validatePrompts(ctx: PromptContext): Promise<PromptContext> {
  const stateId = ctx.input.state_id;
  const errorWarnings: string[] = [];

  // Determine which texts to scan
  const textsToScan: string[] = ctx.prompts.length > 0
    ? ctx.prompts.map((p) => p.prompt)
    : ctx.basePrompt
    ? [ctx.basePrompt]
    : [];

  for (const text of textsToScan) {
    scanForUnresolved(text, stateId, errorWarnings);
  }

  if (errorWarnings.length === 0) {
    return ctx;
  }

  return {
    ...ctx,
    warnings: [...ctx.warnings, ...errorWarnings],
  };
}

/**
 * Scan text for unresolved ${...} patterns and push ERROR warnings.
 *
 * Skips patterns that are preceded by a backslash (escaped).
 */
function scanForUnresolved(text: string, stateId: string, out: string[]): void {
  // Match ${...} patterns — use a regex that captures the variable name
  // We need to check the character before the match to detect escaping
  const pattern = /\$\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const varName = match[1];
    const matchStart = match.index;

    // Skip escaped patterns — character before ${ is a backslash
    if (matchStart > 0 && text[matchStart - 1] === "\\") {
      continue;
    }

    // Skip allowed/known variables
    if (isAllowed(varName)) {
      continue;
    }

    out.push(
      `ERROR: unresolved variable \${${varName}} in prompt for state "${stateId}"`,
    );
  }
}
