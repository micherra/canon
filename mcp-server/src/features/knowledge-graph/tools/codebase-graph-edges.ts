/**
 * Codebase Graph — Edge Building
 *
 * Extracted from codebase-graph.ts: import edge extraction, composition edge
 * detection, and edge merging helpers.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractImports, type PathAlias, resolveImport } from "@graph/import-parser.ts";
import { buildNameMaps, inferMdRelations } from "@graph/md-relations.ts";
import { loadGraphCompositionConfig } from "@shared/lib/config.ts";
import { isNotFound } from "@shared/lib/errors.ts";
import { toPosix } from "@shared/lib/paths.ts";
import type { GraphEdge } from "./codebase-graph.ts";

export const FALLBACK_LAYER_COLOR = "#BDC3C7";

export function colorFromLayerName(layer: string): string {
  // Deterministic hash-to-color mapping so custom layer names remain stable.
  let hash = 0;
  for (let i = 0; i < layer.length; i++) {
    hash = (hash * 31 + layer.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 62%, 56%)`;
}

/** Build import edges by reading each file and resolving imports. */
export async function buildEdges(
  filePaths: string[],
  fileSet: Set<string>,
  aliases: PathAlias[],
  projectDir: string,
): Promise<GraphEdge[]> {
  const fileEdges = await Promise.all(
    filePaths.map(async (filePath): Promise<GraphEdge[]> => {
      try {
        const content = await readFile(join(projectDir, filePath), "utf-8");
        const imports = extractImports(content, filePath);
        return imports
          .map((imp) => resolveImport(imp, filePath, fileSet, aliases))
          .filter((resolved): resolved is string => resolved !== null && resolved !== filePath)
          .map((resolved) => ({ source: filePath, target: resolved, type: "import" as const }));
      } catch (err: unknown) {
        if (isNotFound(err)) return [];
        throw err;
      }
    }),
  );
  return fileEdges.flat();
}

export function shouldInspectForComposition(path: string, patterns: string[]): boolean {
  const lower = path.toLowerCase();
  return patterns.some((pattern) => lower.endsWith(pattern.toLowerCase()));
}

/** Try to find a candidate path in the file set, including with common extensions. */
export function findInFileSet(candidate: string, fileSet: Set<string>): string | null {
  if (fileSet.has(candidate)) return candidate;
  for (const ext of [".md", ".yaml", ".yml", ".json"]) {
    if (fileSet.has(`${candidate}${ext}`)) return `${candidate}${ext}`;
  }
  return null;
}

export function resolveCompositionTarget(
  rawRef: string,
  sourcePath: string,
  fileSet: Set<string>,
): string | null {
  const normalized = toPosix(rawRef.trim().replace(/^['"]|['"]$/g, ""));
  if (!normalized) return null;

  const candidates = new Set<string>();
  candidates.add(normalized);
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    const sourceDir = sourcePath.split("/").slice(0, -1).join("/");
    candidates.add(toPosix(join(sourceDir, normalized)));
  }
  candidates.add(normalized.replace(/^\.?\//, ""));

  for (const candidate of candidates) {
    const found = findInFileSet(candidate, fileSet);
    if (found) return found;
  }
  return null;
}

/** Options for upserting a composition edge. */
export type UpsertCompositionEdgeOptions = {
  fileSet: Set<string>;
  confidence: number;
  minConfidence: number;
  evidence: string;
};

/** Try to add or update a composition edge in the edge map. */
export function upsertCompositionEdge(
  edgesByKey: Map<string, GraphEdge>,
  source: string,
  rawRef: string,
  options: UpsertCompositionEdgeOptions,
): void {
  const { fileSet, confidence, minConfidence, evidence } = options;
  const target = resolveCompositionTarget(rawRef, source, fileSet);
  if (!target || target === source) return;
  if (confidence < minConfidence) return;
  const key = `${source}|${target}|composition`;
  const existing = edgesByKey.get(key);
  if (!existing || (existing.confidence || 0) < confidence) {
    edgesByKey.set(key, {
      confidence,
      evidence: evidence.trim().slice(0, 140),
      origin: "inferred-llm",
      source,
      target,
      type: "composition",
    });
  }
}

/** Options for extracting composition edges from file content. */
export type ExtractCompositionOptions = {
  fileSet: Set<string>;
  markerRegex: RegExp | null;
  maxRefs: number;
  minConfidence: number;
  edgesByKey: Map<string, GraphEdge>;
};

/** Extract composition edges from a single file's content using marker and interpolation regexes. */
export function extractCompositionEdgesFromContent(
  filePath: string,
  content: string,
  options: ExtractCompositionOptions,
): void {
  const { fileSet, markerRegex, maxRefs, minConfidence, edgesByKey } = options;
  let refCount = 0;

  if (markerRegex) {
    markerRegex.lastIndex = 0;
    let match = markerRegex.exec(content);
    while (match !== null) {
      if (refCount >= maxRefs) return;
      refCount += 1;
      upsertCompositionEdge(edgesByKey, filePath, match[1], {
        confidence: 0.9,
        evidence: match[0],
        fileSet,
        minConfidence,
      });
      match = markerRegex.exec(content);
    }
  }

  const interpolationRegex = /\{\{\s*([\w./-]+)\s*\}\}/g;
  let interpolationMatch = interpolationRegex.exec(content);
  while (interpolationMatch !== null) {
    if (refCount >= maxRefs) return;
    refCount += 1;
    upsertCompositionEdge(edgesByKey, filePath, interpolationMatch[1], {
      confidence: 0.75,
      evidence: interpolationMatch[0],
      fileSet,
      minConfidence,
    });
    interpolationMatch = interpolationRegex.exec(content);
  }
}

export async function buildCompositionEdges(
  filePaths: string[],
  fileSet: Set<string>,
  projectDir: string,
): Promise<GraphEdge[]> {
  const compositionConfig = await loadGraphCompositionConfig(projectDir);
  if (!compositionConfig.enabled) return [];

  const markerAlternation = compositionConfig.markers
    .map((marker: string) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const markerRegex =
    markerAlternation.length > 0
      ? new RegExp(`(?:${markerAlternation})\\s*[:=]\\s*["']?([\\w./-]+)["']?`, "gi")
      : null;

  const activePaths = filePaths.filter((fp) =>
    shouldInspectForComposition(fp, compositionConfig.file_patterns),
  );

  const perFileEdges = await Promise.all(
    activePaths.map(async (filePath) => {
      let content = "";
      try {
        content = await readFile(join(projectDir, filePath), "utf-8");
      } catch (err: unknown) {
        if (isNotFound(err)) return new Map<string, GraphEdge>();
        throw err;
      }
      const edgesByKey = new Map<string, GraphEdge>();
      extractCompositionEdgesFromContent(filePath, content, {
        edgesByKey,
        fileSet,
        markerRegex,
        maxRefs: compositionConfig.max_refs_per_file,
        minConfidence: compositionConfig.min_confidence,
      });
      return edgesByKey;
    }),
  );

  const merged = new Map<string, GraphEdge>();
  for (const fileMap of perFileEdges) {
    for (const [key, edge] of fileMap) {
      if (!merged.has(key)) merged.set(key, edge);
    }
  }
  return Array.from(merged.values());
}

export function mergeEdges(baseEdges: GraphEdge[], inferredEdges: GraphEdge[]): GraphEdge[] {
  const byKey = new Map<string, GraphEdge>();
  for (const edge of baseEdges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    byKey.set(key, edge);
  }
  for (const edge of inferredEdges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, edge);
      continue;
    }
    if ((edge.confidence || 0) > (existing.confidence || 0)) {
      byKey.set(key, edge);
    }
  }
  return Array.from(byKey.values());
}

/** Build supplemental edges from legacy scanners (aliases, composition, markdown). */
export async function buildSupplementalEdges(
  filePaths: string[],
  fileSet: Set<string>,
  projectDir: string,
): Promise<GraphEdge[]> {
  const { loadPathAliases } = await import("@shared/lib/paths.ts");
  const aliases = await loadPathAliases(projectDir);
  const importEdges = await buildEdges(filePaths, fileSet, aliases, projectDir);
  const compositionEdges = await buildCompositionEdges(filePaths, fileSet, projectDir);
  const nameMaps = await buildNameMaps(filePaths, projectDir);
  const mdEdges = await inferMdRelations(filePaths, fileSet, nameMaps, projectDir);
  return mergeEdges(importEdges, mergeEdges(compositionEdges, mdEdges));
}
