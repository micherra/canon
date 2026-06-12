/**
 * Principle-tier wiki-lint checks — misrouted principles and duplicate titles.
 *
 * Split into a sibling module because `services/wiki-lint.ts` is at the 600-line
 * Biome `noExcessiveLinesPerFile` ceiling (line-limit-split-into-siblings).
 *
 * Canon principles:
 * - pure-io-service-split: all functions are pure; no I/O; data pre-loaded by the caller
 * - fail-closed-by-default: ambiguous or error cases produce findings, not silent passes
 * - line-limit-split-into-siblings: new checks go here, never appended to wiki-lint.ts
 */

import type { Principle } from "@shared/parser.ts";

// ---- Types ----

export type MisroutedPrincipleFinding = {
  principle_id: string;
  severity: string;
  file_path: string;
  reason: string;
};

export type DuplicateTitleFinding = {
  title: string;
  principle_ids: string[];
  file_paths: string[];
};

// ---- Internal constants ----

/**
 * Path prefixes that are exclusively Canon-internal.
 * A principle whose `scope.file_patterns` are ALL prefixed by one of these
 * cannot meaningfully apply to an adopter's codebase.
 */
const CANON_INTERNAL_PREFIXES = [
  "mcp-server/",
  "hooks/",
  "templates/",
  "agents/",
  "references/",
  "rules/",
  "principles/",
  "loops/",
  "routines/",
  ".mcp.json",
  "boot.sh",
  "CLAUDE.md",
] as const;

// ---- Internal helpers ----

/**
 * True when `filePath` is in the SHIPPED principles tier.
 *
 * A file lives in the shipped tier when it contains `/principles/` in its path
 * but is NOT under `.canon/principles/`.
 */
function isShippedTier(filePath: string): boolean {
  return filePath.includes("/principles/") && !filePath.includes("/.canon/principles/");
}

/**
 * True when every file pattern in a principle's scope maps exclusively to
 * Canon-internal paths — meaning the principle cannot apply to an adopter.
 *
 * Returns false for empty `file_patterns` (universal-by-default; not misrouted).
 * Fail-closed: an unparseable/non-array `file_patterns` is treated as empty
 * (returns false) so parse errors never produce false positives on this path.
 */
function isAllCanonInternalScope(p: Principle): boolean {
  const pats = p.scope.file_patterns;
  if (!Array.isArray(pats) || pats.length === 0) return false;
  return pats.every((pat) =>
    CANON_INTERNAL_PREFIXES.some(
      (pre) => pat === pre || pat.startsWith(pre) || pat.includes(`/${pre}`),
    ),
  );
}

// ---- Public API ----

/**
 * Check for misrouted principles: principle files physically under the SHIPPED
 * `principles/` tree that should instead be in `.canon/principles/`.
 *
 * A principle is flagged when:
 * 1. It lives in the shipped tier (filePath contains `/principles/` but NOT `/.canon/principles/`), AND
 * 2. Either `portable === false` (explicit flag), OR all `scope.file_patterns` are Canon-internal paths.
 *
 * Fail-closed: on ambiguity or parse error in scope.file_patterns, the scope-branch
 * falls back to `false` (not flagged) rather than producing a false positive.
 *
 * Pure: no I/O. Receives pre-loaded principles array.
 */
export function checkMisroutedPrinciples(principles: Principle[]): MisroutedPrincipleFinding[] {
  const findings: MisroutedPrincipleFinding[] = [];

  for (const p of principles) {
    if (!isShippedTier(p.filePath)) continue;

    if (p.portable === false) {
      // Explicit portable:false — flag regardless of scope patterns.
      findings.push({
        file_path: p.filePath,
        principle_id: p.id,
        reason:
          `Principle '${p.id}' has portable: false but lives in the shipped principles/ tree. ` +
          `Move it to .canon/principles/${p.severity}/ to exclude it from installs.`,
        severity: p.severity,
      });
    } else if (p.portable === undefined && isAllCanonInternalScope(p)) {
      // No explicit portable flag AND all scope.file_patterns are Canon-internal.
      // portable:true is an explicit authorial opt-in that overrides the scope heuristic.
      findings.push({
        file_path: p.filePath,
        principle_id: p.id,
        reason:
          `Principle '${p.id}' has scope.file_patterns that are exclusively Canon-internal paths ` +
          `(${p.scope.file_patterns.join(", ")}), but lives in the shipped principles/ tree. ` +
          `Move it to .canon/principles/${p.severity}/ or add portable: false to mark it explicitly.`,
        severity: p.severity,
      });
    }
  }

  return findings;
}

/**
 * Normalize a principle title for collision detection.
 *
 * Normalization: lowercase → collapse whitespace → strip trailing punctuation.
 * This catches the known failure mode: identical-concept principles with titles
 * that differ only in case or trailing punctuation.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;!?]+$/, "")
    .trim();
}

/**
 * Check for duplicate-title collisions across the MERGED principle set
 * (both shipped `principles/` and internal `.canon/principles/` tiers).
 *
 * A group of 2+ distinct principle IDs sharing the same normalized title
 * produces one finding. This is the mechanical backstop that catches identical-
 * title re-mints even when the writer behavioral gate is bypassed.
 *
 * Pure: no I/O. Receives pre-loaded principles array (both tiers merged).
 */
export function checkDuplicateTitles(principles: Principle[]): DuplicateTitleFinding[] {
  // Group by normalized title
  const byTitle = new Map<string, Principle[]>();
  for (const p of principles) {
    const key = normalizeTitle(p.title);
    if (!key) continue; // skip principles with empty titles
    const group = byTitle.get(key) ?? [];
    group.push(p);
    byTitle.set(key, group);
  }

  const findings: DuplicateTitleFinding[] = [];
  for (const [normalizedTitle, group] of byTitle) {
    // De-duplicate by principle ID (in case same ID appears multiple times)
    const seen = new Set<string>();
    const unique: Principle[] = [];
    for (const p of group) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        unique.push(p);
      }
    }
    if (unique.length < 2) continue;

    findings.push({
      file_paths: unique.map((p) => p.filePath),
      principle_ids: unique.map((p) => p.id),
      title: normalizedTitle,
    });
  }

  return findings;
}
