/**
 * Fail-closed overlay injection scanner.
 *
 * Evaluates project-local overlay text (principle bodies, correction records,
 * routine bodies, override files) before it reaches agent context. Three
 * gates are applied in order — the first DENY wins:
 *
 *  1. Bounds         — rejects content whose serialized UTF-8 size exceeds the
 *                      configured limit (default 16 KiB).
 *  2. Normalizability — default-deny: rejects any character that cannot pass
 *                      safe Unicode normalization. This gate is vocabulary-free
 *                      and structural; it catches obfuscated payloads
 *                      (zero-width, bidi overrides, lone surrogates, C0
 *                      control) WITHOUT any token matching.
 *  3. Injection sig. — secondary structural check for a small set of explicit
 *                      prompt-control patterns (role reassignment, mcp__ tool
 *                      directives, instruction-override phrases). NOT an
 *                      enumerated bad-word list; the load-bearing default-deny
 *                      lives in gates 1-2.
 *
 * ADR-0023 / decision phase0-01.
 */

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type OverlayScanResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      signal: "over-threshold" | "non-normalizable" | "injection-signature";
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 16_384;

// ---------------------------------------------------------------------------
// Gate 2 — Normalizability patterns (vocabulary-free, default-deny)
// ---------------------------------------------------------------------------

/**
 * Scan for C0 control characters EXCEPT the three permitted whitespace chars:
 *   tab (U+0009), LF (U+000A), CR (U+000D).
 *
 * Implemented as a charCodeAt scan rather than a regex literal to comply with
 * biome's `noControlCharactersInRegex` rule, which disallows embedding
 * control-character code points (U+0000-U+001F) in regex literals even as
 * escape sequences.
 *
 * Rejected code points:
 *   U+0000-U+0008  NUL through BS
 *   U+000B         VT
 *   U+000C         FF
 *   U+000E-U+001F  SO through US
 */
function hasDisallowedC0Char(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Reject U+0000-U+001F except \t (9), \n (10), \r (13)
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/**
 * Unicode bidirectional override characters that can visually hide injected
 * content by reversing or reordering text rendering:
 *   U+202A LEFT-TO-RIGHT EMBEDDING
 *   U+202B RIGHT-TO-LEFT EMBEDDING
 *   U+202C POP DIRECTIONAL FORMATTING
 *   U+202D LEFT-TO-RIGHT OVERRIDE
 *   U+202E RIGHT-TO-LEFT OVERRIDE
 *   U+2066 LEFT-TO-RIGHT ISOLATE
 *   U+2067 RIGHT-TO-LEFT ISOLATE
 *   U+2068 FIRST STRONG ISOLATE
 *   U+2069 POP DIRECTIONAL ISOLATE
 */
const BIDI_OVERRIDE = /[‪-‮⁦-⁩]/;

/**
 * Zero-width characters used in invisible steganographic payloads:
 *   U+200B ZERO WIDTH SPACE
 *   U+200C ZERO WIDTH NON-JOINER
 *   U+200D ZERO WIDTH JOINER
 *   U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)
 */
const ZERO_WIDTH = /[​-‍﻿]/;

/**
 * Lone surrogate code units — either:
 *   - a high surrogate (U+D800-U+DBFF) NOT followed by a low surrogate
 *   - a low surrogate (U+DC00-U+DFFF) NOT preceded by a high surrogate
 *
 * Lone surrogates are not valid Unicode scalar values and must be rejected.
 * Node.js 24+ supports lookbehind assertions, which this project requires.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------------------------------------------------------------------
// Gate 3 — Injection signature patterns (structural, not a token blocklist)
// ---------------------------------------------------------------------------

/**
 * Role-reassignment line: a line that STARTS with system:, assistant:, or
 * developer: (case-sensitive, with optional leading whitespace and an optional
 * space before the colon).
 *
 * Matches prompt-injection payloads that attempt to reset the agent's role.
 * Does NOT match "System:" (capital S), inline occurrences mid-sentence, or
 * code comments — only line-initial occurrences.
 */
const ROLE_REASSIGNMENT = /^\s*(system|assistant|developer)\s*:/m;

/**
 * MCP tool-invocation directive: any occurrence of the "mcp__" prefix, which
 * is the canonical namespace for Canon MCP tools. Content that explicitly
 * references "mcp__" is attempting to call a tool directly.
 */
const MCP_TOOL_INVOCATION = /mcp__/;

/**
 * Instruction-override phrase: the combination of an override verb
 * (ignore/disregard/override) within 40 characters of an overridable target
 * (previous/prior/above/system). Case-insensitive.
 *
 * Kept at a structurally narrow scope (<=40 chars, \b word-boundary, specific
 * verb/target vocabulary) to avoid false positives on benign uses of individual
 * words (e.g. "override the timeout").
 */
const INSTRUCTION_OVERRIDE =
  /\b(ignore|disregard|override)\b[^\n]{0,40}\b(previous|prior|above|system)\b/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a text string for overlay injection risk.
 *
 * Returns `{ ok: true }` when the text passes all gates.
 * Returns `{ ok: false, reason, signal }` on the FIRST gate failure.
 *
 * @param text    - The overlay content string to evaluate.
 * @param opts    - Optional tuning: `maxBytes` overrides the default 16 KiB
 *                  size limit.
 */
export function scanOverlayContent(text: string, opts?: { maxBytes?: number }): OverlayScanResult {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  // Gate 1: Bounds
  if (Buffer.byteLength(text, "utf-8") > maxBytes) {
    return {
      ok: false,
      reason: `content exceeds size limit (${maxBytes} bytes)`,
      signal: "over-threshold",
    };
  }

  // Gate 2: Normalizability (vocabulary-free default-deny)
  if (hasDisallowedC0Char(text)) {
    return {
      ok: false,
      reason: "contains disallowed C0 control characters",
      signal: "non-normalizable",
    };
  }
  if (BIDI_OVERRIDE.test(text)) {
    return {
      ok: false,
      reason: "contains Unicode bidirectional override characters",
      signal: "non-normalizable",
    };
  }
  if (ZERO_WIDTH.test(text)) {
    return {
      ok: false,
      reason: "contains zero-width characters",
      signal: "non-normalizable",
    };
  }
  if (LONE_SURROGATE.test(text)) {
    return {
      ok: false,
      reason: "contains lone Unicode surrogate code unit",
      signal: "non-normalizable",
    };
  }

  // Gate 3: Injection signatures (structural, NOT a token blocklist)
  if (ROLE_REASSIGNMENT.test(text)) {
    return {
      ok: false,
      reason: "contains role-reassignment directive",
      signal: "injection-signature",
    };
  }
  if (MCP_TOOL_INVOCATION.test(text)) {
    return {
      ok: false,
      reason: "contains mcp__ tool-invocation directive",
      signal: "injection-signature",
    };
  }
  if (INSTRUCTION_OVERRIDE.test(text)) {
    return {
      ok: false,
      reason: "contains instruction-override phrase",
      signal: "injection-signature",
    };
  }

  return { ok: true };
}
