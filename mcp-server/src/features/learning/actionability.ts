/**
 * Shared actionability classifier for the learning-resolution flow (ADR-0048,
 * decision `informational-separation-at-surface`).
 *
 * The single canonical `(type, filename-prefix) -> actionable | informational`
 * mapping consumed by both `/canon:review-learnings` and the `reconcile_learnings`
 * MCP tool. Reads both frontmatter formats the proposal corpus uses (see
 * PROBE-FINDINGS P5): YAML `type: X` and legacy bold `**Type**: X`.
 *
 * Pure — no I/O. Callers own reading the proposal file from disk.
 */

/** Whether a proposal represents live backlog work or passive tracking noise. */
export type Actionability = "actionable" | "informational";

/** Result of classifying one proposal. */
export type ClassificationResult = {
  actionability: Actionability;
  reason: string;
};

/**
 * Frontmatter `type` values that represent genuine actionable backlog work.
 * Allowlist, not a denylist (PROBE-FINDINGS P5): the learner's type vocabulary
 * has sprawled past what the analyze-patterns template sanctions, so a
 * positive list of known-actionable types is more robust than trying to name
 * every informational variant.
 */
export const ACTIONABLE_TYPES = [
  "new-convention",
  "severity-change",
  "principle-revision",
  "convention-graduation",
  "stale-removal",
  "evolution-candidate",
  "prune-candidate",
  "convention-promotion",
  "convention-promotion-candidate",
  "convention-candidate",
  "new-convention-candidate",
  "new-principle-candidate",
  "new-agent-rule",
  "suggest-convention",
  "suggest-fix",
  "suggest-rule-clarification",
  "convention-scope-amendment",
  "convention-addendum-candidate",
  "revise",
  "enforce-principle",
] as const;

/**
 * Frontmatter `type` values that represent passive tracking/observation
 * artifacts — never eligible for Accept/Reject or auto-reconcile. Includes
 * every type AC#2 names by name, plus the observed tracking-family sprawl.
 */
export const INFORMATIONAL_TYPES = [
  "watch",
  "note",
  "observation",
  "reference-note",
  "post-promotion-confirmation",
  "watch-negative-confirming-instance",
  "dead-code-watch",
  "prune-watch",
  "convention-watch",
  "new-watch",
  "suggest-watch",
  "watch-followup",
  "confirming-instance",
  "negative-observation",
  "applied-observation",
  "process-observation",
  "architecture-observation",
  "scope-observation",
  "resolution-record",
  "resolution",
  "tracking",
  "monitoring-note",
  "reinforcement",
  "positive-signal",
] as const;

const ACTIONABLE_TYPE_SET: ReadonlySet<string> = new Set(ACTIONABLE_TYPES);
const INFORMATIONAL_TYPE_SET: ReadonlySet<string> = new Set(INFORMATIONAL_TYPES);

/** A `type` value resolved from either frontmatter format, or none found. */
type ResolvedType = { found: true; value: string; format: "yaml" | "bold" } | { found: false };

/** Extracts `type: X` (quoted or unquoted) from a YAML frontmatter block. */
function extractYamlType(text: string): ResolvedType {
  const match = text.match(/^type:\s*["']?([^"'\n]+?)["']?\s*$/m);
  if (!match) return { found: false };
  return { format: "yaml", found: true, value: match[1].trim() };
}

/** Extracts `**Type**: X` from a legacy bold pseudo-frontmatter block. */
function extractBoldType(text: string): ResolvedType {
  const match = text.match(/\*\*Type\*\*:\s*([^\n]+)/i);
  if (!match) return { found: false };
  return { format: "bold", found: true, value: match[1].trim() };
}

/**
 * Resolves the declared `type` from either frontmatter format. YAML `type:`
 * takes priority over a legacy bold `**Type**:` line when both are present
 * (the modern format is authoritative when a file carries both).
 */
function resolveDeclaredType(frontmatter: string): ResolvedType {
  const yaml = extractYamlType(frontmatter);
  if (yaml.found) return yaml;
  return extractBoldType(frontmatter);
}

/** Filename prefixes that signal actionability when no `type` field resolves. */
function classifyByPrefix(filename: string): Actionability | null {
  if (filename.startsWith("sug_") || filename.startsWith("convention_")) return "actionable";
  if (filename.startsWith("watch_") || filename.startsWith("note_")) return "informational";
  return null;
}

/**
 * Classifies a proposal as actionable or informational.
 *
 * Decision order (decision `informational-separation-at-surface`):
 * 1. Declared `type` resolves to a known actionable type -> actionable.
 * 2. Declared `type` resolves to a known informational type -> informational.
 * 3. No recognized `type` -> filename-prefix fallback (`sug_`/`convention_` ->
 *    actionable, `watch_`/`note_` -> informational).
 * 4. No signal at all -> informational (conservative default — an
 *    unclassified item is never Accept/Reject-prompted).
 */
export function classifyProposal(input: {
  filename: string;
  frontmatter: string;
}): ClassificationResult {
  const { filename, frontmatter } = input;
  const declaredType = resolveDeclaredType(frontmatter);

  if (declaredType.found) {
    const { value, format } = declaredType;
    if (ACTIONABLE_TYPE_SET.has(value)) {
      return { actionability: "actionable", reason: `type=${value} (${format}) is actionable` };
    }
    if (INFORMATIONAL_TYPE_SET.has(value)) {
      return {
        actionability: "informational",
        reason: `type=${value} (${format}) is informational`,
      };
    }
  }

  const byPrefix = classifyByPrefix(filename);
  if (byPrefix !== null) {
    const typeNote = declaredType.found ? ` (unrecognized type=${declaredType.value})` : "";
    return {
      actionability: byPrefix,
      reason: `filename prefix fallback${typeNote}`,
    };
  }

  return {
    actionability: "informational",
    reason: "no type signal and no recognized filename prefix — conservative default",
  };
}
