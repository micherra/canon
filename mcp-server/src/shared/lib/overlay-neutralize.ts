/**
 * Layer 1 — overlay content neutralization.
 *
 * Removes all Unicode control/format/surrogate/private-use characters and the
 * explicit Tag block (U+E0000–U+E007F) from untrusted overlay text before it
 * can reach an instruction-position context.
 *
 * Design decision (inert-01): property-class regexes are closed and complete —
 * no enumerated codepoint blocklist. Every character in the dangerous categories
 * is matched structurally; adding a new Unicode assignment does NOT require a
 * code change. The explicit Tag-range escape is belt-and-suspenders for the
 * unassigned/Cn tag codepoints (e.g. U+E0000) that fall outside \p{Cf}.
 *
 * Standard whitespace (\t U+0009, \n U+000A, \r U+000D) is technically Cc but
 * is preserved because it carries legitimate document structure. The replacement
 * callback handles this carve-out without enumerating any hex codepoints of
 * "dangerous" characters — the regex still uses property classes exclusively.
 */

// Single pass: Cc + Cf + Cs + Co + explicit Tag block U+E0000-U+E007F.
// u flag required for \p{...} property escapes and \u{...} hex escapes.
// The belt-and-suspenders Tag range covers Cn (unassigned) stragglers at
// U+E0000 that some Unicode versions do not assign to \p{Cf}.
const DANGEROUS_UNICODE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u{E0000}-\u{E007F}]/gu;

/**
 * Neutralize untrusted overlay text.
 *
 * 1. NFC-normalizes the string (canonical decomposition + composition).
 * 2. Strips every Cc/Cf/Cs/Co character and the Tag block U+E0000–U+E007F,
 *    with the sole exception of TAB (\t), LF (\n), and CR (\r) — these carry
 *    legitimate document structure and must not be stripped.
 *
 * Pure, total, throw-free. Always returns a string.
 */
export function neutralizeOverlayText(s: string): string {
  const nfc = s.normalize("NFC");
  return nfc.replace(DANGEROUS_UNICODE, (char) => {
    // Preserve standard whitespace control chars (\t, \n, \r).
    // All other matched chars (Cc minus these three, Cf, Cs, Co, Tag block) → removed.
    if (char === "\t" || char === "\n" || char === "\r") return char;
    return "";
  });
}
