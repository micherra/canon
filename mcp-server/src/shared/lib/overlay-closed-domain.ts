/**
 * Shared closed-domain validators for Principle scope arrays.
 *
 * Invariant: **every writer to a closed-domain field validates.**
 *
 * There are two writers to `Principle.scope.layers` / `scope.file_patterns`:
 *   1. `parser.ts` — validates at frontmatter parse time (first writer).
 *   2. `matcher.ts` `applyOverrides` — applies project-local overrides from
 *      `.canon/principle-overrides.yaml` inside `loadAllPrinciples` (second writer).
 *
 * Extracting the charset constants and filter functions here guarantees both writers
 * share ONE definition and cannot diverge. The divergence between the two writers was
 * the root cause of the second-writer bypass found in security pass 3 (ADR-0026 §amendment):
 * `isValidOverrideEntry` checked only `Array.isArray(...).every(typeof === "string")` —
 * no charset — allowing injection strings and invalid-glob patterns to bypass the
 * load-boundary invariant that `parser.ts` correctly enforced.
 *
 * Pure, leaf, no I/O. Lives in `shared/lib/` per the deep-modules convention.
 */

/**
 * Maximum allowed length for a single `file_patterns` entry.
 *
 * Bounds the `m·n` heap allocation in `matchGlob`'s O(m·n) DP table:
 * even an attacker-planted multi-MB pattern string is reduced to at most
 * 4 KB × n per match call, keeping allocation proportional and fail-safe.
 */
export const MAX_FILE_PATTERN_LENGTH = 4096;

/** scope.layers: lowercase alphanumeric, hyphen, underscore. */
export const LAYER_CHARSET = /^[a-z0-9_-]+$/;

/** Tags (principle frontmatter `tags` + `scope.tags`): same closed identifier domain as layers. */
export const TAG_CHARSET = /^[a-z0-9_-]+$/;

/**
 * scope.file_patterns: glob characters allowed in addition to alphanumerics.
 *
 * NOTE: This charset intentionally admits regex metacharacters `( ) { } , !`
 * to support legitimate glob syntax (brace-expansion, extglob).  The DoS
 * guarantee has three layers:
 *
 *   1. Throw-DoS (SyntaxError from unbalanced groups, unknown quantifiers):
 *      closed by the old globToRegex escape-all posture — no longer relevant
 *      since matchGlob (lib/glob-matcher.ts) does not call new RegExp at all.
 *
 *   2. Sequential-wildcard ReDoS (a*a*…a*b — O(n^k) in V8's backtracking
 *      engine): closed by the O(m·n) DP matcher in lib/glob-matcher.ts
 *      (ADR-0026 §Amendment-3), which removes new RegExp from the match path.
 *
 *   3. Heap-alloc bound (attacker-planted multi-MB pattern): closed by
 *      `MAX_FILE_PATTERN_LENGTH = 4096` enforced in `filterFilePatterns`
 *      (ADR-0026 §Amendment-4).  This caps `m` so the O(m·n) allocation
 *      stays proportional regardless of pattern length.
 *
 * A charset-tweak approach (dropping individual metacharacters) is the fragile
 * enumeration posture (watch_UUUUUUUU2).  The primary structural defence is
 * the vocabulary-free linear matcher; this charset guards only against
 * injection strings (spaces, colons, etc.) and unclosed bracket `[`.
 */
export const FILE_PATTERN_CHARSET = /^[A-Za-z0-9._*/{}!,()-]+$/;

/**
 * Charset-filter `scope.layers`. Drops non-matching entries fail-closed with a warn.
 *
 * Also drops entries exceeding `MAX_FILE_PATTERN_LENGTH` (a closed identifier
 * should never approach this limit; the cap is defense-in-depth).
 *
 * @param raw - Raw string array from the principle source (frontmatter or override).
 * @param source - Identifier for log messages (file path for parser; override context for matcher).
 */
export function filterLayers(raw: string[], source: string): string[] {
  return raw.filter((l) => {
    if (l.length > MAX_FILE_PATTERN_LENGTH) {
      console.warn(
        `[canon] closed-domain: scope.layers entry length ${l.length} exceeds MAX_FILE_PATTERN_LENGTH (${MAX_FILE_PATTERN_LENGTH}) — dropping (${source})`,
      );
      return false;
    }
    if (LAYER_CHARSET.test(l)) return true;
    console.warn(
      `[canon] closed-domain: scope.layers '${l}' failed charset ^[a-z0-9_-]+$ — dropping (${source})`,
    );
    return false;
  });
}

/**
 * Charset-filter `scope.file_patterns`. Drops non-matching entries fail-closed with a warn.
 *
 * Guards at two levels:
 *   1. **Length cap** (`MAX_FILE_PATTERN_LENGTH`): drops entries longer than 4096 characters,
 *      bounding the `m·n` heap allocation in `matchGlob`'s DP table regardless of pattern
 *      content (ADR-0026 §Amendment-4).
 *   2. **Charset** (`FILE_PATTERN_CHARSET`): drops injection strings (spaces, colons, shell
 *      metacharacters, unclosed `[`). Does NOT by itself prevent DoS from regex metacharacters
 *      `( ) { } , !` admitted by the charset — the DoS guarantee lives in the linear matcher.
 *
 * @param raw - Raw string array from the principle source (frontmatter or override).
 * @param source - Identifier for log messages.
 */
export function filterFilePatterns(raw: string[], source: string): string[] {
  return raw.filter((p) => {
    if (p.length > MAX_FILE_PATTERN_LENGTH) {
      console.warn(
        `[canon] closed-domain: scope.file_patterns entry length ${p.length} exceeds MAX_FILE_PATTERN_LENGTH (${MAX_FILE_PATTERN_LENGTH}) — dropping (${source})`,
      );
      return false;
    }
    if (FILE_PATTERN_CHARSET.test(p)) return true;
    console.warn(
      `[canon] closed-domain: scope.file_patterns '${p}' failed charset — dropping (${source})`,
    );
    return false;
  });
}

/**
 * Charset-filter an array of tag strings. Drops non-matching entries fail-closed with a warn.
 *
 * Also drops entries exceeding `MAX_FILE_PATTERN_LENGTH` (a closed identifier
 * should never approach this limit; the cap is defense-in-depth).
 *
 * @param raw - Raw string array from the principle source.
 * @param label - Human-readable field label for log messages (e.g. "tags", "scope.tags").
 * @param source - Identifier for log messages (file path or override context).
 */
export function filterTagArray(raw: string[], label: string, source: string): string[] {
  return raw.filter((t) => {
    if (t.length > MAX_FILE_PATTERN_LENGTH) {
      console.warn(
        `[canon] closed-domain: ${label} entry length ${t.length} exceeds MAX_FILE_PATTERN_LENGTH (${MAX_FILE_PATTERN_LENGTH}) — dropping (${source})`,
      );
      return false;
    }
    if (TAG_CHARSET.test(t)) return true;
    console.warn(
      `[canon] closed-domain: ${label} '${t}' failed charset ^[a-z0-9_-]+$ — dropping (${source})`,
    );
    return false;
  });
}
