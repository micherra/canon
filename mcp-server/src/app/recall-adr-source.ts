/**
 * ADR lexical source reader for `recall`.
 *
 * `graph_query search` is entity-FTS and blind to ADR prose (PROBE-FINDINGS
 * Probe A — a live `graph_query({query_type:"search"})` against ADR content
 * returned `count:0`), so the `adr` fusion source is this dedicated reader
 * instead of a `graph_query` adapter.
 *
 * Deviation from the m1-02 task plan: the plan names `readFrontmatter` from
 * `@shared/lib/frontmatter.ts` as the parser. That export does not exist in
 * this codebase — only the pure `splitFrontmatter(content)` seam does (every
 * other call site, e.g. `features/loops/load-loops.ts`, reads the file itself
 * via `node:fs` and passes the raw content to `splitFrontmatter`). This file
 * follows that established pattern rather than inventing the missing export.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatter } from "@shared/lib/frontmatter.ts";
import type { RecallCandidate } from "./recall-fusion.ts";

/** Query tokens shorter than this are dropped as stopword noise. */
const MIN_TOKEN_LEN = 3;
/** Extra score weight applied when a query token also appears in the title. */
const TITLE_MATCH_BONUS = 0.5;
/** Max snippet length (chars) after whitespace collapsing. */
const SNIPPET_LEN = 160;

// Real ADRs follow the `NNNN-slug.md` convention (see docs/adr/0001-adr-template-placement.md
// "the durable path (architect -> docs/adr/NNNN-slug.md)"). `docs/adr/TEMPLATE.md` is a scaffold,
// not a real ADR — it carries a literal `adr: "{NNNN}"` placeholder that would otherwise surface
// as a fabricated `adr:ADR-{NNNN}` hit. Requiring the numeric-prefix filename excludes it (and any
// other future non-ADR file in the directory) without special-casing the template by name.
const ADR_FILENAME_RE = /^\d{4}-.+\.md$/;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= MIN_TOKEN_LEN);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function deriveTitle(data: Record<string, unknown>, body: string, filenameStem: string): string {
  if (typeof data.title === "string" && data.title.trim() !== "") return data.title;
  const heading = /^#\s+(.+)$/m.exec(body);
  if (heading) return heading[1].trim();
  return filenameStem;
}

function deriveAdrNumber(data: Record<string, unknown>, filenameStem: string): string {
  if (typeof data.adr === "string" && data.adr.trim() !== "") return data.adr;
  return filenameStem;
}

/** Count of distinct query tokens found in the ADR text, plus a small title-match weight. */
function scoreAdr(queryTokens: string[], title: string, body: string): number {
  const textTokens = new Set(tokenize(`${title} ${body}`));
  const titleTokens = new Set(tokenize(title));
  let score = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) score += 1;
    if (titleTokens.has(token)) score += TITLE_MATCH_BONUS;
  }
  return score;
}

type ParsedAdr = { filename: string; adrNumber: string; title: string; body: string };

/** Read and parse one ADR file. Returns null on any read/parse failure (skip, don't abort the scan). */
function readAdrFile(adrDir: string, filename: string): ParsedAdr | null {
  try {
    const raw = readFileSync(join(adrDir, filename), "utf-8");
    const { data, body } = splitFrontmatter(raw);
    const stem = filename.replace(/\.md$/, "");
    return {
      adrNumber: deriveAdrNumber(data, stem),
      body,
      filename,
      title: deriveTitle(data, body, stem),
    };
  } catch {
    return null;
  }
}

/**
 * Rank ADRs under `adrDir` (docs/adr) against `query` by lexical token overlap.
 *
 * Fail-open: a missing/unreadable `adrDir` returns `[]`; a single malformed
 * ADR file is skipped without aborting the scan of the rest. Never throws.
 */
export function rankAdrs(query: string, adrDir: string, limit: number): RecallCandidate[] {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) return [];

  let filenames: string[];
  try {
    filenames = readdirSync(adrDir).filter((f) => ADR_FILENAME_RE.test(f));
  } catch {
    return [];
  }

  const scored = filenames
    .map((filename) => readAdrFile(adrDir, filename))
    .filter((parsed): parsed is ParsedAdr => parsed !== null)
    .map((parsed) => ({ parsed, score: scoreAdr(queryTokens, parsed.title, parsed.body) }))
    .filter(({ score }) => score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.parsed.adrNumber < b.parsed.adrNumber
      ? -1
      : a.parsed.adrNumber > b.parsed.adrNumber
        ? 1
        : 0;
  });

  return scored.slice(0, limit).map(({ parsed, score }) => ({
    id: `adr:ADR-${parsed.adrNumber}`,
    native_score: score,
    path: `docs/adr/${parsed.filename}`,
    snippet: `${parsed.title} — ${collapseWhitespace(parsed.body).slice(0, SNIPPET_LEN)}`,
    source_store: "adr",
  }));
}
