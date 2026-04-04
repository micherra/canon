/**
 * Markdown Language Adapter
 *
 * Extracts Canon entities from Markdown files using gray-matter for
 * frontmatter parsing and remark for body content analysis.
 */

import matter from "gray-matter";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type {
  AdapterResult,
  EntityKind,
  ImportSpecifier,
  IntraFileEdge,
  LanguageAdapter,
} from "./kg-types.ts";

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
  if ("status" in data && pathContains(filePath, "decisions")) return "decision";
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
    case "decision":
      return { status: data.status ?? null };
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

/** Build doc:references intra-file edges from backtick refs and link URLs. */
function buildDocReferenceEdges(
  qualifiedName: string,
  backtickRefs: string[],
  linkUrls: string[],
): IntraFileEdge[] {
  const edges: IntraFileEdge[] = [];
  for (const ref of backtickRefs) {
    edges.push({
      confidence: 0.6,
      edge_type: "doc:references",
      source_qualified: qualifiedName,
      target_qualified: ref,
    });
  }
  for (const url of linkUrls) {
    edges.push({
      confidence: 0.8,
      edge_type: "doc:references",
      source_qualified: qualifiedName,
      target_qualified: url,
    });
  }
  return edges;
}

// Adapter implementation

export const markdownAdapter: LanguageAdapter = {
  extensions: [".md"],

  parse(filePath: string, content: string): AdapterResult {
    const parsed = matter(content);
    const frontmatterData = parsed.data as Record<string, unknown>;

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

    const importSpecifiers: ImportSpecifier[] = [
      ...extractFrontmatterImports(frontmatterData),
      ...linkUrls.map((url) => ({ names: [] as string[], specifier: url })),
    ];

    const intraFileEdges = buildDocReferenceEdges(qualifiedName, backtickRefs, linkUrls);

    return { entities, importSpecifiers, intraFileEdges };
  },
};
