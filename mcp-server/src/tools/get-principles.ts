import { type Principle } from "../parser.js";
import { loadConfigNumber } from "../utils/config.js";
import { matchPrinciples, loadAllPrinciples } from "../matcher.js";

export interface GetPrinciplesInput {
  file_path?: string;
  layers?: string[];
  task_description?: string;
  summary_only?: boolean;
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

const DEFAULT_MAX_PRINCIPLES = 10;

function loadMaxPrinciples(projectDir: string): Promise<number> {
  return loadConfigNumber(projectDir, "review.max_principles_per_review", DEFAULT_MAX_PRINCIPLES);
}

/**
 * Extract just the first paragraph (summary) from a principle body.
 * This is the falsifiable constraint statement — enough for code generation
 * context without loading full rationale, examples, and exceptions.
 */
function extractSummary(body: string): string {
  const paragraphs = body.split(/\n\n/);
  return paragraphs[0]?.trim() || body;
}

export async function getPrinciples(
  input: GetPrinciplesInput,
  projectDir: string,
  pluginDir: string
): Promise<GetPrinciplesOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const maxPrinciples = await loadMaxPrinciples(projectDir);

  const matched = matchPrinciples(allPrinciples, {
    file_path: input.file_path,
    layers: input.layers,
  });

  const top = matched.slice(0, maxPrinciples);

  return {
    principles: top.map((p) => ({
      id: p.id,
      title: p.title,
      severity: p.severity,
      body: input.summary_only ? extractSummary(p.body) : p.body,
    })),
    total_matched: matched.length,
    total_in_canon: allPrinciples.length,
  };
}
