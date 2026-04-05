import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeFileInsightMaps, KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import type { FileMetrics } from "../graph/kg-types.ts";
import { CANON_DIR, CANON_FILES, extractSummary } from "../shared/constants.ts";
import { loadConfigNumber } from "../shared/lib/config.ts";
import { loadAllPrinciples, matchPrinciples } from "../shared/matcher.ts";

export type GetPrinciplesInput = {
  file_path?: string;
  layers?: string[];
  task_description?: string;
  summary_only?: boolean;
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

  // Load graph context if file_path is provided
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
        if (metrics) {
          graph_context = {
            impact_score: metrics.impact_score,
            in_cycle: metrics.in_cycle,
            in_degree: metrics.in_degree,
            is_hub: metrics.is_hub,
            out_degree: metrics.out_degree,
          };
        }
      } catch {
        // KG unavailable — graceful degradation
      } finally {
        db?.close();
      }
    }
  }

  return {
    graph_context,
    principles: top.map((p) => ({
      body: input.summary_only ? extractSummary(p.body) : p.body,
      id: p.id,
      severity: p.severity,
      title: p.title,
    })),
    total_in_canon: allPrinciples.length,
    total_matched: matched.length,
  };
}
