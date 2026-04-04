import { loadAllPrinciples, matchPrinciples } from "../matcher.ts";

export type ListPrinciplesInput = {
  filter_severity?: "rule" | "strong-opinion" | "convention";
  filter_tags?: string[];
  filter_layers?: string[];
  include_archived?: boolean;
};

export type ListPrinciplesOutput = {
  principles: Array<{
    id: string;
    title: string;
    severity: string;
    tags: string[];
    archived: boolean;
    scope: {
      layers: string[];
      file_patterns: string[];
    };
  }>;
  total: number;
};

export async function listPrinciples(
  input: ListPrinciplesInput,
  projectDir: string,
  pluginDir: string,
): Promise<ListPrinciplesOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);

  const matched = matchPrinciples(allPrinciples, {
    include_archived: input.include_archived,
    layers: input.filter_layers,
    severity_filter: input.filter_severity,
    tags: input.filter_tags,
  });

  return {
    principles: matched.map((p) => ({
      archived: p.archived,
      id: p.id,
      scope: {
        file_patterns: p.scope.file_patterns,
        layers: p.scope.layers,
      },
      severity: p.severity,
      tags: p.tags,
      title: p.title,
    })),
    total: matched.length,
  };
}
