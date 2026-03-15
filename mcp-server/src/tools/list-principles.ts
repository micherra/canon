import { matchPrinciples, loadAllPrinciples } from "../matcher.js";

export interface ListPrinciplesInput {
  filter_severity?: "rule" | "strong-opinion" | "convention";
  filter_tags?: string[];
  filter_layers?: string[];
}

export interface ListPrinciplesOutput {
  principles: Array<{
    id: string;
    title: string;
    severity: string;
    tags: string[];
    scope: {
      layers: string[];
    };
  }>;
  total: number;
}

export async function listPrinciples(
  input: ListPrinciplesInput,
  projectDir: string,
  pluginDir: string
): Promise<ListPrinciplesOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);

  const matched = matchPrinciples(allPrinciples, {
    severity_filter: input.filter_severity,
    tags: input.filter_tags,
    layers: input.filter_layers,
  });

  return {
    principles: matched.map((p) => ({
      id: p.id,
      title: p.title,
      severity: p.severity,
      tags: p.tags,
      scope: {
        layers: p.scope.layers,
      },
    })),
    total: matched.length,
  };
}
