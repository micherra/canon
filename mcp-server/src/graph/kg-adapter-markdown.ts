/**
 * Markdown Language Adapter
 *
 * Extracts Canon entities from Markdown files using the shared frontmatter
 * splitter (yaml-backed) for frontmatter parsing and remark for body content
 * analysis.
 */

import { splitFrontmatter } from "@shared/lib/frontmatter.ts";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { AdapterResult, EntityKind, ImportSpecifier, LanguageAdapter } from "./kg-types.ts";

// Entity kind classification

/**
 * Classify the Canon entity kind from frontmatter data and file path.
 * Returns null if the file doesn't match a known Canon entity type.
 */
function pathContains(filePath: string, segment: string): boolean {
  return filePath.includes(`/${segment}/`) || filePath.includes(`${segment}/`);
}

function classifyEntityKind(filePath: string, data: Record<string, unknown>): EntityKind | null {
  if ("severity" in data) return "principle";
  if (pathContains(filePath, "flows/fragments")) return "flow-fragment";
  if ("tier" in data || "states" in data) return "flow";
  if ("role" in data && pathContains(filePath, "agents")) return "agent";
  if (pathContains(filePath, "templates")) return "template";
  return null;
}

// Metadata extraction

function extractMetadata(
  kind: EntityKind | null,
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (kind) {
    case "principle":
      return {
        layers: Array.isArray(data.layers) ? data.layers : [],
        severity: data.severity ?? null,
        tags: Array.isArray(data.tags) ? data.tags : [],
      };
    case "flow":
    case "flow-fragment":
      return {
        states: Array.isArray(data.states) ? data.states : [],
        tier: data.tier ?? null,
      };
    case "agent":
      return { role: data.role ?? null };
    default:
      return null;
  }
}

// Relative path detection

function isRelativePath(url: string): boolean {
  // Relative paths start with ./ or ../ or are bare paths without a protocol
  return (
    url.startsWith("./") ||
    url.startsWith("../") ||
    (!url.includes("://") && !url.startsWith("#") && !url.startsWith("mailto:"))
  );
}

// Adapter implementation

// Body parsing helpers

/** Extract relative link URLs and backtick references from the markdown body. */
function extractBodyRefs(content: string): { backtickRefs: string[]; linkUrls: string[] } {
  const processor = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm);
  const tree = processor.parse(content);

  const backtickRefs: string[] = [];
  const linkUrls: string[] = [];

  visit(tree, (node) => {
    if (node.type === "link") {
      const url = (node as { type: "link"; url: string }).url;
      if (url && isRelativePath(url)) linkUrls.push(url);
    }
    if (node.type === "inlineCode") {
      const val = (node as { type: "inlineCode"; value: string }).value.trim();
      if (val.length > 0) backtickRefs.push(val);
    }
  });

  return { backtickRefs, linkUrls };
}

/** Collect relative path specifiers from a frontmatter field value. */
function collectFieldSpecifiers(val: unknown, specifiers: ImportSpecifier[]): void {
  if (typeof val === "string" && isRelativePath(val)) {
    specifiers.push({ names: [], specifier: val });
    return;
  }
  if (!Array.isArray(val)) return;
  for (const item of val) {
    if (typeof item === "string" && isRelativePath(item)) {
      specifiers.push({ names: [], specifier: item });
    }
  }
}

/** Extract import specifiers from frontmatter reference fields. */
function extractFrontmatterImports(frontmatterData: Record<string, unknown>): ImportSpecifier[] {
  const specifiers: ImportSpecifier[] = [];
  const fmRefFields = ["includes", "template", "agent", "extends", "inherits"];
  for (const field of fmRefFields) {
    collectFieldSpecifiers(frontmatterData[field], specifiers);
  }
  return specifiers;
}

/**
 * Conservative path-like backtick-ref extractor (mirrors wiki_lint's cited-path grammar).
 *
 * Accepts tokens that:
 *   - match /^[a-zA-Z][\w./-]*\.(?:sh|ts|tsx|js|json|yaml|yml|md)$/
 *   - contain at least one '/'
 *   - contain none of: '${', '<', '>', '{', '}'
 *   - do not start with 'http://' or 'https://' or '#'
 *
 * This rejects bare identifiers (`KgStore`), slash-less filenames (`flow-schema.ts`),
 * template paths (`${WORKSPACE}/x.md`), and URL-like references.
 */
const BACKTICK_PATH_RE = /^[a-zA-Z][\w./-]*\.(?:sh|ts|tsx|js|json|yaml|yml|md)$/;
const BACKTICK_REJECTED_CHARS = /\$\{|[<>{}]/;

function extractDocRefSpecifiers(backtickRefs: string[]): ImportSpecifier[] {
  const specifiers: ImportSpecifier[] = [];
  for (const ref of backtickRefs) {
    if (
      BACKTICK_PATH_RE.test(ref) &&
      ref.includes("/") &&
      !BACKTICK_REJECTED_CHARS.test(ref) &&
      !ref.startsWith("http://") &&
      !ref.startsWith("https://") &&
      !ref.startsWith("#")
    ) {
      specifiers.push({ edgeType: "doc:references", names: [], specifier: ref });
    }
  }
  return specifiers;
}

// Adapter implementation

export const markdownAdapter: LanguageAdapter = {
  extensions: [".md"],

  parse(filePath: string, content: string): AdapterResult {
    const { data: frontmatterData } = splitFrontmatter(content);

    const kind = classifyEntityKind(filePath, frontmatterData);
    const metadata = extractMetadata(kind, frontmatterData);

    const pathParts = filePath.replace(/\\/g, "/").split("/");
    const basename = pathParts[pathParts.length - 1] ?? filePath;
    const name = (frontmatterData.title as string | undefined) ?? basename.replace(/\.md$/, "");
    const qualifiedName = filePath;

    const lineCount = content.split("\n").length;
    const entityKind: EntityKind = kind ?? "file";
    const entities: AdapterResult["entities"] = [
      {
        is_default_export: false,
        is_exported: true,
        kind: entityKind,
        line_end: lineCount,
        line_start: 1,
        metadata: metadata ? JSON.stringify(metadata) : null,
        name,
        qualified_name: qualifiedName,
        signature: null,
      },
    ];

    const { backtickRefs, linkUrls } = extractBodyRefs(content);

    // Frontmatter refs are untagged (become 'imports' edges in the pipeline).
    // Link URLs and conservative backtick-path refs are tagged doc:references
    // so resolveImports writes them with the correct edge_type.
    const importSpecifiers: ImportSpecifier[] = [
      ...extractFrontmatterImports(frontmatterData),
      ...linkUrls.map((url) => ({
        edgeType: "doc:references" as const,
        names: [] as string[],
        specifier: url,
      })),
      ...extractDocRefSpecifiers(backtickRefs),
    ];

    // intraFileEdges was a dead wire (consumed nowhere, 0 DB rows).
    // doc:references persistence now rides importSpecifiers via resolveImports.
    return { entities, importSpecifiers, intraFileEdges: [] };
  },
};
