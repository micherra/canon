/**
 * Tests for the link-integrity check + link graph (R2, ADR-0019).
 *
 * Two layers:
 * 1. Unit — `extractLinks` (mdast text-node visitor) and `buildLinkGraph` over
 *    synthetic docs: broken `[[name]]`, dangling `ADR-NNNN`, broken relative md
 *    link, and the orphan-detection contract (inbound-link presence — NOT substring).
 *    Critically: `[[ ]]` inside a fenced code block must NOT be extracted (P2), and a
 *    principle id that is merely an incidental prose substring must STILL be flagged
 *    as an orphan (the bug ADR-0019 fixes).
 * 2. Whole-corpus no-false-positive — the real corpus produces zero BROKEN_* findings.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLinkGraph,
  extractLinks,
  type KnownTargets,
  type LinkGraphInput,
} from "../link-graph.ts";

// ---- extractLinks (mdast text-node visitor) ----

describe("extractLinks", () => {
  it("extracts [[wiki-link]] from prose text nodes with line numbers", () => {
    const md = "# Title\n\nSee [[some-principle]] and [[another-one]] here.\n";
    const { wikiLinks } = extractLinks(md);
    expect(wikiLinks.map((w) => w.target)).toEqual(["some-principle", "another-one"]);
    expect(wikiLinks[0].line).toBe(3);
  });

  it("does NOT extract [[ ]] inside a fenced code block (P2 — text-node visiting excludes code)", () => {
    const md = [
      "# Title",
      "",
      "```ts",
      "const x = `[[not-a-real-link]]`;",
      "```",
      "",
      "Real [[live-one]].",
    ].join("\n");
    const { wikiLinks } = extractLinks(md);
    expect(wikiLinks.map((w) => w.target)).toEqual(["live-one"]);
  });

  it("does NOT extract [[ ]] inside an inline code span", () => {
    const md = "Use `[[also-not]]` literally, but [[yes-this]] resolves.\n";
    const { wikiLinks } = extractLinks(md);
    expect(wikiLinks.map((w) => w.target)).toEqual(["yes-this"]);
  });

  it("extracts relative md links (not absolute URLs or anchors)", () => {
    const md = "[rel](./foo.md) [up](../bar.md) [ext](https://x.com) [anchor](#h)\n";
    const { mdLinks } = extractLinks(md);
    expect(mdLinks.map((m) => m.url)).toEqual(["./foo.md", "../bar.md"]);
  });

  it("extracts ADR-NNNN references from text", () => {
    const md = "This supersedes ADR-0005 and relates to ADR-0017.\n";
    const { adrRefs } = extractLinks(md);
    expect(adrRefs.map((a) => a.ref)).toEqual(["0005", "0017"]);
  });
});

// ---- buildLinkGraph (broken-link + orphan checks) ----

function known(over: Partial<KnownTargets> = {}): KnownTargets {
  return {
    adrNumbers: new Set(["0001"]),
    filePaths: new Set(["principles/conventions/a.md"]),
    principleIds: new Set(["principle-a", "principle-b"]),
    stems: new Set(["a", "b", "primer-x"]),
    ...over,
  };
}

describe("buildLinkGraph — broken-link findings", () => {
  it("flags a [[nonexistent]] wiki-link as BROKEN_WIKILINK", () => {
    const docs: LinkGraphInput[] = [
      { content: "Refers to [[nope-not-here]].\n", path: "references/x.md" },
    ];
    const { findings } = buildLinkGraph(docs, known(), () => true);
    const broken = findings.filter((f) => f.code === "BROKEN_WIKILINK");
    expect(broken).toHaveLength(1);
    expect(broken[0].message).toMatch(/nope-not-here/);
  });

  it("does NOT flag a [[name]] that matches a principle id or known stem", () => {
    const docs: LinkGraphInput[] = [
      { content: "[[principle-a]] and [[primer-x]].\n", path: "references/x.md" },
    ];
    const { findings } = buildLinkGraph(docs, known(), () => true);
    expect(findings.filter((f) => f.code === "BROKEN_WIKILINK")).toHaveLength(0);
  });

  it("flags a broken relative md link (path not on disk) as BROKEN_MDLINK", () => {
    const docs: LinkGraphInput[] = [{ content: "[gone](./missing.md)\n", path: "docs/x.md" }];
    const existsOnDisk = (p: string): boolean => p !== "docs/missing.md";
    const { findings } = buildLinkGraph(docs, known(), existsOnDisk);
    const broken = findings.filter((f) => f.code === "BROKEN_MDLINK");
    expect(broken).toHaveLength(1);
  });

  it("flags a dangling ADR-NNNN reference as DANGLING_ADR_REF", () => {
    const docs: LinkGraphInput[] = [
      {
        content: "See ADR-9999 (does not exist) and ADR-0001 (exists).\n",
        path: "references/x.md",
      },
    ];
    const { findings } = buildLinkGraph(docs, known(), () => true);
    const dangling = findings.filter((f) => f.code === "DANGLING_ADR_REF");
    expect(dangling).toHaveLength(1);
    expect(dangling[0].message).toMatch(/9999/);
  });
});

describe("buildLinkGraph — inbound-link orphan detection (ADR-0019)", () => {
  it("computes the inbound-target set: a principle id is referenced iff a [[ ]] points to it", () => {
    const docs: LinkGraphInput[] = [
      { content: "We rely on [[principle-a]] heavily.\n", path: "references/x.md" },
    ];
    const { referencedPrincipleIds } = buildLinkGraph(docs, known(), () => true);
    expect(referencedPrincipleIds.has("principle-a")).toBe(true);
    // principle-b is never the target of a [[ ]] link → NOT referenced.
    expect(referencedPrincipleIds.has("principle-b")).toBe(false);
  });

  it("an incidental prose substring of a principle id does NOT count as a reference", () => {
    // "principle-b" appears as a plain-text substring, but with no [[ ]] link.
    const docs: LinkGraphInput[] = [
      { content: "The word principle-b shows up in prose only.\n", path: "references/x.md" },
    ];
    const { referencedPrincipleIds } = buildLinkGraph(docs, known(), () => true);
    expect(referencedPrincipleIds.has("principle-b")).toBe(false);
  });

  it("a [[ ]] inside a code block does NOT create an inbound edge", () => {
    const docs: LinkGraphInput[] = [
      { content: ["```", "[[principle-b]]", "```"].join("\n"), path: "references/x.md" },
    ];
    const { referencedPrincipleIds } = buildLinkGraph(docs, known(), () => true);
    expect(referencedPrincipleIds.has("principle-b")).toBe(false);
  });
});

// ---- Whole-corpus no-false-positive assertion (AC) ----

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist"]);
// Dir basenames to skip — transient build state, never the corpus. Matched on the
// basename (NOT a path substring) so an ambient REPO_ROOT path that itself sits under
// `.canon/workspaces/.../worktree` does not skip the entire tree.
const EXCLUDED_SUBTREES = new Set(["workspaces", "worktrees"]);

/** Recursively collect .md files under a directory (best-effort; missing dir → []). */
function collectMd(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (EXCLUDED_DIRS.has(name) || EXCLUDED_SUBTREES.has(name)) continue;
    const full = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...collectMd(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

describe("buildLinkGraph — whole real corpus (zero broken-link false positives)", () => {
  it("reports no BROKEN_WIKILINK / BROKEN_MDLINK / DANGLING_ADR_REF on the real cross-linked tree", () => {
    // High-signal cross-linked dirs (mirrors what wikiLint scans for link integrity).
    const corpusDirs = ["principles", ".canon/principles", "references", "primers", "docs"];
    const docs: LinkGraphInput[] = [];
    const stems = new Set<string>();
    const adrNumbers = new Set<string>();
    const filePaths = new Set<string>();
    const principleIds = new Set<string>();

    // First pass over ALL project .md files to populate resolution targets, so a
    // [[link]] from one dir resolving to a file in another is not a false positive.
    for (const full of collectMd(REPO_ROOT)) {
      const repoRel = full
        .slice(REPO_ROOT.length + 1)
        .split("\\")
        .join("/");
      filePaths.add(repoRel);
      const base = repoRel.slice(repoRel.lastIndexOf("/") + 1);
      stems.add(base.replace(/\.md$/, ""));
      const adr = /^(\d{4})-.+\.md$/.exec(base);
      if (adr) adrNumbers.add(adr[1]);
      // Principle id from frontmatter, if present.
      const content = readFileSync(full, "utf8");
      const idMatch = /^---\r?\n[\s\S]*?\bid:\s*([^\n]+)\r?\n[\s\S]*?\n---/.exec(content);
      if (idMatch && repoRel.includes("principles/")) {
        principleIds.add(idMatch[1].trim().replace(/^["']|["']$/g, ""));
      }
    }

    for (const rel of corpusDirs) {
      for (const full of collectMd(join(REPO_ROOT, rel))) {
        const repoRel = full
          .slice(REPO_ROOT.length + 1)
          .split("\\")
          .join("/");
        // docs/explore/ is stale-by-design (frozen exploration records) — excluded as
        // a link SOURCE, mirroring the tool's buildCorpusLinkGraph and the existing
        // stale_refs / cited_paths docs/explore/ exclusion.
        if (repoRel.startsWith("docs/explore/")) continue;
        docs.push({ content: readFileSync(full, "utf8"), path: repoRel });
      }
    }

    const known: KnownTargets = { adrNumbers, filePaths, principleIds, stems };
    const existsOnDisk = (p: string): boolean => existsSync(join(REPO_ROOT, p));

    // Sanity: real corpus actually loaded.
    expect(docs.length).toBeGreaterThan(10);

    const { findings } = buildLinkGraph(docs, known, existsOnDisk);
    // If this fails, the message names the offending file/link — a real broken
    // reference to fix, not a reason to weaken the check.
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});
