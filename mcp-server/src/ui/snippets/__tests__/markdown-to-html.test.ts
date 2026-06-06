/**
 * Unit tests for markdownToHtml — table rendering coverage.
 *
 * markdownToHtml is defined as a JavaScript function in DESIGN-SYSTEM.md Section E and
 * is intended to be copied verbatim into build-time renderer scripts. These tests exercise
 * the function's behavior, particularly the table-rendering path that was absent prior to
 * this fix (raw pipe text instead of HTML table markup).
 *
 * Canon principles: functions-do-one-thing, errors-are-values
 *
 * Implementation note: markdownToHtml lives in a Markdown document (DESIGN-SYSTEM.md)
 * as a fenced JavaScript code block. Extracting it via backtick-fence parsing is brittle
 * because the function itself contains the pattern /^```/ in its code-fence detection logic
 * (triple-backtick inside a regex literal), which confuses naive fence-end detection.
 *
 * Solution: the function is included inline here. Keep this copy in sync with
 * DESIGN-SYSTEM.md Section E when markdownToHtml is updated.
 */

import { describe, expect, it } from "vitest";

// ── Inline copy of escapeHtml + markdownToHtml from DESIGN-SYSTEM.md Section E ──
// Keep in sync with mcp-server/src/ui/snippets/DESIGN-SYSTEM.md Section E.
// The copy-here approach is necessary because the function body contains triple-backtick
// patterns (/^```/) that break naive markdown code-block boundary detection.

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToHtml(md: string): string {
  if (!md) return "";
  const lines = String(md).split("\n");
  const out: string[] = [];
  let inCodeFence = false;
  let codeFenceLang = "";
  let codeLines: string[] = [];
  let inUl = false;
  let inOl = false;
  let inTable = false;
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];
  let tableSeparatorSeen = false;

  function closeList() {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  }

  function parseTableCells(line: string): string[] {
    // Split on | delimiters, trim each cell, drop leading and trailing empty cells
    // produced by the mandatory outer pipes (| cell | cell |).
    const raw = line.split("|");
    const cells = raw.slice(1, raw.length - 1).map((c) => c.trim());
    return cells;
  }

  function closeTable() {
    if (!inTable) return;
    inTable = false;
    tableSeparatorSeen = false;
    if (tableHeaders.length === 0) {
      tableRows = [];
      tableHeaders = [];
      return;
    }
    const thHtml = tableHeaders.map((h) => `<th>${inlineFormat(h)}</th>`).join("");
    let tbodyHtml: string;
    if (tableRows.length === 0) {
      // Header-only table (empty-state): render a muted "none" row spanning all columns
      tbodyHtml = `<tr><td colspan="${tableHeaders.length}" style="color:var(--text-muted);font-style:italic;">None</td></tr>`;
    } else {
      tbodyHtml = tableRows
        .map((cells) => {
          const padded = tableHeaders.map((_, idx) => cells[idx] ?? "");
          return `<tr>${padded.map((c) => `<td>${inlineFormat(c)}</td>`).join("")}</tr>`;
        })
        .join("");
    }
    out.push(
      `<div class="table-scroll-wrapper"><table class="requirement-table"><thead><tr>${thHtml}</tr></thead><tbody>${tbodyHtml}</tbody></table></div>`,
    );
    tableHeaders = [];
    tableRows = [];
  }

  function inlineFormat(text: string): string {
    // Escape first, then apply inline patterns.
    let s = escapeHtml(text);
    // Protect code spans FIRST — substitute tokens so the bold/italic/file-ref rewrites
    // below cannot corrupt code-span content. Restored last.
    const codeSpans: string[] = [];
    s = s.replace(/`([^`]+)`/g, (_: string, content: string) => {
      codeSpans.push(`<code>${content}</code>`);
      return `\x00CODE${codeSpans.length - 1}\x00`;
    });
    // file:line references (path.ts:42 → <code>) — tokenized BEFORE italic so that
    // underscored path segments (e.g. src/foo_bar.ts:42) are not corrupted by _..._.
    // We replace with the same \x00CODE token pool so the italic pass cannot touch them.
    s = s.replace(/([\w./-]+\.(?:ts|js|py|go|rs|md):\d+)/g, (_: string, ref: string) => {
      codeSpans.push(`<code>${ref}</code>`);
      return `\x00CODE${codeSpans.length - 1}\x00`;
    });
    // Bold (**text** or __text__) — safe now, won't match inside code tokens.
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // Italic (*text* or _text_) — must come after bold and file:line.
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/_([^_]+)_/g, "<em>$1</em>");
    // Restore protected code spans (includes file:line refs tokenized above).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL sentinel tokens (\x00) are intentional — they prevent bold/italic passes from matching inside code spans; cannot use a printable delimiter that could appear in user text
    s = s.replace(/\x00CODE(\d+)\x00/g, (_: string, i: string) => codeSpans[Number(i)]);
    return s;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code fence open/close
    if (/^```/.test(line)) {
      if (!inCodeFence) {
        closeList();
        inCodeFence = true;
        codeFenceLang = line.slice(3).trim();
        codeLines = [];
      } else {
        inCodeFence = false;
        const langAttr = codeFenceLang ? ` class="language-${escapeHtml(codeFenceLang)}"` : "";
        out.push(`<pre><code${langAttr}>${codeLines.map(escapeHtml).join("\n")}</code></pre>`);
        codeLines = [];
        codeFenceLang = "";
      }
      continue;
    }
    if (inCodeFence) {
      codeLines.push(line);
      continue;
    }

    // Headings
    const h4 = line.match(/^#### (.+)/);
    if (h4) {
      closeList();
      out.push(`<h4>${inlineFormat(h4[1])}</h4>`);
      continue;
    }
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      closeList();
      out.push(`<h3>${inlineFormat(h3[1])}</h3>`);
      continue;
    }
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      closeList();
      out.push(`<h2>${inlineFormat(h2[1])}</h2>`);
      continue;
    }
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      closeList();
      out.push(`<h1>${inlineFormat(h1[1])}</h1>`);
      continue;
    }

    // Table rows — lines starting with | (pipe)
    if (/^\|/.test(line.trim())) {
      closeList();
      // Separator row (e.g. |---|:---:|---) — marks end of header rows
      if (/^\|[\s\-:|]+\|/.test(line.trim()) && /^[|\s\-:|]+$/.test(line.trim())) {
        tableSeparatorSeen = true;
        if (!inTable && tableHeaders.length > 0) inTable = true;
        continue;
      }
      const cells = parseTableCells(line.trim());
      if (!inTable) {
        // First non-separator pipe row — treat as header row
        tableHeaders = cells;
        inTable = true;
      } else if (!tableSeparatorSeen) {
        // Still accumulating header rows before separator (unusual but safe)
        tableHeaders = cells;
      } else {
        // Data row
        tableRows.push(cells);
      }
      continue;
    }

    // Non-pipe line after a table — flush the table first
    if (inTable) {
      closeTable();
    }

    // Unordered list items
    const ul = line.match(/^[-*] (.+)/);
    if (ul) {
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${inlineFormat(ul[1])}</li>`);
      continue;
    }

    // Ordered list items
    const ol = line.match(/^\d+\. (.+)/);
    if (ol) {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${inlineFormat(ol[1])}</li>`);
      continue;
    }

    // Blank line — close lists and paragraph boundary
    if (line.trim() === "") {
      closeList();
      out.push(""); // paragraph break marker
      continue;
    }

    // Regular paragraph line — close any open list first
    closeList();
    out.push(inlineFormat(line));
  }

  // Close any unclosed list or table
  closeList();
  closeTable();

  // Wrap consecutive non-empty lines into <p> blocks
  const result: string[] = [];
  let paraLines: string[] = [];
  for (const token of out) {
    if (token === "") {
      if (paraLines.length) {
        // If it's already a block element, emit as-is; otherwise wrap in <p>
        const joined = paraLines.join(" ");
        if (/^<(h[1-6]|ul|ol|pre|li|div|table)/.test(joined)) {
          result.push(joined);
        } else {
          result.push(`<p>${joined}</p>`);
        }
        paraLines = [];
      }
    } else {
      paraLines.push(token);
    }
  }
  if (paraLines.length) {
    const joined = paraLines.join(" ");
    if (/^<(h[1-6]|ul|ol|pre|li|div|table)/.test(joined)) {
      result.push(joined);
    } else {
      result.push(`<p>${joined}</p>`);
    }
  }

  return result.join("\n");
}
/* eslint-enable */

// ── Table rendering tests ─────────────────────────────────────────────────────

describe("markdownToHtml — table rendering", () => {
  it("converts a standard GFM table to HTML table markup", () => {
    const md = `| Principle | Severity | Location |
|-----------|----------|----------|
| errors-are-values | rule | src/foo.ts |
| simplicity-first | convention | src/bar.ts |`;

    const html = markdownToHtml(md);
    expect(html).toContain("<table");
    expect(html).toContain("</table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>");
    expect(html).toContain("Principle");
    expect(html).toContain("Severity");
    expect(html).toContain("Location");
    expect(html).toContain("<tbody>");
    expect(html).toContain("errors-are-values");
    expect(html).toContain("simplicity-first");
    // Must NOT contain raw pipes in the output
    expect(html).not.toMatch(/\|\s*Principle/);
    expect(html).not.toMatch(/\|\s*errors-are-values/);
  });

  it("applies requirement-table class and table-scroll-wrapper", () => {
    const md = `| Col1 | Col2 |
|------|------|
| A | B |`;

    const html = markdownToHtml(md);
    expect(html).toContain('class="requirement-table"');
    expect(html).toContain('class="table-scroll-wrapper"');
  });

  it("renders header-only table (separator but no data rows) with muted None row", () => {
    const md = `| Principle | Severity | Location | Confidence |
|-----------|----------|----------|------------|`;

    const html = markdownToHtml(md);
    expect(html).toContain("<table");
    expect(html).toContain("<th>");
    expect(html).toContain("Principle");
    // Empty-state: should show muted None row, not raw pipes
    expect(html).toContain("None");
    expect(html).toContain("font-style:italic");
    expect(html).not.toMatch(/\|---/);
    expect(html).not.toMatch(/\| Principle \|/);
  });

  it("handles table embedded between paragraphs", () => {
    const md = `Some text before.

| Layer | Rules | Opinions |
|-------|-------|----------|
| overall | 1 / 1 | 0 / 0 |

Some text after.`;

    const html = markdownToHtml(md);
    expect(html).toContain("<p>Some text before.</p>");
    expect(html).toContain("<table");
    expect(html).toContain("overall");
    expect(html).toContain("<p>Some text after.</p>");
  });

  it("escapes HTML special characters in table cells", () => {
    const md = `| Input | Output |
|-------|--------|
| <script>alert(1)</script> | &amp; |`;

    const html = markdownToHtml(md);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("handles table with missing trailing cells (ragged rows)", () => {
    const md = `| A | B | C |
|---|---|---|
| 1 | 2 |`;

    // Should not throw; missing cells become empty
    expect(() => markdownToHtml(md)).not.toThrow();
    const html = markdownToHtml(md);
    expect(html).toContain("<table");
    expect(html).toContain(">1<");
    expect(html).toContain(">2<");
  });

  it("does NOT wrap table HTML in a <p> tag", () => {
    const md = `| Col |
|-----|
| val |`;

    const html = markdownToHtml(md);
    // The table div should not appear inside a <p>
    expect(html).not.toMatch(/<p[^>]*>.*<table/s);
    expect(html).not.toMatch(/<\/table>.*<\/p>/s);
  });

  it("renders the score table from a typical CLEAN review narrative", () => {
    // Reproduces the exact table shapes observed in the bug report
    const md = `| Layer | Rules | Opinions | Conventions |
|-------|-------|----------|-------------|
| overall | 1 / 1 | 0 / 0 | 0 / 0 |`;

    const html = markdownToHtml(md);
    expect(html).toContain("<table");
    expect(html).toContain("overall");
    expect(html).toContain("1 / 1");
    expect(html).not.toMatch(/\| Layer \|/);
    expect(html).not.toMatch(/\| overall \|/);
  });
});

// ── Regression tests — existing behavior must be preserved ───────────────────

describe("markdownToHtml — regression: non-table features still work", () => {
  it("converts headings", () => {
    expect(markdownToHtml("## Hello")).toContain("<h2>Hello</h2>");
    expect(markdownToHtml("### Sub")).toContain("<h3>Sub</h3>");
  });

  it("converts unordered lists", () => {
    const html = markdownToHtml("- item one\n- item two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item one</li>");
    expect(html).toContain("<li>item two</li>");
    expect(html).toContain("</ul>");
  });

  it("converts bold and italic inline", () => {
    expect(markdownToHtml("**bold**")).toContain("<strong>bold</strong>");
    expect(markdownToHtml("*italic*")).toContain("<em>italic</em>");
  });

  it("wraps plain text paragraphs in <p>", () => {
    expect(markdownToHtml("Hello world")).toContain("<p>Hello world</p>");
  });

  it("returns empty string for falsy input", () => {
    expect(markdownToHtml("")).toBe("");
  });

  it("converts fenced code blocks", () => {
    const html = markdownToHtml("```js\nconsole.log('hi');\n```");
    expect(html).toContain("<pre><code");
    expect(html).toContain("console.log");
  });
});
