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
import type { AdapterResult, EntityKind, ImportSpecifier, IntraFileEdge, LanguageAdapter } from "./kg-types.ts";

// ---------------------------------------------------------------------------
// Entity kind classification
// ---------------------------------------------------------------------------

/**
 * Classify the Canon entity kind from frontmatter data and file path.
 * Returns null if the file doesn't match a known Canon entity type.
 */
function classifyEntityKind(filePath: string, data: Record<string, unknown>): EntityKind | null {
  // Principle: has a `severity` frontmatter field
  if ("severity" in data) {
    return "principle";
  }

  // Flow fragment: located in flows/fragments/
  if (filePath.includes("/flows/fragments/") || filePath.includes("flows/fragments/")) {
    return "flow-fragment";
  }

  // Flow: has `tier` or `states` frontmatter field
  if ("tier" in data || "states" in data) {
    return "flow";
  }

  // Agent: has `role` and is located in agents/ directory
  if ("role" in data && (filePath.includes("/agents/") || filePath.includes("agents/"))) {
    return "agent";
  }

  // Template: located in templates/ directory
  if (filePath.includes("/templates/") || filePath.includes("templates/")) {
    return "template";
  }

  // Decision: has `status` and is located in decisions/ directory
  if ("status" in data && (filePath.includes("/decisions/") || filePath.includes("decisions/"))) {
    return "decision";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

function extractMetadata(kind: EntityKind | null, data: Record<string, unknown>): Record<string, unknown> | null {
  switch (kind) {
    case "principle":
      return {
        severity: data["severity"] ?? null,
        tags: Array.isArray(data["tags"]) ? data["tags"] : [],
        layers: Array.isArray(data["layers"]) ? data["layers"] : [],
      };
    case "flow":
    case "flow-fragment":
      return {
        tier: data["tier"] ?? null,
        states: Array.isArray(data["states"]) ? data["states"] : [],
      };
    case "agent":
      return { role: data["role"] ?? null };
    case "decision":
      return { status: data["status"] ?? null };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Relative path detection
// ---------------------------------------------------------------------------

function isRelativePath(url: string): boolean {
  // Relative paths start with ./ or ../ or are bare paths without a protocol
  return (
    url.startsWith("./") ||
    url.startsWith("../") ||
    (!url.includes("://") && !url.startsWith("#") && !url.startsWith("mailto:"))
  );
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/** Build the primary entity descriptor for a markdown file. */
function buildFileEntity(
  filePath: string,
  content: string,
  frontmatterData: Record<string, unknown>,
): AdapterResult["entities"][number] {
  const kind = classifyEntityKind(filePath, frontmatterData);
  const metadata = extractMetadata(kind, frontmatterData);

  const pathParts = filePath.replace(/\\/g, "/").split("/");
  const basename = pathParts[pathParts.length - 1] ?? filePath;
  const name = (frontmatterData["title"] as string | undefined) ?? basename.replace(/\.md$/, "");
  const lineCount = content.split("\n").length;
  const entityKind: EntityKind = kind ?? "file";

  return {
    name,
    qualified_name: filePath,
    kind: entityKind,
    line_start: 1,
    line_end: lineCount,
    is_exported: true,
    is_default_export: false,
    signature: null,
    metadata: metadata ? JSON.stringify(metadata) : null,
  };
}

/** Extract relative link URLs and backtick references from the markdown AST. */
function extractBodyRefs(content: string): { backtickRefs: string[]; linkUrls: string[] } {
  const processor = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm);
  const tree = processor.parse(content);

  const backtickRefs: string[] = [];
  const linkUrls: string[] = [];

  visit(tree, (node) => {
    if (node.type === "link") {
      const url = (node as { type: "link"; url: string }).url;
      if (url && isRelativePath(url)) {
        linkUrls.push(url);
      }
    }
    if (node.type === "inlineCode") {
      const val = (node as { type: "inlineCode"; value: string }).value.trim();
      if (val.length > 0) {
        backtickRefs.push(val);
      }
    }
  });

  return { backtickRefs, linkUrls };
}

/** Extract import specifiers from frontmatter reference fields and link URLs. */
function extractMdImportSpecifiers(frontmatterData: Record<string, unknown>, linkUrls: string[]): ImportSpecifier[] {
  const specifiers: ImportSpecifier[] = [];

  const fmRefFields = ["includes", "template", "agent", "extends", "inherits"];
  for (const field of fmRefFields) {
    const val = frontmatterData[field];
    if (typeof val === "string" && isRelativePath(val)) {
      specifiers.push({ specifier: val, names: [] });
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && isRelativePath(item)) {
          specifiers.push({ specifier: item, names: [] });
        }
      }
    }
  }

  for (const url of linkUrls) {
    specifiers.push({ specifier: url, names: [] });
  }

  return specifiers;
}

/** Build intra-file doc:references edges from backtick refs and link URLs. */
function buildDocReferenceEdges(qualifiedName: string, backtickRefs: string[], linkUrls: string[]): IntraFileEdge[] {
  const edges: IntraFileEdge[] = [];

  for (const ref of backtickRefs) {
    edges.push({
      source_qualified: qualifiedName,
      target_qualified: ref,
      edge_type: "doc:references",
      confidence: 0.6,
    });
  }

  for (const url of linkUrls) {
    edges.push({
      source_qualified: qualifiedName,
      target_qualified: url,
      edge_type: "doc:references",
      confidence: 0.8,
    });
  }

  return edges;
}

export const markdownAdapter: LanguageAdapter = {
  extensions: [".md"],

  parse(filePath: string, content: string): AdapterResult {
    const parsed = matter(content);
    const frontmatterData = parsed.data as Record<string, unknown>;

    const entity = buildFileEntity(filePath, content, frontmatterData);
    const { backtickRefs, linkUrls } = extractBodyRefs(content);
    const importSpecifiers = extractMdImportSpecifiers(frontmatterData, linkUrls);
    const intraFileEdges = buildDocReferenceEdges(filePath, backtickRefs, linkUrls);

    return { entities: [entity], intraFileEdges, importSpecifiers };
  },
};
