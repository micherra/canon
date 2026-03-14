import { type Principle } from "../parser.js";
import { matchPrinciples, loadAllPrinciples } from "../matcher.js";

export interface GetPrinciplesInput {
  file_path?: string;
  layers?: string[];
  task_description?: string;
}

export interface GetPrinciplesOutput {
  principles: Array<{
    id: string;
    title: string;
    severity: string;
    body: string;
  }>;
  total_matched: number;
  total_in_canon: number;
}

export async function getPrinciples(
  input: GetPrinciplesInput,
  projectDir: string,
  pluginDir: string
): Promise<GetPrinciplesOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);

  const matched = matchPrinciples(allPrinciples, {
    file_path: input.file_path,
    layers: input.layers,
  });

  // Limit to top 10, prioritized by severity (already sorted by matchPrinciples)
  const top = matched.slice(0, 10);

  return {
    principles: top.map((p) => ({
      id: p.id,
      title: p.title,
      severity: p.severity,
      body: p.body,
    })),
    total_matched: matched.length,
    total_in_canon: allPrinciples.length,
  };
}
