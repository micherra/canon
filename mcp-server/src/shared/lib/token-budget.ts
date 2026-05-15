/**
 * token-budget.ts — Token budget estimation utility.
 *
 * Pure leaf utility with no external dependencies.
 * Uses the words * 1.3 heuristic — no tokenizer dependency required.
 * Accurate within ~10% for typical English/code text.
 */

/**
 * Estimate the token count for a text string.
 * Uses the words * 1.3 heuristic — no external tokenizer dependency.
 * Returns 0 for empty/whitespace-only input.
 */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

/**
 * Fit items into a token budget, selecting highest-priority items first.
 *
 * Each item must have a `text` field (for token estimation) and a `priority`
 * field (higher number = higher priority). Items are sorted by priority DESC
 * and added until the budget is exhausted.
 *
 * Returns the subset of items that fit within the budget, in priority order.
 * Returns an empty array when budget <= 0 or items is empty.
 */
export function fitWithinBudget<T extends { text: string; priority: number }>(
  items: T[],
  budget: number,
): T[] {
  if (budget <= 0 || items.length === 0) return [];

  const sorted = [...items].sort((a, b) => b.priority - a.priority);
  const result: T[] = [];
  let remaining = budget;

  for (const item of sorted) {
    const cost = estimateTokens(item.text);
    if (cost <= remaining) {
      result.push(item);
      remaining -= cost;
    }
  }

  return result;
}
