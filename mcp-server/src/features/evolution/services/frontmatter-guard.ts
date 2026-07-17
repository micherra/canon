/**
 * frontmatter-guard.ts — pure runtime frontmatter-immutability guard (TASK-003, ADR-0031
 * amendment). Sibling pre-eval check to `checkScriptReachable` in evaluate-candidate.ts.
 *
 * Enforces AC#6 at mutation-RUNTIME (complements the provenance-layer section-span
 * exclusion in context-provenance.ts): a candidate that edits an agent-def's frontmatter
 * (name/tools/model or any matcher-load-bearing field) is rejected before any subprocess.
 *
 * Fail-closed: unparseable frontmatter on either side is treated as unsafe, never throws.
 * Pure, no I/O.
 */

import { splitFrontmatter } from "@shared/lib/frontmatter.ts";

export type FrontmatterGuardResult =
  | { ok: true }
  | { ok: false; reason: "frontmatter_modified" | "frontmatter_unverifiable"; fields?: string[] };

/**
 * Compares the RAW frontmatter block (the `---\n...\n---` fence, byte-for-byte) of two
 * markdown texts. Raw-block comparison — not semantic-data comparison — so key reordering
 * and whitespace changes are also caught, matching "never mutate frontmatter."
 *
 * @returns `{ ok: true }` when the raw frontmatter blocks are byte-identical (or both
 *   absent). `{ ok: false, reason: "frontmatter_modified", fields }` when they differ —
 *   `fields` lists the top-level YAML keys whose value changed (best-effort diagnostic,
 *   not the basis of the comparison itself). `{ ok: false, reason: "frontmatter_unverifiable" }`
 *   when either side fails to parse (fail-closed — a candidate we cannot prove is
 *   frontmatter-safe is treated as unsafe). Never throws.
 */
export function checkFrontmatterImmutable(
  baselineText: string,
  candidateText: string,
): FrontmatterGuardResult {
  let baselineBlock: string;
  let candidateBlock: string;
  let baselineData: Record<string, unknown>;
  let candidateData: Record<string, unknown>;

  try {
    const baselineSplit = splitFrontmatter(baselineText);
    baselineBlock = baselineText.slice(0, baselineText.length - baselineSplit.body.length);
    baselineData = baselineSplit.data;

    const candidateSplit = splitFrontmatter(candidateText);
    candidateBlock = candidateText.slice(0, candidateText.length - candidateSplit.body.length);
    candidateData = candidateSplit.data;
  } catch {
    // splitFrontmatter throws on malformed YAML — a candidate we cannot verify is unsafe.
    return { ok: false, reason: "frontmatter_unverifiable" };
  }

  if (baselineBlock === candidateBlock) {
    return { ok: true };
  }

  return {
    fields: diffFrontmatterFields(baselineData, candidateData),
    ok: false,
    reason: "frontmatter_modified",
  };
}

/**
 * checkPrincipleFrontmatterImmutable — principle-wording frontmatter guard.
 *
 * A principle-wording REWRITE candidate is body-only by contract (mirrors the
 * agent-def posture above). But ADR-0052's retirement track (`proposal_kind: "retire"`)
 * legitimately mutates ONE field — `archived: true` — the sole loader-honored retirement
 * flag (`write-principle`'s `--archive` mode; `shared/matcher.ts` excludes
 * `archived: true` principles from every review/get_principles/review_code call).
 * `evaluate_candidate` has no `proposal_kind` input to distinguish a rewrite candidate
 * from a retire candidate, so this guard tolerates `archived` uniformly for every
 * `principles/`-first-segment target: every OTHER top-level field (id/severity/scope/
 * tags/etc.) must stay byte-identical, but a change isolated to `archived` passes.
 *
 * Field-level (not raw-block) comparison — unlike `checkFrontmatterImmutable`'s
 * byte-for-byte block compare — because the one sanctioned mutation must be excludable.
 * Fail-closed on unparseable YAML, same as `checkFrontmatterImmutable`. Never throws.
 */
export function checkPrincipleFrontmatterImmutable(
  baselineText: string,
  candidateText: string,
): FrontmatterGuardResult {
  let baselineData: Record<string, unknown>;
  let candidateData: Record<string, unknown>;

  try {
    baselineData = splitFrontmatter(baselineText).data;
    candidateData = splitFrontmatter(candidateText).data;
  } catch {
    return { ok: false, reason: "frontmatter_unverifiable" };
  }

  const changed = diffFrontmatterFields(baselineData, candidateData).filter(
    (field) => field !== "archived",
  );
  if (changed.length === 0) {
    return { ok: true };
  }

  return { fields: changed, ok: false, reason: "frontmatter_modified" };
}

/** Best-effort diagnostic: top-level YAML keys whose value differs. Never the sole basis of the guard. */
function diffFrontmatterFields(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(candidate)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(baseline[key]) !== JSON.stringify(candidate[key])) {
      changed.push(key);
    }
  }
  return changed.sort();
}
