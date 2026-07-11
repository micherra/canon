/**
 * kg-context-ingest.ts
 *
 * Derives context nodes/edges from a decisions array + ADR files under
 * `pluginDir/docs/adr`, then persists them via ContextGraphStore.replaceAll.
 * Mirrors kg-doc-ingest.ts's fail-open-per-source posture — a missing dir or
 * a malformed file is logged and skipped, never thrown — minus the embed
 * phase (the context graph has no vectors).
 *
 * command-query-separation: node/edge derivation below is pure; the single
 * `store.replaceAll(...)` call is the sole effect.
 *
 * Boundary note: this module intentionally does NOT call
 * `buildDecisionsCorpus` itself. `.dependency-cruiser.cjs`'s
 * `no-graph-to-orchestration` rule forbids any `src/graph/**` module from
 * importing `src/features/orchestration/**` (that corpus reader lives at
 * `@features/orchestration/services/decisions-corpus.ts`). Instead,
 * `ingestContextGraph` takes the already-computed decisions array as a
 * parameter — the composition-root caller (`app/register-knowledge.ts`)
 * resolves the corpus and passes it in, exactly like `recall-handler.ts`'s
 * sibling pattern already does for the `recall` tool.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ContextEdge, ContextGraphStore, type ContextNode } from "@graph/kg-context-store.ts";
import { CANON_DIR } from "@shared/constants.ts";
import { splitFrontmatter } from "@shared/lib/frontmatter.ts";
import type Database from "better-sqlite3";

/**
 * The minimal shape ingest needs from a decisions-corpus record. Structurally
 * compatible with (a subset of) `CorpusDecision` — passing a real
 * `CorpusDecision[]` here works by duck typing, with no import edge to
 * `features/orchestration/` (see module docstring).
 */
export type IngestableDecision = {
  source_slug: string;
  source_event_id: number;
  decided_at: string;
  decision_type: string;
  summary: string;
  refs?: string[];
};

type AdrRecord = {
  filename: string;
  adrNumber: string;
  title: string;
  status: string | null;
  build: string | null;
  supersedes: string | null;
  date: string | null;
  body: string;
};

// Real ADRs follow the `NNNN-slug.md` convention — excludes `docs/adr/TEMPLATE.md`
// and `docs/adr/README.md` without special-casing them by name. Mirrors the same
// filename grammar as `app/recall-adr-source.ts` (duplicated, not imported — see
// module docstring on why `graph/` cannot depend on `app/`).
const ADR_FILENAME_RE = /^\d{4}-.+\.md$/;

const PRINCIPLE_SUBDIRS = ["rules", "strong-opinions", "conventions"];

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

// ADR reading

/** Read a frontmatter field as a non-empty string, else `null`. Only a structured
 *  string counts (DEC-M2-04) — YAML `~`/absent parse to non-string, correctly
 *  excluded here. */
function readOptionalString(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Parse one ADR file's frontmatter + body. Returns `null` on any read/parse failure. */
function parseAdrFile(adrDir: string, filename: string): AdrRecord | null {
  try {
    const raw = readFileSync(join(adrDir, filename), "utf8");
    const { data, body } = splitFrontmatter(raw);
    const stem = filename.replace(/\.md$/, "");
    const heading = /^#\s+(.+)$/m.exec(body);
    return {
      adrNumber: readOptionalString(data, "adr") ?? stem,
      body,
      build: readOptionalString(data, "build"),
      date: readOptionalString(data, "date"),
      filename,
      status: readOptionalString(data, "status"),
      supersedes: typeof data.supersedes === "string" ? data.supersedes : null,
      title: readOptionalString(data, "title") ?? heading?.[1].trim() ?? stem,
    };
  } catch (err) {
    console.warn(`[kg-context-ingest] failed to parse ADR ${filename}: ${String(err)}`);
    return null;
  }
}

/** Read and parse all `NNNN-slug.md` files under `pluginDir/docs/adr`. Fail-open. */
function readAdrFiles(pluginDir: string): AdrRecord[] {
  const adrDir = join(pluginDir, "docs", "adr");
  if (!existsSync(adrDir)) return [];

  let filenames: string[];
  try {
    filenames = readdirSync(adrDir).filter((f) => ADR_FILENAME_RE.test(f));
  } catch (err) {
    console.warn(`[kg-context-ingest] failed to read ADR dir ${adrDir}: ${String(err)}`);
    return [];
  }

  const records: AdrRecord[] = [];
  for (const filename of filenames) {
    const record = parseAdrFile(adrDir, filename);
    if (record) records.push(record);
  }
  return records;
}

/** Parse the leading `NNNN` ADR number out of a free-form `supersedes:` value. */
function parseSupersedesNumber(supersedes: string | null): string | null {
  if (!supersedes) return null;
  const m = /^\s*(\d{3,4})/.exec(supersedes);
  return m ? m[1] : null;
}

/** Extract backtick-quoted, slash-containing path candidates from ADR prose. */
function extractBacktickPaths(body: string): string[] {
  const matches = body.match(/`([^`\s]+\/[^`\s]+)`/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

/**
 * Strip a trailing `:<line>` or `:<line>-<line>` citation suffix from a
 * cited path (`foo/bar.ts:13` -> `foo/bar.ts`, `foo/bar.ts:13-20` ->
 * `foo/bar.ts`). ADRs and decisions commonly cite a specific line/range
 * (see docs/adr/0001, 0007, 0031, 0035, 0036, 0040) — an EXACT
 * `filePaths.has(path)` match never fires against the bare KG row
 * otherwise (PR #487 review fix). Only a numeric-only suffix after the
 * FINAL colon, anchored to the end of the string, is recognized — this
 * never strips a colon that's part of the path itself.
 */
function stripLineSuffix(path: string): string {
  const m = /^(.*):\d+(?:-\d+)?$/.exec(path);
  return m ? m[1] : path;
}

// Principle-id scanning

/** Add one principle file's frontmatter `id:` to `ids`, if present. Fail-open. */
function addPrincipleIdFromFile(dir: string, filename: string, ids: Set<string>): void {
  try {
    const raw = readFileSync(join(dir, filename), "utf8");
    const { data } = splitFrontmatter(raw);
    const id = readOptionalString(data, "id");
    if (id) ids.add(id);
  } catch {
    // malformed principle file — skip, never abort the scan
  }
}

/** Scan one severity subdir (`rules`|`strong-opinions`|`conventions`) for frontmatter `id:` values. Fail-open. */
function scanPrincipleIdsFromDir(dir: string, ids: Set<string>): void {
  if (!existsSync(dir)) return;
  let filenames: string[];
  try {
    filenames = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch (err) {
    console.warn(`[kg-context-ingest] failed to read principle dir ${dir}: ${String(err)}`);
    return;
  }
  for (const filename of filenames) {
    addPrincipleIdFromFile(dir, filename, ids);
  }
}

/** Scan one `principles/{rules,strong-opinions,conventions}` root for frontmatter `id:` values. Fail-open. */
function scanPrincipleIdsFromRoot(root: string, ids: Set<string>): void {
  for (const sub of PRINCIPLE_SUBDIRS) {
    scanPrincipleIdsFromDir(join(root, sub), ids);
  }
}

/** Load the shipped principle-id set from both the plugin and project-overlay roots. */
function scanPrincipleIds(projectDir: string, pluginDir: string): Set<string> {
  const ids = new Set<string>();
  scanPrincipleIdsFromRoot(join(pluginDir, "principles"), ids);
  scanPrincipleIdsFromRoot(join(projectDir, CANON_DIR, "principles"), ids);
  return ids;
}

/** Return every principle id that appears as a substring of `text` (case-insensitive). */
function matchPrincipleIds(text: string, ids: Set<string>): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const id of ids) {
    if (lower.includes(id.toLowerCase())) hits.push(id);
  }
  return hits;
}

function readFilePaths(db: Database.Database): Set<string> {
  const rows = db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>;
  return new Set(rows.map((r) => r.path));
}

// Public entry point

/**
 * Ingest the context graph: decision/adr/build nodes plus the four typed
 * edges (`decision_touches_file`, `decision_cites_principle`, `supersedes`,
 * `build_produced`), derived from `decisions` + `pluginDir/docs/adr/*.md`.
 *
 * Pure-derive, then one `store.replaceAll(...)` write. Fail-open per source:
 * a missing/unreadable ADR dir, a malformed ADR frontmatter, or a malformed
 * principle file is `console.warn`-logged and skipped — never thrown.
 */
type DerivedRecord = { node: ContextNode; edges: ContextEdge[]; buildSlug: string | null };

/** Derive one decision's node + its edges. `null` on failure — logged, never thrown. */
function deriveDecisionRecord(
  d: IngestableDecision,
  filePaths: Set<string>,
  principleIds: Set<string>,
): DerivedRecord | null {
  try {
    const nodeId = `decision:${d.source_slug}#${d.source_event_id}`;
    const node: ContextNode = {
      adr_number: null,
      body_excerpt: truncate(d.summary, 300),
      node_id: nodeId,
      record_kind: "decision",
      ref_slug: d.source_slug,
      source_event_id: d.source_event_id,
      status: null,
      title: truncate(d.summary, 120),
      updated_at: d.decided_at,
    };

    const edges: ContextEdge[] = [];
    for (const ref of d.refs ?? []) {
      const barePath = stripLineSuffix(ref);
      if (filePaths.has(barePath)) {
        edges.push({
          dst: barePath,
          edge_type: "decision_touches_file",
          evidence: "refs",
          src: nodeId,
        });
      }
    }
    const citedText = `${d.summary} ${(d.refs ?? []).join(" ")}`;
    for (const principleId of matchPrincipleIds(citedText, principleIds)) {
      edges.push({
        dst: principleId,
        edge_type: "decision_cites_principle",
        evidence: "summary/refs",
        src: nodeId,
      });
    }
    edges.push({
      dst: nodeId,
      edge_type: "build_produced",
      evidence: "source_slug",
      src: `build:${d.source_slug}`,
    });

    return { buildSlug: d.source_slug, edges, node };
  } catch (err) {
    console.warn(
      `[kg-context-ingest] error deriving decision ${d.source_slug}#${d.source_event_id}: ${String(err)}`,
    );
    return null;
  }
}

/** Derive one ADR's node + its edges. `null` on failure — logged, never thrown. */
function deriveAdrRecord(
  adr: AdrRecord,
  filePaths: Set<string>,
  principleIds: Set<string>,
): DerivedRecord | null {
  try {
    const nodeId = `adr:ADR-${adr.adrNumber}`;
    const node: ContextNode = {
      adr_number: adr.adrNumber,
      body_excerpt: truncate(adr.body.trim(), 300),
      node_id: nodeId,
      record_kind: "adr",
      ref_slug: null,
      source_event_id: null,
      status: adr.status,
      title: adr.title,
      updated_at: adr.date ?? new Date().toISOString(),
    };

    const edges: ContextEdge[] = [];
    for (const path of extractBacktickPaths(adr.body)) {
      const barePath = stripLineSuffix(path);
      if (filePaths.has(barePath)) {
        edges.push({
          dst: barePath,
          edge_type: "decision_touches_file",
          evidence: "adr-body-path",
          src: nodeId,
        });
      }
    }
    for (const principleId of matchPrincipleIds(adr.body, principleIds)) {
      edges.push({
        dst: principleId,
        edge_type: "decision_cites_principle",
        evidence: "adr-body",
        src: nodeId,
      });
    }
    const supersededNumber = parseSupersedesNumber(adr.supersedes);
    if (supersededNumber) {
      edges.push({
        dst: `adr:ADR-${supersededNumber}`,
        edge_type: "supersedes",
        evidence: "frontmatter",
        src: nodeId,
      });
    }
    if (adr.build) {
      edges.push({
        dst: nodeId,
        edge_type: "build_produced",
        evidence: "frontmatter build",
        src: `build:${adr.build}`,
      });
    }

    return { buildSlug: adr.build, edges, node };
  } catch (err) {
    console.warn(`[kg-context-ingest] error deriving ADR ${adr.filename}: ${String(err)}`);
    return null;
  }
}

/**
 * Dedupe nodes by `node_id`, first occurrence wins. `context_nodes.node_id`
 * is a PRIMARY KEY — a data-quality duplicate upstream (e.g. the same
 * decision appearing twice in the corpus) must not throw on the bulk
 * reinsert (review fix, explicit-transaction-boundaries).
 */
function dedupeNodes(nodes: ContextNode[]): ContextNode[] {
  const seen = new Set<string>();
  const result: ContextNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.node_id)) continue;
    seen.add(node.node_id);
    result.push(node);
  }
  return result;
}

/**
 * Dedupe edges by the composite key `(src, dst, edge_type)` — the exact
 * `context_edges` PRIMARY KEY — first occurrence wins. A single source can
 * legitimately derive the same edge twice (a duplicate `refs` entry, the
 * same path cited twice in ADR prose); without this, the bulk reinsert
 * throws a UNIQUE-constraint error, which `ensureContextGraphFresh`'s
 * fail-open swallows — silently re-triggering ingest on every context query
 * instead of a one-time fix (review fix, explicit-transaction-boundaries).
 */
function dedupeEdges(edges: ContextEdge[]): ContextEdge[] {
  const seen = new Set<string>();
  const result: ContextEdge[] = [];
  for (const edge of edges) {
    // \0-joined (escape sequence, not a raw byte) — src/dst may be file
    // paths, which can (rarely) contain spaces; NUL cannot appear in a
    // node_id or a real filesystem path. A literal NUL byte in the SOURCE
    // FILE previously made this file misdetect as binary to line-oriented
    // tools (grep, some IDE parsers) — the escape sequence produces the
    // identical runtime string with zero source-file control characters.
    const key = `${edge.src}\0${edge.dst}\0${edge.edge_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function buildBuildNode(slug: string): ContextNode {
  return {
    adr_number: null,
    body_excerpt: null,
    node_id: `build:${slug}`,
    record_kind: "build",
    ref_slug: slug,
    source_event_id: null,
    status: null,
    title: slug,
    updated_at: new Date().toISOString(),
  };
}

export function ingestContextGraph(
  db: Database.Database,
  decisions: IngestableDecision[],
  projectDir: string,
  pluginDir: string,
): { node_count: number; edge_count: number } {
  const store = new ContextGraphStore(db);
  const filePaths = readFilePaths(db);
  const principleIds = scanPrincipleIds(projectDir, pluginDir);
  const adrRecords = readAdrFiles(pluginDir);

  const nodes: ContextNode[] = [];
  const edges: ContextEdge[] = [];
  const buildSlugs = new Set<string>();

  for (const d of decisions) {
    const derived = deriveDecisionRecord(d, filePaths, principleIds);
    if (!derived) continue;
    nodes.push(derived.node);
    edges.push(...derived.edges);
    if (derived.buildSlug) buildSlugs.add(derived.buildSlug);
  }

  for (const adr of adrRecords) {
    const derived = deriveAdrRecord(adr, filePaths, principleIds);
    if (!derived) continue;
    nodes.push(derived.node);
    edges.push(...derived.edges);
    if (derived.buildSlug) buildSlugs.add(derived.buildSlug);
  }

  for (const slug of buildSlugs) {
    nodes.push(buildBuildNode(slug));
  }

  // Dedupe at the derivation boundary, before the store's strict insert
  // (review fix): `context_nodes`/`context_edges` have PRIMARY KEYs, and
  // ContextGraphStore.replaceAll intentionally does NOT use `INSERT OR
  // IGNORE` — a genuine duplicate elsewhere would then be masked instead of
  // surfacing as a real bug.
  const dedupedNodes = dedupeNodes(nodes);
  const dedupedEdges = dedupeEdges(edges);

  store.replaceAll(dedupedNodes, dedupedEdges);
  return { edge_count: dedupedEdges.length, node_count: dedupedNodes.length };
}
