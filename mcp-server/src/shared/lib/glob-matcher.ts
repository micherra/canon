/**
 * Linear-time glob matcher for Canon's restricted glob dialect.
 *
 * Canon supports exactly two wildcards:
 *   *  — matches any sequence of characters that does NOT include '/'.
 *   ** — matches any sequence of characters, including '/'.
 *
 * This module replaces the `new RegExp`-based glob matching in `matcher.ts`,
 * eliminating the sequential-wildcard ReDoS class. The escape-all-then-restore
 * posture in the previous `globToRegex` closed the SyntaxError throw-DoS and
 * the nested-quantifier ReDoS (e.g. `(*){2,}`), but the restored `*` wildcard
 * is itself an unbounded quantifier: a charset-valid pattern such as
 * `a*a*a*a*a*a*a*a*b` compiled to `(^|/)a[^/]*a[^/]*…b$`, which polynomially
 * backtracks. A linear-time matcher removes the RegExp engine from the match
 * path entirely (ADR-0026 §Amendment-3).
 *
 * Algorithm: O(m·n) dynamic-programming wildcard match, where m = pattern
 * length and n = path length. No `new RegExp` on the pattern at match time.
 *
 * Segment-boundary anchor: semantics replicate `(^|/)` — matches start at
 * position 0 or immediately after any '/'. Implemented by initialising all
 * segment-boundary positions to reachable in the DP initial state rather than
 * iterating over start positions (avoids O(n²·m) naive approach).
 */

/**
 * DP execution context shared by all step helpers.
 *
 * @property dp   - Flat DP array, row-major with (n+1) columns.
 * @property n    - Path length.
 * @property path - The full path string.
 */
type DpCtx = { dp: Uint8Array; n: number; path: string };

/**
 * DP step: advance `**` — matches zero or more characters including '/'.
 *
 * @param ctx  - DP execution context.
 * @param base - Offset for the current pattern row (i * (n+1)).
 * @param next - Offset for the target pattern row ((i+2) * (n+1)).
 */
function stepDoubleStar(ctx: DpCtx, base: number, next: number): void {
  const { dp, n } = ctx;
  // Zero-char match: carry all reachable positions to the next pattern row.
  for (let j = 0; j <= n; j++) {
    if (dp[base + j]) dp[next + j] = 1;
  }
  // One-more-char propagation: '**' absorbs any character.
  for (let j = 0; j < n; j++) {
    if (dp[next + j]) dp[next + j + 1] = 1;
  }
}

/**
 * DP step: advance single `*` — matches zero or more non-'/' characters.
 *
 * @param ctx  - DP execution context.
 * @param base - Offset for the current pattern row.
 * @param next - Offset for the target pattern row ((i+1) * (n+1)).
 */
function stepSingleStar(ctx: DpCtx, base: number, next: number): void {
  const { dp, n, path } = ctx;
  // Zero-char match.
  for (let j = 0; j <= n; j++) {
    if (dp[base + j]) dp[next + j] = 1;
  }
  // One-more-char propagation: only non-'/' characters.
  for (let j = 0; j < n; j++) {
    if (dp[next + j] && path[j] !== "/") dp[next + j + 1] = 1;
  }
}

/**
 * DP step: advance a literal character — matches exactly one path character.
 *
 * @param ctx  - DP execution context.
 * @param base - Offset for the current pattern row.
 * @param next - Offset for the target pattern row ((i+1) * (n+1)).
 * @param char - The literal pattern character to match.
 */
function stepLiteral(ctx: DpCtx, base: number, next: number, char: string): void {
  const { dp, n, path } = ctx;
  for (let j = 0; j < n; j++) {
    if (dp[base + j] && char === path[j]) dp[next + j + 1] = 1;
  }
}

/**
 * Returns `true` if `pattern` matches a trailing segment of `path` using
 * Canon's glob dialect (`*` = non-`/` chars; `**` = any chars).
 *
 * Semantics replicate `new RegExp(\`(^|/)${globToRegex(pattern)}$\`).test(path)`:
 * the pattern anchors to the end of the path and may start at the beginning
 * of the path or immediately after any `/`.
 *
 * @param pattern - Glob pattern (Canon dialect: `*` and `**` wildcards only).
 * @param path    - File path to test. Typically a relative POSIX path.
 * @returns `true` if the pattern matches any trailing segment of the path.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const m = pattern.length;
  const n = path.length;

  // dp[i * (n+1) + j] = 1 iff pattern[0..i) exactly matches path[start..j)
  // for some valid segment-boundary start position (0 or position after '/').
  const dp = new Uint8Array((m + 1) * (n + 1));

  // Seed: the pattern can begin matching from any segment boundary.
  dp[0] = 1; // position 0 — start of string
  for (let j = 1; j <= n; j++) {
    if (path[j - 1] === "/") dp[j] = 1; // position j — immediately after '/'
  }

  const ctx: DpCtx = { dp, n, path };

  for (let i = 0; i < m; ) {
    const is2star = pattern[i] === "*" && i + 1 < m && pattern[i + 1] === "*";
    const base = i * (n + 1);

    if (is2star) {
      stepDoubleStar(ctx, base, (i + 2) * (n + 1));
      i += 2;
    } else if (pattern[i] === "*") {
      stepSingleStar(ctx, base, (i + 1) * (n + 1));
      i += 1;
    } else {
      stepLiteral(ctx, base, (i + 1) * (n + 1), pattern[i]);
      i += 1;
    }
  }

  // Accept if the full pattern matches exactly to the end of the path.
  return dp[m * (n + 1) + n] === 1;
}
