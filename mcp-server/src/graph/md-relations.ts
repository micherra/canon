import { readFile } from "fs/promises";
import { join, basename } from "path";
import { parseFrontmatter } from "../parser.ts";
import { isNotFound } from "../utils/errors.ts";
import { toPosix } from "../utils/paths.ts";
import type { GraphEdge } from "../tools/codebase-graph.ts";

// ── Types ──

export type MdNodeKind = string; // e.g. "flow", "agent", "principle" — derived from directory

export interface MdNameMaps {
  /** frontmatter `id:` or `name:` → file path */
  byId: Map<string, string>;
  /** filename stem (without .md) → file path */
  byStem: Map<string, string>;
}

export interface MdKindRule {
  /** Directory prefix to match (e.g. "agents/") */
  prefix: string;
  /** Kind label assigned to matching files */
  kind: string;
}

// ── Defaults ──

const EXCLUDED_DOCS = new Set(["CLAUDE.md", "SCHEMA.md", "GATES.md", "README.md"]);

function isExcludedDoc(filePath: string): boolean {
  return EXCLUDED_DOCS.has(basename(filePath));
}

/** Default kind rules — can be overridden via config in the future. */
const DEFAULT_KIND_RULES: MdKindRule[] = [
  { prefix: "flows/fragments/", kind: "fragment" },
  { prefix: "flows/", kind: "flow" },
  { prefix: "agents/", kind: "agent" },
  { prefix: "templates/", kind: "template" },
  { prefix: "principles/", kind: "principle" },
  { prefix: ".canon/principles/", kind: "principle" },
  { prefix: "skills/", kind: "skill" },
  { prefix: "commands/", kind: "command" },
];

// ── Node classification ──

export function classifyMdNode(
  filePath: string,
  kindRules: MdKindRule[] = DEFAULT_KIND_RULES,
): string | undefined {
  if (!filePath.endsWith(".md")) return undefined;
  if (isExcludedDoc(filePath)) return undefined;
  const posix = toPosix(filePath);
  for (const rule of kindRules) {
    if (posix.startsWith(rule.prefix)) return rule.kind;
  }
  return undefined;
}

// ── Name resolution maps ──

/**
 * Build universal lookup maps from all .md files.
 * - `byId`: frontmatter `id:` or `name:` field → file path
 * - `byStem`: filename stem → file path (last-writer-wins for collisions)
 */
export async function buildNameMaps(
  filePaths: string[],
  projectDir: string,
): Promise<MdNameMaps> {
  const byId = new Map<string, string>();
  const byStem = new Map<string, string>();

  const mdFiles = filePaths.filter((fp) => fp.endsWith(".md") && !isExcludedDoc(fp));

  // First pass: stem map (fast, no I/O)
  for (const fp of mdFiles) {
    const stem = basename(fp, ".md");
    byStem.set(stem, toPosix(fp));
  }

  // Second pass: read frontmatter for id/name fields
  await Promise.all(
    mdFiles.map(async (fp) => {
      try {
        const content = await readFile(join(projectDir, fp), "utf-8");
        const { frontmatter } = parseFrontmatter(content);
        const id = (frontmatter.id ?? frontmatter.name) as string | undefined;
        if (id && typeof id === "string") {
          byId.set(id, toPosix(fp));
        }
      } catch (err: unknown) {
        if (!isNotFound(err)) throw err;
      }
    }),
  );

  return { byId, byStem };
}

// ── Resolution ──

/** Try to resolve a name to a file path via ID map, then stem map. */
function resolveName(name: string, maps: MdNameMaps): string | undefined {
  return maps.byId.get(name) ?? maps.byStem.get(name);
}

// ── Edge construction ──

function compositionEdge(
  source: string,
  target: string,
  relation: string,
  confidence: number,
  evidence: string,
): GraphEdge {
  return {
    source,
    target,
    type: "composition",
    relation,
    confidence,
    evidence: evidence.slice(0, 140),
    origin: "inferred-llm",
  };
}

// ── Generic extractors ──

/**
 * Extract edges from frontmatter values.
 * For each frontmatter field, if the value is a string or string[],
 * try to resolve each value as a file reference via name maps.
 * The relation is derived from the field name (e.g., "agent" → "fm:agent").
 */
function extractFrontmatterEdges(
  filePath: string,
  frontmatterText: string,
  maps: MdNameMaps,
  _fileSet: Set<string>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  // Match `key: value` (single values)
  const singleRe = /^[ \t]*(\w[\w-]*):\s*["']?([a-z][\w-]*)["']?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = singleRe.exec(frontmatterText)) !== null) {
    const [, field, value] = m;
    const target = resolveName(value, maps);
    if (target && target !== filePath && !seen.has(`${field}:${target}`)) {
      seen.add(`${field}:${target}`);
      edges.push(compositionEdge(filePath, target, `fm:${field}`, 0.90, `${field}: ${value}`));
    }
  }

  // Match `key: [val1, val2, ...]` (inline arrays)
  const listRe = /^[ \t]*(\w[\w-]*):\s*\[([^\]]+)\]/gm;
  while ((m = listRe.exec(frontmatterText)) !== null) {
    const [, field, rawList] = m;
    const items = rawList.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    for (const item of items) {
      const target = resolveName(item, maps);
      if (target && target !== filePath && !seen.has(`${field}:${target}`)) {
        seen.add(`${field}:${target}`);
        edges.push(compositionEdge(filePath, target, `fm:${field}`, 0.85, `${field}: [${item}]`));
      }
    }
  }

  // Match `- key: value` patterns inside nested structures (e.g., `- fragment: name`)
  const nestedRe = /^[ \t]*-?\s*(\w[\w-]*):\s*["']?([a-z][\w-]*)["']?\s*$/gm;
  while ((m = nestedRe.exec(frontmatterText)) !== null) {
    const [, field, value] = m;
    const target = resolveName(value, maps);
    if (target && target !== filePath && !seen.has(`${field}:${target}`)) {
      seen.add(`${field}:${target}`);
      edges.push(compositionEdge(filePath, target, `fm:${field}`, 0.90, `${field}: ${value}`));
    }
  }

  return edges;
}

/**
 * Extract edges from backtick-quoted identifiers in body text.
 * Resolves `identifier` via ID map then stem map.
 */
function extractBacktickEdges(
  filePath: string,
  body: string,
  maps: MdNameMaps,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  const backtickRe = /`([a-z][\w-]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(body)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const target = resolveName(id, maps);
    if (target && target !== filePath) {
      edges.push(compositionEdge(filePath, target, "ref:id", 0.80, `\`${id}\``));
    }
  }

  return edges;
}

/**
 * Extract edges from file path references in the full content.
 * Handles:
 * - Explicit .md paths: `path/to/file.md`
 * - Variable paths: `${VAR}/path/to/file.md`
 * - Markdown links: `[text](path/to/file.md)`
 */
function extractPathEdges(
  filePath: string,
  content: string,
  fileSet: Set<string>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  // Match paths ending in .md (with optional ${VAR}/ prefix)
  const pathRe = /(?:\$\{[\w]+\}\/)?([\w][\w./-]*\.md)\b/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(content)) !== null) {
    const refPath = m[1];
    if (seen.has(refPath)) continue;
    seen.add(refPath);

    const posix = toPosix(refPath);
    if (fileSet.has(posix) && posix !== filePath) {
      edges.push(compositionEdge(filePath, posix, "ref:path", 0.70, refPath));
    }
  }

  return edges;
}

// ── Main inference function ──

export async function inferMdRelations(
  filePaths: string[],
  fileSet: Set<string>,
  nameMaps: MdNameMaps,
  projectDir: string,
): Promise<GraphEdge[]> {
  const allEdges: GraphEdge[] = [];

  for (const fp of filePaths) {
    if (!fp.endsWith(".md") || isExcludedDoc(fp)) continue;
    if (!classifyMdNode(fp)) continue;

    let content: string;
    try {
      content = await readFile(join(projectDir, fp), "utf-8");
    } catch (err: unknown) {
      if (isNotFound(err)) continue;
      throw err;
    }

    const { body } = parseFrontmatter(content);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const frontmatterText = fmMatch ? fmMatch[1] : "";

    // Three generic passes — same for all .md file types
    if (frontmatterText) {
      allEdges.push(...extractFrontmatterEdges(fp, frontmatterText, nameMaps, fileSet));
    }
    allEdges.push(...extractBacktickEdges(fp, body, nameMaps));
    allEdges.push(...extractPathEdges(fp, content, fileSet));
  }

  // Deduplicate: keep highest confidence per source|target|relation
  const byKey = new Map<string, GraphEdge>();
  for (const edge of allEdges) {
    const key = `${edge.source}|${edge.target}|${edge.relation}`;
    const existing = byKey.get(key);
    if (!existing || (edge.confidence || 0) > (existing.confidence || 0)) {
      byKey.set(key, edge);
    }
  }

  return Array.from(byKey.values());
}
