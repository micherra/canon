import Anthropic from "@anthropic-ai/sdk";
import type { Principle } from "./parser.ts";

export type RerankerResult = {
  /** Principle IDs ordered by relevance (most relevant first). */
  selected: string[];
  /** Time taken for the API call in milliseconds. 0 when short-circuited. */
  latency_ms: number;
};

/**
 * Use Claude to select the top-N most relevant principles for a file.
 *
 * Tag filtering in matchPrinciples narrows the full principle set to a smaller
 * candidate list. This function performs the final ranking stage: it sends the
 * file content and candidate principle summaries to Claude and asks it to pick
 * the most relevant ones for this specific file.
 *
 * @param candidates - Pre-filtered principles (from tag/layer matching)
 * @param fileContent - First ~200 lines of the source file
 * @param filePath - Project-relative path, used as context for Claude
 * @param topN - Number of principles to select (default: 15)
 * @returns Selected principle IDs ordered by relevance, or all candidate IDs on failure
 */
export async function rerankPrinciples(
  candidates: Principle[],
  fileContent: string,
  filePath: string,
  topN: number = 15,
): Promise<RerankerResult> {
  // Short-circuit: if candidates fit within topN, skip the API call
  if (candidates.length <= topN) {
    return { latency_ms: 0, selected: candidates.map((p) => p.id) };
  }

  const start = Date.now();

  try {
    const client = new Anthropic();

    const candidateList = candidates
      .map((p) => {
        // Use first sentence of body as summary
        const summary = p.body.split(/[.!?]/)[0]?.trim() ?? p.title;
        return `- ${p.id}: ${p.title} — ${summary}`;
      })
      .join("\n");

    const prompt = `You are selecting which engineering principles are most relevant for reviewing a source file.

<file path="${filePath}">
${fileContent}
</file>

<candidates>
${candidateList}
</candidates>

Select the ${topN} principles most relevant to this specific file. Consider what the code does, how it handles errors, its API surface, security concerns, and design patterns.

Return ONLY a JSON array of principle IDs: ["id-1", "id-2", ...]`;

    const message = await client.messages.create({
      max_tokens: 512,
      messages: [{ content: prompt, role: "user" }],
      model: "claude-sonnet-4-20250514",
    });

    const latency_ms = Date.now() - start;

    // Extract text from the response
    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return { latency_ms, selected: candidates.map((p) => p.id) };
    }

    // Parse the JSON array response
    const text = textBlock.text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return { latency_ms, selected: candidates.map((p) => p.id) };
    }

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return { latency_ms, selected: candidates.map((p) => p.id) };
    }

    // Filter to valid principle IDs that exist in our candidate set
    const validIds = new Set(candidates.map((p) => p.id));
    const selected = (parsed as unknown[])
      .filter((id): id is string => typeof id === "string" && validIds.has(id))
      .slice(0, topN);

    // If Claude returned no valid IDs, fall back to all candidates
    if (selected.length === 0) {
      return { latency_ms, selected: candidates.map((p) => p.id) };
    }

    return { latency_ms, selected };
  } catch {
    // On any failure, return all candidates (graceful degradation)
    return { latency_ms: Date.now() - start, selected: candidates.map((p) => p.id) };
  }
}
