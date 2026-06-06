/**
 * Section E parity test — canonical source vs inline test copy.
 *
 * DESIGN-SYSTEM.md Section E is the single canonical home for escapeHtml and markdownToHtml
 * (ui/snippets/.claude/CLAUDE.md invariant). markdown-to-html.test.ts keeps an inline
 * TypeScript copy because the function body contains /^```/ (triple-backtick regex) which
 * confuses naive fence-end detection — see lines 11–17 of that file.
 *
 * This test mechanically enforces parity: it extracts each function via the PARITY:*
 * sentinel markers (immune to the inner triple-backtick), applies a documented, fixed set
 * of TS→JS normalizations, and asserts equality. If either copy drifts beyond those
 * normalizations, the test fails.
 *
 * Extraction protocol:
 *   - DESIGN-SYSTEM.md: HTML-comment sentinels (<!-- PARITY:X:BEGIN/END -->)
 *   - markdown-to-html.test.ts: line-comment sentinels (// PARITY:X:BEGIN/END)
 *   - After slicing the markdown source, strip only edge fence lines:
 *     drop first line if it starts with ``` and last line if it starts with ```.
 *     Do NOT scan for fence ends anywhere else — the function body contains /^```/
 *     which would cause false matches.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Path resolution ───────────────────────────────────────────────────────────

const DESIGN_SYSTEM_PATH = resolve(__dirname, "../DESIGN-SYSTEM.md");
const TEST_COPY_PATH = resolve(__dirname, "./markdown-to-html.test.ts");

// ── Extraction helpers ────────────────────────────────────────────────────────

/**
 * Extract the text between two sentinel marker lines.
 * Throws (failing the test) with a clear message if either marker is missing or duplicated.
 */
function extractBetween(source: string, beginMarker: string, endMarker: string): string {
  const lines = source.split("\n");

  const beginIndices = lines
    .map((l, i) => (l.includes(beginMarker) ? i : -1))
    .filter((i) => i !== -1);
  const endIndices = lines.map((l, i) => (l.includes(endMarker) ? i : -1)).filter((i) => i !== -1);

  if (beginIndices.length === 0) {
    throw new Error(`Sentinel not found: ${beginMarker}`);
  }
  if (beginIndices.length > 1) {
    throw new Error(`Sentinel duplicated (found ${beginIndices.length}x): ${beginMarker}`);
  }
  if (endIndices.length === 0) {
    throw new Error(`Sentinel not found: ${endMarker}`);
  }
  if (endIndices.length > 1) {
    throw new Error(`Sentinel duplicated (found ${endIndices.length}x): ${endMarker}`);
  }

  const beginIdx = beginIndices[0];
  const endIdx = endIndices[0];
  if (endIdx <= beginIdx) {
    throw new Error(
      `END sentinel (line ${endIdx}) must come after BEGIN sentinel (line ${beginIdx}) for marker: ${beginMarker}`,
    );
  }

  // Slice between the marker lines (exclusive of the marker lines themselves)
  return lines.slice(beginIdx + 1, endIdx).join("\n");
}

/**
 * For the markdown source: after slicing via sentinels, strip only the edge fence lines.
 * Drop the first line if it starts with ``` and the last line if it starts with ```.
 * Do NOT scan for fence ends anywhere else (the function body contains /^```/).
 */
function stripEdgeFences(src: string): string {
  const lines = src.split("\n");
  let start = 0;
  let end = lines.length;
  if (lines[0]?.startsWith("```")) {
    start = 1;
  }
  if (lines[end - 1]?.startsWith("```")) {
    end = end - 1;
  }
  return lines.slice(start, end).join("\n");
}

/**
 * Apply a documented, fixed set of normalizations so that the canonical JS source
 * and the TypeScript test copy can be compared without false-positive mismatches.
 *
 * Each step is labelled "the documented TS normalization" and must not be extended —
 * anything outside this list that causes a mismatch is a real drift to fix.
 *
 * Steps (applied in order):
 * 1. Strip TS type annotations — longest-first to avoid partial matches.
 *    Only matched when followed by ), , space=, ;, or space{ to avoid eating string
 *    contents. Regex: /:\s*(string\[\]\[\]|string\[\]|unknown|string|number|boolean)(?=[\s),;=])/g
 * 2. Strip Number() array-index cast — the documented TS normalization for the
 *    `codeSpans[Number(i)]` pattern in the test copy (TypeScript requires explicit
 *    number cast for string-typed capture groups; the canonical JS omits it).
 * 3. Strip block comments (JSDoc headers present in canonical but not in test copy).
 * 4. Strip line comments (single-line // comments).
 * 5. Prettier formatting normalization — collapse all whitespace runs to a single
 *    space, then strip trailing commas before closing delimiters, then normalize
 *    arrow-function single-param parens and regex-hyphen escaping. These handle
 *    Biome/Prettier style choices that differ from the compact canonical JS style.
 * 6. Drop blank lines; trim trailing whitespace per line.
 */
function normalizeForParity(src: string): string {
  let s = src;

  // Step 1 — the documented TS normalization: strip type annotations, longest-first
  s = s.replace(/:\s*(string\[\]\[\]|string\[\]|unknown|string|number|boolean)(?=[\s),;=])/g, "");

  // Step 2 — the documented TS normalization: strip Number() array-index cast
  // Converts codeSpans[Number(i)] → codeSpans[i] (only the indexing pattern)
  s = s.replace(/\[Number\((\w+)\)\]/g, "[$1]");

  // Step 3 — the documented TS normalization: strip block comments (JSDoc)
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");

  // Step 4 — the documented TS normalization: strip line comments
  s = s.replace(/^\s*\/\/.*$/gm, "");

  // Step 5 — the documented TS normalization: Prettier formatting
  // Collapse all whitespace sequences (including newlines) to a single space so that
  // multi-line Biome-formatted blocks are equivalent to compact single-line JS style.
  s = s.replace(/\s+/g, " ").trim();
  // Strip trailing commas before closing delimiters (Biome adds these; canonical omits)
  s = s.replace(/,\s*([)\]])/g, "$1");
  // Normalize single-param arrow functions: (x) => → x => (Biome adds parens; canonical omits)
  s = s.replace(/\((\w+)\)\s*=>/g, "$1 =>");
  // Normalize method-chain spacing: ` .method(` → `.method(` — the canonical uses
  // multi-line method chaining (`.map\n.join`) that after whitespace collapse produces
  // ` .map` / ` .join` with a leading space, while Biome formats them inline (.map.join).
  s = s.replace(/ \./g, ".");
  // Normalize single-expression call spacing: when a function call argument ends with
  // ` )` (space before closing paren), treat it equivalently to `)`. This occurs when
  // the canonical has `out.push(\n  \`...\`\n);` → `out.push( \`...\` );` while the
  // Biome-formatted test copy has `out.push(\n  \`...\`,\n);` → after trailing-comma
  // removal → `out.push( \`...\`);`. The canonical retains the space from collapsing
  // the closing-paren line; the trailing-comma path does not.
  s = s.replace(/ \)/g, ")");
  // Normalize regex hyphen: \- inside character classes is equivalent to - (unescaped)
  // Both forms are semantically identical; canonical uses \- and Biome may rewrite to -.
  s = s.replace(/\[([^\]]*?)\\-([^\]]*?)\]/g, "[$1-$2]");

  // Step 6 — the documented TS normalization: collapse blank lines, trim trailing whitespace
  // (After whitespace collapse, this is a no-op for blank lines, but kept for clarity)
  s = s
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");

  return s;
}

// ── Read source files once ────────────────────────────────────────────────────

const designSystemSource = readFileSync(DESIGN_SYSTEM_PATH, "utf8");
const testCopySource = readFileSync(TEST_COPY_PATH, "utf8");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Section E parity — canonical DESIGN-SYSTEM.md vs inline test copy", () => {
  describe("escapeHtml parity", () => {
    it("canonical source and test copy normalize to the same code", () => {
      // Extract from DESIGN-SYSTEM.md via HTML-comment sentinels, then strip edge fences
      const canonicalRaw = extractBetween(
        designSystemSource,
        "PARITY:escapeHtml:BEGIN",
        "PARITY:escapeHtml:END",
      );
      const canonical = stripEdgeFences(canonicalRaw);

      // Extract from the test file via line-comment sentinels (no fence stripping needed)
      const testCopy = extractBetween(
        testCopySource,
        "PARITY:escapeHtml:BEGIN",
        "PARITY:escapeHtml:END",
      );

      expect(normalizeForParity(canonical)).toBe(normalizeForParity(testCopy));
    });

    it("canonical extraction is non-empty and contains the function signature", () => {
      const canonicalRaw = extractBetween(
        designSystemSource,
        "PARITY:escapeHtml:BEGIN",
        "PARITY:escapeHtml:END",
      );
      const canonical = stripEdgeFences(canonicalRaw);
      expect(canonical.trim().length).toBeGreaterThan(0);
      expect(canonical).toContain("function escapeHtml(");
    });
  });

  describe("markdownToHtml parity", () => {
    it("canonical source and test copy normalize to the same code", () => {
      // Extract from DESIGN-SYSTEM.md via HTML-comment sentinels, then strip edge fences
      const canonicalRaw = extractBetween(
        designSystemSource,
        "PARITY:markdownToHtml:BEGIN",
        "PARITY:markdownToHtml:END",
      );
      const canonical = stripEdgeFences(canonicalRaw);

      // Extract from the test file via line-comment sentinels
      const testCopy = extractBetween(
        testCopySource,
        "PARITY:markdownToHtml:BEGIN",
        "PARITY:markdownToHtml:END",
      );

      expect(normalizeForParity(canonical)).toBe(normalizeForParity(testCopy));
    });

    it("canonical extraction is non-empty and contains the function signature", () => {
      const canonicalRaw = extractBetween(
        designSystemSource,
        "PARITY:markdownToHtml:BEGIN",
        "PARITY:markdownToHtml:END",
      );
      const canonical = stripEdgeFences(canonicalRaw);
      expect(canonical.trim().length).toBeGreaterThan(0);
      expect(canonical).toContain("function markdownToHtml(");
    });
  });
});
