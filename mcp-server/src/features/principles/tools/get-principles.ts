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
import { rerankPrinciples } from "@shared/principle-reranker.ts";

export type GetPrinciplesInput = {
  file_path?: string;
  layers?: string[];
  task_description?: string;
  summary_only?: boolean;
  sections?: string[];
};

type PrinciplesGraphContext = Pick<
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

type KgFileData = {
  graph_context?: GetPrinciplesOutput["graph_context"];
  computed_tags?: string[];
};

function loadKgFileData(dbPath: string, filePath: string): KgFileData {
  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
    const kgQuery = new KgQuery(db);
    const insightMaps = computeFileInsightMaps(db);
    const metrics = kgQuery.getFileMetrics(filePath, {
      cycleMemberPaths: insightMaps.cycleMemberPaths,
      hubPaths: insightMaps.hubPaths,
      layerViolationsByPath: insightMaps.layerViolationsByPath,
    });

    let graph_context: KgFileData["graph_context"];
    if (metrics) {
      graph_context = {
        impact_score: metrics.impact_score,
        in_cycle: metrics.in_cycle,
        in_degree: metrics.in_degree,
        is_hub: metrics.is_hub,
        out_degree: metrics.out_degree,
      };
    }

    const tagRows = kgQuery.getFileTagsByPath(filePath);
    const computed_tags = tagRows.length > 0 ? tagRows.map((r) => r.tag) : undefined;

    return { computed_tags, graph_context };
  } catch {
    // KG unavailable — graceful degradation
    return {};
  } finally {
    db?.close();
  }
}

export async function getPrinciples(
  input: GetPrinciplesInput,
  projectDir: string,
  pluginDir: string,
): Promise<GetPrinciplesOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const maxPrinciples = await loadMaxPrinciples(projectDir);

  // Load graph context and computed tags if file_path is provided
  let graph_context: GetPrinciplesOutput["graph_context"];
  let computed_tags: string[] | undefined;

  if (input.file_path) {
    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    if (existsSync(dbPath)) {
      const kgData = loadKgFileData(dbPath, input.file_path);
      graph_context = kgData.graph_context;
      computed_tags = kgData.computed_tags;
    }
  }

  const matched = matchPrinciples(allPrinciples, {
    computed_tags,
    file_path: input.file_path,
    layers: input.layers,
  });

  // Apply reranker when file content is available; otherwise fall back to slice
  let top = matched.slice(0, maxPrinciples);
  if (input.file_path && matched.length > maxPrinciples) {
    try {
      const { readFile } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const absPath = resolve(projectDir, input.file_path);
      const rawContent = await readFile(absPath, "utf-8");
      const lines = rawContent.split("\n").slice(0, 200).join("\n");
      const reranked = await rerankPrinciples(matched, lines, input.file_path, maxPrinciples);
      const idIndex = new Map(matched.map((p) => [p.id, p]));
      top = reranked.selected.map((id) => idIndex.get(id)).filter((p) => p !== undefined);
    } catch {
      // Reranker failed — fall back to the already-sliced top
    }
  }

  return {
    graph_context,
    principles: top.map((p) => ({
      body: input.summary_only
        ? extractSummary(p.body)
        : filterBodyBySections(
            p.body,
            p.anti_rationalization,
            p.verification,
            input.sections ?? [],
          ),
      id: p.id,
      severity: p.severity,
      title: p.title,
    })),
    total_in_canon: allPrinciples.length,
    total_matched: matched.length,
  };
}
