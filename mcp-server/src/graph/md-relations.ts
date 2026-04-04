import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../parser.ts";
import type { GraphEdge } from "../tools/codebase-graph.ts";
import { isNotFound } from "../utils/errors.ts";
import { toPosix } from "../utils/paths.ts";

export type MdNodeKind = string; // e.g. "flow", "agent", "principle" — derived from directory

export type MdNameMaps = {
  /** frontmatter `id:` or `name:` → file path */
  byId: Map<string, string>;
  /** filename stem (without .md) → file path */
  byStem: Map<string, string>;
};

export type MdKindRule = {
  /** Directory prefix to match (e.g. "agents/") */
  prefix: string;
  /** Kind label assigned to matching files */
  kind: string;
};

const EXCLUDED_DOCS = new Set(["CLAUDE.md", "SCHEMA.md", "GATES.md", "README.md"]);

function isExcludedDoc(filePath: string): boolean {
  return EXCLUDED_DOCS.has(basename(filePath));
}

/** Default kind rules — can be overridden via config in the future. */
const DEFAULT_KIND_RULES: MdKindRule[] = [
  { kind: "fragment", prefix: "flows/fragments/" },
  { kind: "flow", prefix: "flows/" },
  { kind: "agent", prefix: "agents/" },
  { kind: "template", prefix: "templates/" },
  { kind: "principle", prefix: "principles/" },
  { kind: "principle", prefix: ".canon/principles/" },
  { kind: "skill", prefix: "skills/" },
  { kind: "command", prefix: "commands/" },
];

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

/**
 * Build universal lookup maps from all .md files.
 * - `byId`: frontmatter `id:` or `name:` field → file path
 * - `byStem`: filename stem → file path (last-writer-wins for collisions)
 */
export async function buildNameMaps(filePaths: string[], projectDir: string): Promise<MdNameMaps> {
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

/** Try to resolve a name to a file path via ID map, then stem map. */
function resolveName(name: string, maps: MdNameMaps): string | undefined {
  return maps.byId.get(name) ?? maps.byStem.get(name);
}

type CompositionEdgeParams = {
  relation: string;
  confidence: number;
  evidence: string;
};

function compositionEdge(source: string, target: string, params: CompositionEdgeParams): GraphEdge {
  return {
    confidence: params.confidence,
    evidence: params.evidence.slice(0, 140),
    origin: "inferred-llm",
    relation: params.relation,
    source,
    target,
    type: "composition",
  };
}

/**
 * Extract edges from frontmatter values.
 * For each frontmatter field, if the value is a string or string[],
 * try to resolve each value as a file reference via name maps.
 * The relation is derived from the field name (e.g., "agent" → "fm:agent").
 */
type FmEdgeContext = {
  maps: MdNameMaps;
  seen: Set<string>;
  edges: GraphEdge[];
};

type FmMatch = {
  field: string;
  value: string;
  confidence: number;
  evidence: string;
};

/** Try to add a single frontmatter edge if the value resolves. */
function tryAddFmEdge(filePath: string, match: FmMatch, ctx: FmEdgeContext): void {
  const { field, value, confidence, evidence } = match;
  const target = resolveName(value, ctx.maps);
  if (!target || target === filePath || ctx.seen.has(`${field}:${target}`)) return;
  ctx.seen.add(`${field}:${target}`);
  ctx.edges.push(
    compositionEdge(filePath, target, { confidence, evidence, relation: `fm:${field}` }),
  );
}

function extractFrontmatterEdges(
  filePath: string,
  frontmatterText: string,
  maps: MdNameMaps,
  _fileSet: Set<string>,
): GraphEdge[] {
  const ctx: FmEdgeContext = { edges: [], maps, seen: new Set<string>() };

  // Match `key: value` (single values)
  const singleRe = /^[ \t]*(\w[\w-]*):\s*["']?([a-z][\w-]*)["']?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = singleRe.exec(frontmatterText)) !== null) {
    tryAddFmEdge(
      filePath,
      { confidence: 0.9, evidence: `${m[1]}: ${m[2]}`, field: m[1], value: m[2] },
      ctx,
    );
  }

  // Match `key: [val1, val2, ...]` (inline arrays)
  const listRe = /^[ \t]*(\w[\w-]*):\s*\[([^\]]+)\]/gm;
  while ((m = listRe.exec(frontmatterText)) !== null) {
    const [, field, rawList] = m;
    const items = rawList
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    for (const item of items) {
      tryAddFmEdge(
        filePath,
        { confidence: 0.85, evidence: `${field}: [${item}]`, field, value: item },
        ctx,
      );
    }
  }

  // Match `- key: value` patterns inside nested structures
  const nestedRe = /^[ \t]*-?\s*(\w[\w-]*):\s*["']?([a-z][\w-]*)["']?\s*$/gm;
  while ((m = nestedRe.exec(frontmatterText)) !== null) {
    tryAddFmEdge(
      filePath,
      { confidence: 0.9, evidence: `${m[1]}: ${m[2]}`, field: m[1], value: m[2] },
      ctx,
    );
  }

  return ctx.edges;
}

/**
 * Extract edges from backtick-quoted identifiers in body text.
 * Resolves `identifier` via ID map then stem map.
 */
function extractBacktickEdges(filePath: string, body: string, maps: MdNameMaps): GraphEdge[] {
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
      edges.push(
        compositionEdge(filePath, target, {
          confidence: 0.8,
          evidence: `\`${id}\``,
          relation: "ref:id",
        }),
      );
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
function extractPathEdges(filePath: string, content: string, fileSet: Set<string>): GraphEdge[] {
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
      edges.push(
        compositionEdge(filePath, posix, {
          confidence: 0.7,
          evidence: refPath,
          relation: "ref:path",
        }),
      );
    }
  }

  return edges;
}

/** Extract all edges from a single markdown file. */
async function extractMdFileEdges(
  fp: string,
  fileSet: Set<string>,
  nameMaps: MdNameMaps,
  projectDir: string,
): Promise<GraphEdge[]> {
  let content: string;
  try {
    content = await readFile(join(projectDir, fp), "utf-8");
  } catch (err: unknown) {
    if (isNotFound(err)) return [];
    throw err;
  }

  const { body } = parseFrontmatter(content);
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatterText = fmMatch ? fmMatch[1] : "";

  const edges: GraphEdge[] = [];
  if (frontmatterText) {
    edges.push(...extractFrontmatterEdges(fp, frontmatterText, nameMaps, fileSet));
  }
  edges.push(...extractBacktickEdges(fp, body, nameMaps));
  edges.push(...extractPathEdges(fp, content, fileSet));
  return edges;
}

/** Deduplicate edges, keeping highest confidence per source|target|relation. */
function deduplicateEdges(edges: GraphEdge[]): GraphEdge[] {
  const byKey = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = `${edge.source}|${edge.target}|${edge.relation}`;
    const existing = byKey.get(key);
    if (!existing || (edge.confidence || 0) > (existing.confidence || 0)) {
      byKey.set(key, edge);
    }
  }
  return Array.from(byKey.values());
}

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
    allEdges.push(...(await extractMdFileEdges(fp, fileSet, nameMaps, projectDir)));
  }

  return deduplicateEdges(allEdges);
}
