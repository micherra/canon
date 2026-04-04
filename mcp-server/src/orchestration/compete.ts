/**
 * Competitive flow module — expands a single state's spawn prompt into N
 * competitor prompts and builds synthesizer prompts.
 *
 * The orchestrator uses this to:
 * 1. Expand a base prompt into N competing versions (each with a unique lens)
 * 2. Collect all competitor outputs
 * 3. Build a synthesizer prompt that merges the best ideas
 */

import type { SpawnPromptEntry } from "../tools/get-spawn-prompt.ts";

export type CompeteConfig = {
  count: number;
  strategy: "synthesize" | "select";
  lenses?: string[];
};

export type CompetitorPrompt = {
  index: number;
  lens?: string;
  prompt: string;
  agent: string;
  template_paths: string[];
};

export type CompetitorOutput = {
  index: number;
  lens?: string;
  content: string;
  artifacts?: string[];
};

/**
 * Expand a single state's base prompt into N competitor prompts.
 *
 * Each competitor gets the full base prompt plus:
 * - A competitor identity (Team A, Team B, etc.)
 * - An optional lens (optimization constraint) from config.lenses
 *
 * If lenses are not provided or fewer than count, competitors without
 * explicit lenses get a generic "general-purpose" framing.
 */
export function expandCompetitorPrompts(
  basePrompt: SpawnPromptEntry,
  config: CompeteConfig,
): CompetitorPrompt[] {
  const teamLabels = ["A", "B", "C", "D", "E"];
  const prompts: CompetitorPrompt[] = [];

  for (let i = 0; i < config.count; i++) {
    const label = teamLabels[i] ?? String(i + 1);
    const lens = config.lenses?.[i];

    let lensSection = "";
    if (lens) {
      lensSection = `\n\n## Your Lens

You are **Team ${label}**, optimizing for: **${lens}**
This is your primary constraint. When making tradeoffs, favor ${lens} over other concerns.
Other teams are exploring different optimization targets — your job is to make the strongest case for this direction.`;
    } else {
      lensSection = `\n\n## Your Team

You are **Team ${label}**. Produce the best solution you can.
Other teams are independently solving the same problem — your work will be compared and the best ideas synthesized.`;
    }

    prompts.push({
      agent: basePrompt.agent,
      index: i,
      lens,
      prompt: basePrompt.prompt + lensSection,
      template_paths: basePrompt.template_paths,
    });
  }

  return prompts;
}

/**
 * Build a synthesizer prompt that reads all competitor outputs and produces
 * a single unified result.
 *
 * The synthesizer is instructed to:
 * - Understand the original brief
 * - Read all N outputs with full comprehension
 * - Identify the strongest ideas in each
 * - Detect conflicts and resolve them
 * - Produce a coherent unified output with attribution
 */
export function buildSynthesizerPrompt(
  originalBrief: string,
  competitorOutputs: CompetitorOutput[],
  strategy: "synthesize" | "select",
): string {
  const outputSections = competitorOutputs
    .map((out) => {
      const label = out.lens
        ? `Team ${out.index + 1} (lens: ${out.lens})`
        : `Team ${out.index + 1}`;
      return `### ${label}\n\n${out.content}`;
    })
    .join("\n\n---\n\n");

  if (strategy === "select") {
    return `## Selection Task

You are evaluating ${competitorOutputs.length} competing solutions to the same problem.

### Original Brief

${originalBrief}

### Competing Solutions

${outputSections}

## Your Job

Pick the single best solution. Explain:
1. Which solution you chose and why
2. What made it stronger than the alternatives
3. Any weaknesses in the chosen solution that should be noted

Output the selected solution in full, ready for downstream use.`;
  }

  return `## Synthesis Task

You are synthesizing ${competitorOutputs.length} competing solutions into a single unified output that captures the best ideas from each.

### Original Brief

${originalBrief}

### Competing Solutions

${outputSections}

## Your Job

Produce a single unified solution that is better than any individual input. For each major decision in your output:
- Note which input(s) inspired it
- Explain why you chose that approach over alternatives

You are NOT picking a winner — you are creating something new by combining the strongest elements. However, the result must be internally coherent, not a Frankenstein of incompatible ideas.

If two inputs have genuinely incompatible approaches to the same problem, choose one and explain the tradeoff.

Output the synthesized solution in the same format as the individual solutions, ready for downstream use.`;
}
