import { extractSummary } from "../constants.ts";
import { type GraphMetrics, getNodeMetrics, loadCachedGraph } from "../graph/query.ts";
import { loadAllPrinciples, matchPrinciples } from "../matcher.ts";
import { loadConfigNumber } from "../utils/config.ts";

export interface GetPrinciplesInput {
  file_path?: string;
  layers?: string[];
  task_description?: string;
  summary_only?: boolean;
}

type PrinciplesGraphContext = Pick<GraphMetrics, "in_degree" | "out_degree" | "is_hub" | "in_cycle" | "impact_score">;

export interface GetPrinciplesOutput {
  principles: Array<{
    id: string;
    title: string;
    severity: string;
    body: string;
  }>;
  total_matched: number;
  total_in_canon: number;
  graph_context?: PrinciplesGraphContext;
}

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
    const graph = await loadCachedGraph(projectDir);
    if (graph) {
      const metrics = getNodeMetrics(graph, input.file_path);
      if (metrics) {
        graph_context = {
          in_degree: metrics.in_degree,
          out_degree: metrics.out_degree,
          is_hub: metrics.is_hub,
          in_cycle: metrics.in_cycle,
          impact_score: metrics.impact_score,
        };
      }
    }
  }

  return {
    principles: top.map((p) => ({
      id: p.id,
      title: p.title,
      severity: p.severity,
      body: input.summary_only ? extractSummary(p.body) : p.body,
    })),
    total_matched: matched.length,
    total_in_canon: allPrinciples.length,
    graph_context,
  };
}
