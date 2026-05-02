import { existsSync } from "node:fs";
import { join } from "node:path";
import { KgQuery } from "@graph/kg-query.ts";
import { computeFileInsightMaps } from "@graph/kg-query-insights.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import type { FileMetrics } from "@graph/kg-types.ts";
import { CANON_DIR, CANON_FILES, extractSummary } from "@shared/constants.ts";
import { loadConfigNumber } from "@shared/lib/config.ts";
import { loadAllPrinciples, matchPrinciples } from "@shared/matcher.ts";
import { filterBodyBySections } from "@shared/parser.ts";

export type GetPrinciplesInput = {
  file_path?: string;
  layers?: string[];
  task_description?: string;
  summary_only?: boolean;
  sections?: string[];
};

export type PrinciplesGraphContext = Pick<
  FileMetrics,
  "in_degree" | "out_degree" | "is_hub" | "in_cycle" | "impact_score"
>;

export type GetPrinciplesOutput = {
  principles: Array<{
    id: string;
    title: string;
    severity: string;
    body: string;
  }>;
  total_matched: number;
  total_in_canon: number;
  graph_context?: PrinciplesGraphContext;
};

const DEFAULT_MAX_PRINCIPLES = 10;

function loadMaxPrinciples(projectDir: string): Promise<number> {
  return loadConfigNumber(projectDir, "review.max_principles_per_review", DEFAULT_MAX_PRINCIPLES);
}

function metricsToContext(metrics: FileMetrics): PrinciplesGraphContext {
  return {
    impact_score: metrics.impact_score,
    in_cycle: metrics.in_cycle,
    in_degree: metrics.in_degree,
    is_hub: metrics.is_hub,
    out_degree: metrics.out_degree,
  };
}

function formatPrincipleBody(
  p: { body: string; anti_rationalization?: string; verification?: string },
  summaryOnly: boolean | undefined,
  sections: string[],
): string {
  if (summaryOnly) return extractSummary(p.body);
  return filterBodyBySections(p.body, p.anti_rationalization, p.verification, sections);
}

export async function getPrinciples(
  input: GetPrinciplesInput,
  projectDir: string,
  pluginDir: string,
): Promise<GetPrinciplesOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const maxPrinciples = await loadMaxPrinciples(projectDir);

  const matched = matchPrinciples(allPrinciples, {
    file_path: input.file_path,
    layers: input.layers,
  });

  const top = matched.slice(0, maxPrinciples);

  let graph_context: GetPrinciplesOutput["graph_context"];
  if (input.file_path) {
    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    if (existsSync(dbPath)) {
      let db: ReturnType<typeof initDatabase> | undefined;
      try {
        db = initDatabase(dbPath);
        const kgQuery = new KgQuery(db);
        const insightMaps = computeFileInsightMaps(db);
        const metrics = kgQuery.getFileMetrics(input.file_path, {
          cycleMemberPaths: insightMaps.cycleMemberPaths,
          hubPaths: insightMaps.hubPaths,
          layerViolationsByPath: insightMaps.layerViolationsByPath,
        });
        if (metrics) graph_context = metricsToContext(metrics);
      } catch {
        // KG unavailable — graceful degradation
      } finally {
        db?.close();
      }
    }
  }

  const sections = input.sections ?? [];
  return {
    graph_context,
    principles: top.map((p) => ({
      body: formatPrincipleBody(p, input.summary_only, sections),
      id: p.id,
      severity: p.severity,
      title: p.title,
    })),
    total_in_canon: allPrinciples.length,
    total_matched: matched.length,
  };
}

export type GetPrinciplesBatchInput = {
  file_paths: string[];
  layers?: string[];
  task_description?: string;
  summary_only?: boolean;
  sections?: string[];
};

export type GetPrinciplesBatchOutput = {
  principles: Array<{ id: string; title: string; severity: string; body: string }>;
  total_matched: number;
  total_in_canon: number;
  graph_context_by_file: Record<string, PrinciplesGraphContext | undefined>;
};

function buildContextByFile(
  filePaths: string[],
  dbPath: string,
): Record<string, PrinciplesGraphContext | undefined> {
  const result: Record<string, PrinciplesGraphContext | undefined> = {};
  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
    const kgQuery = new KgQuery(db);
    const insightMaps = computeFileInsightMaps(db);
    for (const filePath of filePaths) {
      const metrics = kgQuery.getFileMetrics(filePath, {
        cycleMemberPaths: insightMaps.cycleMemberPaths,
        hubPaths: insightMaps.hubPaths,
        layerViolationsByPath: insightMaps.layerViolationsByPath,
      });
      result[filePath] = metrics ? metricsToContext(metrics) : undefined;
    }
  } catch {
    // KG unavailable — all entries remain undefined
  } finally {
    db?.close();
  }
  return result;
}

export async function getPrinciplesBatch(
  input: GetPrinciplesBatchInput,
  projectDir: string,
  pluginDir: string,
): Promise<GetPrinciplesBatchOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const maxPrinciples = await loadMaxPrinciples(projectDir);

  const deduped = new Map<string, (typeof allPrinciples)[number]>();
  for (const filePath of input.file_paths) {
    const matched = matchPrinciples(allPrinciples, {
      file_path: filePath,
      layers: input.layers,
    });
    for (const p of matched) {
      if (!deduped.has(p.id)) deduped.set(p.id, p);
    }
  }

  const sections = input.sections ?? [];
  const principles = Array.from(deduped.values())
    .slice(0, maxPrinciples)
    .map((p) => ({
      body: formatPrincipleBody(p, input.summary_only, sections),
      id: p.id,
      severity: p.severity,
      title: p.title,
    }));

  let graph_context_by_file: Record<string, PrinciplesGraphContext | undefined> = {};
  if (input.file_paths.length > 0) {
    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    graph_context_by_file = existsSync(dbPath)
      ? buildContextByFile(input.file_paths, dbPath)
      : Object.fromEntries(input.file_paths.map((fp) => [fp, undefined]));
  }

  return {
    graph_context_by_file,
    principles,
    total_in_canon: allPrinciples.length,
    total_matched: deduped.size,
  };
}
