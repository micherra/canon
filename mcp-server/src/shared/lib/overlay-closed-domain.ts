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

/** scope.layers: lowercase alphanumeric, hyphen, underscore. */
export const LAYER_CHARSET = /^[a-z0-9_-]+$/;

/** Tags (principle frontmatter `tags` + `scope.tags`): same closed identifier domain as layers. */
export const TAG_CHARSET = /^[a-z0-9_-]+$/;

/**
 * scope.file_patterns: glob characters allowed in addition to alphanumerics.
 * This charset also acts as a DoS guard — patterns outside it are dropped
 * before `globToRegex` / `new RegExp()` sees them, preventing `SyntaxError`
 * propagation from malformed character classes (e.g. unclosed `[`).
 */
export const FILE_PATTERN_CHARSET = /^[A-Za-z0-9._*/{}!,()-]+$/;

/**
 * Charset-filter `scope.layers`. Drops non-matching entries fail-closed with a warn.
 *
 * @param raw - Raw string array from the principle source (frontmatter or override).
 * @param source - Identifier for log messages (file path for parser; override context for matcher).
 */
export function filterLayers(raw: string[], source: string): string[] {
  return raw.filter((l) => {
    if (LAYER_CHARSET.test(l)) return true;
    console.warn(
      `[canon] closed-domain: scope.layers '${l}' failed charset ^[a-z0-9_-]+$ — dropping (${source})`,
    );
    return false;
  });
}

/**
 * Charset-filter `scope.file_patterns`. Drops non-matching entries fail-closed with a warn.
 * Dropping invalid patterns here also prevents the invalid-glob DoS — patterns with
 * characters outside the charset (e.g. unclosed `[`) are removed before `globToRegex`
 * / `new RegExp()` can throw a `SyntaxError`.
 *
 * @param raw - Raw string array from the principle source (frontmatter or override).
 * @param source - Identifier for log messages.
 */
export function filterFilePatterns(raw: string[], source: string): string[] {
  return raw.filter((p) => {
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
 * @param raw - Raw string array from the principle source.
 * @param label - Human-readable field label for log messages (e.g. "tags", "scope.tags").
 * @param source - Identifier for log messages (file path or override context).
 */
export function filterTagArray(raw: string[], label: string, source: string): string[] {
  return raw.filter((t) => {
    if (TAG_CHARSET.test(t)) return true;
    console.warn(
      `[canon] closed-domain: ${label} '${t}' failed charset ^[a-z0-9_-]+$ — dropping (${source})`,
    );
    return false;
  });
}
