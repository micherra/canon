import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../parser.ts";
import type { GraphEdge } from "../tools/codebase-graph.ts";
import { isNotFound } from "../utils/errors.ts";
import { toPosix } from "../utils/paths.ts";

// ── Types ──

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

// ── Defaults ──

const EXCLUDED_DOCS = new Set(["CLAUDE.md", "SCHEMA.md", "GATES.md", "README.md"]);

function isExcludedDoc(filePath: string): boolean {
  return EXCLUDED_DOCS.has(basename(filePath));
}

/** Default kind rules — can be overridden via config in the future. */
const DEFAULT_KIND_RULES: MdKindRule[] = [
  { kind: "fragment", prefix: "flows/fragments/" },
  { kind: "flow", prefix: "flows/" },
  { kind: "agent", prefix: ".claude/agents/" },
  { kind: "template", prefix: "templates/" },
  { kind: "principle", prefix: "principles/" },
  { kind: "principle", prefix: ".canon/principles/" },
  { kind: "command", prefix: "skills/canon/commands/" },
  { kind: "skill", prefix: "skills/" },
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

// ── Resolution ──

/** Try to resolve a name to a file path via ID map, then stem map. */
function resolveName(name: string, maps: MdNameMaps): string | undefined {
  return maps.byId.get(name) ?? maps.byStem.get(name);
}

// ── Edge construction ──

type CompositionEdgeOpts = {
  source: string;
  target: string;
  relation: string;
  confidence: number;
  evidence: string;
};

function compositionEdge(opts: CompositionEdgeOpts): GraphEdge {
  return {
    confidence: opts.confidence,
    evidence: opts.evidence.slice(0, 140),
    origin: "inferred-llm",
    relation: opts.relation,
    source: opts.source,
    target: opts.target,
    type: "composition",
  };
}

// ── Generic extractors ──

type FmEdgeCtx = { edges: GraphEdge[]; filePath: string; maps: MdNameMaps; seen: Set<string> };
type FmEdgeSpec = { confidence: number; evidence: string; field: string; target: string };

/** Add a deduped edge for a resolved field:value pair. */
function pushFmEdge(ctx: FmEdgeCtx, spec: FmEdgeSpec): void {
  const key = `${spec.field}:${spec.target}`;
  if (spec.target === ctx.filePath || ctx.seen.has(key)) return;
  ctx.seen.add(key);
  ctx.edges.push(
    compositionEdge({
      confidence: spec.confidence,
      evidence: spec.evidence,
      relation: `fm:${spec.field}`,
      source: ctx.filePath,
      target: spec.target,
    }),
  );
}

/** Extract single-value frontmatter edges: `key: value` */
function extractSingleValueEdges(ctx: FmEdgeCtx, frontmatterText: string): void {
  const singleRe = /^[ \t]*(\w[\w-]*):\s*["']?([a-z][\w-]*)["']?\s*$/gm;
  let m = singleRe.exec(frontmatterText);
  while (m !== null) {
    const [, field, value] = m;
    const target = resolveName(value, ctx.maps);
    if (target) pushFmEdge(ctx, { confidence: 0.9, evidence: `${field}: ${value}`, field, target });
    m = singleRe.exec(frontmatterText);
  }
}

/** Extract inline-array frontmatter edges: `key: [val1, val2]` */
function extractListValueEdges(ctx: FmEdgeCtx, frontmatterText: string): void {
  const listRe = /^[ \t]*(\w[\w-]*):\s*\[([^\]]+)\]/gm;
  let m = listRe.exec(frontmatterText);
  while (m !== null) {
    const [, field, rawList] = m;
    const items = rawList
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    for (const item of items) {
      const target = resolveName(item, ctx.maps);
      if (target)
        pushFmEdge(ctx, { confidence: 0.85, evidence: `${field}: [${item}]`, field, target });
    }
    m = listRe.exec(frontmatterText);
  }
}

/** Extract nested-structure frontmatter edges: `- key: value` */
function extractNestedValueEdges(ctx: FmEdgeCtx, frontmatterText: string): void {
  const nestedRe = /^[ \t]*-?\s*(\w[\w-]*):\s*["']?([a-z][\w-]*)["']?\s*$/gm;
  let m = nestedRe.exec(frontmatterText);
  while (m !== null) {
    const [, field, value] = m;
    const target = resolveName(value, ctx.maps);
    if (target) pushFmEdge(ctx, { confidence: 0.9, evidence: `${field}: ${value}`, field, target });
    m = nestedRe.exec(frontmatterText);
  }
}

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
  const ctx: FmEdgeCtx = { edges: [], filePath, maps, seen: new Set<string>() };
  extractSingleValueEdges(ctx, frontmatterText);
  extractListValueEdges(ctx, frontmatterText);
  extractNestedValueEdges(ctx, frontmatterText);
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
  let m = backtickRe.exec(body);
  while (m !== null) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      const target = resolveName(id, maps);
      if (target && target !== filePath) {
        edges.push(
          compositionEdge({
            confidence: 0.8,
            evidence: `\`${id}\``,
            relation: "ref:id",
            source: filePath,
            target,
          }),
        );
      }
    }
    m = backtickRe.exec(body);
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
  let m = pathRe.exec(content);
  while (m !== null) {
    const refPath = m[1];
    if (!seen.has(refPath)) {
      seen.add(refPath);

      const posix = toPosix(refPath);
      if (fileSet.has(posix) && posix !== filePath) {
        edges.push(
          compositionEdge({
            confidence: 0.7,
            evidence: refPath,
            relation: "ref:path",
            source: filePath,
            target: posix,
          }),
        );
      }
    }
    m = pathRe.exec(content);
  }

  return edges;
}

// ── Main inference function ──

/** Extract all edges from a single .md file's content. */
function extractEdgesFromFile(
  fp: string,
  content: string,
  fileSet: Set<string>,
  nameMaps: MdNameMaps,
): GraphEdge[] {
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

/** Deduplicate edges: keep highest confidence per source|target|relation. */
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
  const activePaths = filePaths.filter(
    (fp) => fp.endsWith(".md") && !isExcludedDoc(fp) && classifyMdNode(fp),
  );

  const fileContents = await Promise.all(
    activePaths.map(async (fp) => {
      try {
        const content = await readFile(join(projectDir, fp), "utf-8");
        return { content, fp };
      } catch (err: unknown) {
        if (isNotFound(err)) return null;
        throw err;
      }
    }),
  );

  const allEdges: GraphEdge[] = [];
  for (const entry of fileContents) {
    if (entry) {
      allEdges.push(...extractEdgesFromFile(entry.fp, entry.content, fileSet, nameMaps));
    }
  }

  return deduplicateEdges(allEdges);
}
