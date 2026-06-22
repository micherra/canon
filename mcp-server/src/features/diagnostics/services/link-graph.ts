/**
 * Link Graph + Link-Integrity Check (R2, ADR-0019).
 *
 * Builds a reference graph over the markdown corpus and surfaces broken references:
 * broken `[[wiki-link]]`, broken relative md links, dangling `ADR-NNNN` cross-refs.
 * It also produces the inbound-link set that replaces the old substring orphan scan
 * (`allText.includes(p.id)`) — a principle is referenced iff some `[[ ]]` link points
 * at it, which is structurally correct (ADR-0019) rather than substring-coincidental.
 *
 * Extraction uses the same remark/mdast pipeline as `graph/kg-adapter-markdown.ts`:
 * `[[wiki-link]]` survives remark-parse inside `text` nodes with position info
 * (PROBE-FINDINGS P1), and visiting only `type:"text"` nodes excludes fenced-code and
 * inline-code occurrences by construction (P2) — so the in-code false-positive guard
 * is free and NO custom remark micro-plugin is needed.
 *
 * Pure, no I/O: callers pass pre-loaded doc contents + an injected `existsOnDisk`
 * predicate (mirrors `checkCitedPaths`). Cross-feature internals are NOT imported —
 * the tiny `isRelativePath` logic is replicated locally (ADR-0005).
 *
 * Canon principles:
 * - pure-io-service-split: all I/O in the tool layer; this module is pure
 * - functions-do-one-thing: extraction, graph build, and findings are separable
 * - errors-are-values: findings are returned, never thrown
 */

import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

// ---- Extraction ----

// canon:allow-unwired: extracted wiki-link ref shape — fields of ExtractedLinks + helper param types within this module; exported for its unit tests
export type WikiLinkRef = { target: string; line: number };
// canon:allow-unwired: extracted md-link ref shape — field of ExtractedLinks + collectMdFindings param within this module; exported for its unit tests
export type MdLinkRef = { url: string; line: number };
// canon:allow-unwired: extracted ADR-ref shape — field of ExtractedLinks + collectAdrFindings param within this module; exported for its unit tests
export type AdrRef = { ref: string; line: number };

// canon:allow-unwired: return type of extractLinks, exported for its unit tests
export type ExtractedLinks = {
  wikiLinks: WikiLinkRef[];
  mdLinks: MdLinkRef[];
  adrRefs: AdrRef[];
};

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const ADR_REF_RE = /ADR-(\d{4})/g;

/**
 * Relative path detection — replicated from `kg-adapter-markdown.ts` (tiny, and a
 * cross-feature import would violate ADR-0005). A link is relative when it is not a
 * protocol URL, anchor, or mailto.
 */
function isRelativePath(url: string): boolean {
  return (
    url.startsWith("./") ||
    url.startsWith("../") ||
    (!url.includes("://") && !url.startsWith("#") && !url.startsWith("mailto:"))
  );
}

/** Collect all regex matches over a single text node, tagged with the node's line. */
function matchesInText<T>(
  value: string,
  line: number,
  re: RegExp,
  make: (capture: string, line: number) => T,
): T[] {
  const out: T[] = [];
  // matchAll on a fresh string; the /g regex is module-level but matchAll is safe.
  for (const m of value.matchAll(re)) {
    out.push(make((m[1] ?? "").trim(), line));
  }
  return out;
}

/**
 * Extract wiki-links, relative md links, and ADR refs from one markdown document.
 *
 * Wiki-links and ADR refs are read from `text` nodes only (code/inline-code excluded
 * by construction — P2). Md links are read from `link` nodes and filtered to relative
 * paths.
 */
// canon:allow-unwired: pure link extractor exported for direct unit testing (link-graph.test.ts); also used internally by buildLinkGraph in this module
export function extractLinks(content: string): ExtractedLinks {
  const processor = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm);
  const tree = processor.parse(content);

  const wikiLinks: WikiLinkRef[] = [];
  const adrRefs: AdrRef[] = [];
  const mdLinks: MdLinkRef[] = [];

  visit(tree, (node) => {
    if (node.type === "text") {
      const text = node as { type: "text"; value: string; position?: { start: { line: number } } };
      const line = text.position?.start.line ?? 0;
      wikiLinks.push(
        ...matchesInText(text.value, line, WIKILINK_RE, (target, ln) => ({ line: ln, target })),
      );
      adrRefs.push(
        ...matchesInText(text.value, line, ADR_REF_RE, (ref, ln) => ({ line: ln, ref })),
      );
    } else if (node.type === "link") {
      const link = node as { type: "link"; url: string; position?: { start: { line: number } } };
      if (link.url && isRelativePath(link.url)) {
        mdLinks.push({ line: link.position?.start.line ?? 0, url: link.url });
      }
    }
  });

  return { adrRefs, mdLinks, wikiLinks };
}

// ---- Graph build + checks ----

/** Resolution maps for a `[[ ]]`/md/ADR reference. */
export type KnownTargets = {
  /** Principle ids (e.g. `simplicity-first`). */
  principleIds: Set<string>;
  /** File stems without extension (e.g. `prd` for `templates/prd.md`). */
  stems: Set<string>;
  /** Known ADR numbers (4-digit strings, e.g. `0017`). */
  adrNumbers: Set<string>;
  /** Repo-relative file paths present in the corpus scan. */
  filePaths: Set<string>;
};

export type LinkGraphInput = { path: string; content: string };

export type LinkIntegrityFinding = {
  source_file: string;
  code: "BROKEN_WIKILINK" | "BROKEN_MDLINK" | "DANGLING_ADR_REF";
  target: string;
  line_number: number;
  message: string;
};

export type LinkGraphResult = {
  findings: LinkIntegrityFinding[];
  /**
   * The set of principle ids that are the inbound target of at least one `[[ ]]`
   * link anywhere in the corpus — the structurally-correct "referenced" set that
   * replaces the substring orphan scan (ADR-0019).
   */
  referencedPrincipleIds: Set<string>;
};

/** Resolve a relative md link against the source file's directory → repo-relative path. */
function resolveRelative(sourceFile: string, url: string): string {
  // Drop a trailing anchor; resolve `./` and `../` against the source dir.
  const clean = url.split("#")[0];
  const dir = sourceFile.includes("/") ? sourceFile.slice(0, sourceFile.lastIndexOf("/")) : "";
  const segments = `${dir}/${clean}`.split("/");
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}

/** True if a `[[target]]` resolves to a known principle id or a known file stem. */
function wikiLinkResolves(target: string, known: KnownTargets): boolean {
  return known.principleIds.has(target) || known.stems.has(target);
}

/**
 * Collect wiki-link findings for one doc AND record inbound principle references.
 * The `referencedPrincipleIds` set is mutated in place (the orphan source-of-truth).
 */
function collectWikiFindings(
  doc: LinkGraphInput,
  wikiLinks: WikiLinkRef[],
  known: KnownTargets,
  referencedPrincipleIds: Set<string>,
): LinkIntegrityFinding[] {
  const findings: LinkIntegrityFinding[] = [];
  for (const w of wikiLinks) {
    if (known.principleIds.has(w.target)) referencedPrincipleIds.add(w.target);
    if (!wikiLinkResolves(w.target, known)) {
      findings.push({
        code: "BROKEN_WIKILINK",
        line_number: w.line,
        message: `Broken wiki-link [[${w.target}]] — resolves to no known principle id or file stem.`,
        source_file: doc.path,
        target: w.target,
      });
    }
  }
  return findings;
}

/** Collect broken relative-md-link findings for one doc. */
function collectMdFindings(
  doc: LinkGraphInput,
  mdLinks: MdLinkRef[],
  existsOnDisk: (repoRelPath: string) => boolean,
): LinkIntegrityFinding[] {
  const findings: LinkIntegrityFinding[] = [];
  for (const m of mdLinks) {
    const resolved = resolveRelative(doc.path, m.url);
    if (!existsOnDisk(resolved)) {
      findings.push({
        code: "BROKEN_MDLINK",
        line_number: m.line,
        message: `Broken relative link '${m.url}' — '${resolved}' does not exist on disk.`,
        source_file: doc.path,
        target: m.url,
      });
    }
  }
  return findings;
}

/** Collect dangling ADR-reference findings for one doc. */
function collectAdrFindings(
  doc: LinkGraphInput,
  adrRefs: AdrRef[],
  known: KnownTargets,
): LinkIntegrityFinding[] {
  const findings: LinkIntegrityFinding[] = [];
  for (const a of adrRefs) {
    if (!known.adrNumbers.has(a.ref)) {
      findings.push({
        code: "DANGLING_ADR_REF",
        line_number: a.line,
        message: `Dangling ADR reference ADR-${a.ref} — no docs/adr/${a.ref}-*.md file exists.`,
        source_file: doc.path,
        target: a.ref,
      });
    }
  }
  return findings;
}

/**
 * Build the link graph over the corpus and return broken-link findings plus the
 * inbound-target principle-id set (for orphan detection).
 *
 * `existsOnDisk` is the only effect seam (mirrors `checkCitedPaths`).
 */
export function buildLinkGraph(
  docs: LinkGraphInput[],
  known: KnownTargets,
  existsOnDisk: (repoRelPath: string) => boolean,
): LinkGraphResult {
  const findings: LinkIntegrityFinding[] = [];
  const referencedPrincipleIds = new Set<string>();

  for (const doc of docs) {
    const { wikiLinks, mdLinks, adrRefs } = extractLinks(doc.content);
    findings.push(...collectWikiFindings(doc, wikiLinks, known, referencedPrincipleIds));
    findings.push(...collectMdFindings(doc, mdLinks, existsOnDisk));
    findings.push(...collectAdrFindings(doc, adrRefs, known));
  }

  return { findings, referencedPrincipleIds };
}
