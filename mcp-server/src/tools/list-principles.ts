import { matchPrinciples, loadAllPrinciples } from "../matcher.ts";

export interface ListPrinciplesInput {
  filter_severity?: "rule" | "strong-opinion" | "convention";
  filter_tags?: string[];
  filter_layers?: string[];
  include_archived?: boolean;
}

export interface ListPrinciplesOutput {
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
    include_archived: input.include_archived,
  });

  return {
    principles: matched.map((p) => ({
      id: p.id,
      title: p.title,
      severity: p.severity,
      tags: p.tags,
      archived: p.archived,
      scope: {
        layers: p.scope.layers,
        file_patterns: p.scope.file_patterns,
      },
    })),
    total: matched.length,
  };
}
