/**
 * categorize_failures — MCP tool for grouping test failures by root cause.
 *
 * Uses a hybrid approach: pattern matching first with confidence scoring,
 * signals LLM refinement when confidence is below threshold.
 *
 * Signal priority (first match wins):
 *   1. Exact error message match   → confidence 0.95
 *   2. Same error_type             → confidence 0.9
 *   3. Same test file              → confidence 0.85
 *   4. Same directory prefix       → confidence 0.7 (boosted to 0.8 with common substring)
 */

import { toolError, toolOk } from "../utils/tool-result.ts";
import type { ToolResult } from "../utils/tool-result.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailureEntry {
  file: string;
  test_name?: string;
  error_message: string;
  error_type?: string;
}

export interface FailureCategory {
  category: string;
  description: string;
  confidence: number;
  files: string[];
  entries: FailureEntry[];
}

export interface CategorizeFailuresInput {
  workspace: string;
  failures: FailureEntry[];
  refined_categories?: Array<{
    category: string;
    description: string;
    files: string[];
  }>;
}

export interface CategorizeFailuresResult {
  categories: FailureCategory[];
  uncategorized: FailureEntry[];
  needs_refinement: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIDENCE_THRESHOLD = 0.8;
const SUBSTRING_BOOST_LENGTH = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dirOf(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(0, lastSlash) : "";
}

/**
 * Find the longest common substring shared across all messages.
 * Only considers substrings longer than SUBSTRING_BOOST_LENGTH chars.
 *
 * Worst-case time complexity: O(n^2 * m), where n = length of the first
 * message and m = number of messages, because the implementation enumerates
 * substrings of the first message and checks each candidate against every
 * message. In practice this is tightly bounded because messages are capped
 * at MAX_MSG_LEN characters and the search exits early once the first
 * longest match is found.
 */
function longestCommonSubstring(messages: string[]): string | null {
  if (messages.length === 0) return null;
  // Cap message length to bound cubic worst-case complexity
  const MAX_MSG_LEN = 200;
  const capped = messages.map((m) => m.slice(0, MAX_MSG_LEN));
  // Safe: we checked messages.length > 0 above
  const first: string = capped[0] as string;
  let best: string | null = null;

  // Enumerate substrings of the first message (longest first)
  for (let len = first.length; len > SUBSTRING_BOOST_LENGTH; len--) {
    for (let start = 0; start <= first.length - len; start++) {
      const candidate = first.slice(start, start + len);
      if (capped.every((m) => m.includes(candidate))) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (best === null || candidate.length > (best as string).length) {
          best = candidate;
        }
        // Break inner loop once we find first match at this length
        break;
      }
    }
    if (best !== null) break;
  }

  return best;
}

function makeCategoryLabel(
  signal: "exact_error" | "error_type" | "same_file" | "directory",
  representative: FailureEntry,
): { category: string; description: string } {
  switch (signal) {
    case "exact_error": {
      const label = representative.error_message.slice(0, 60);
      return { category: label, description: `Failures with identical error: "${label}"` };
    }
    case "error_type": {
      const t = representative.error_type ?? "Unknown";
      return { category: `${t} failures`, description: `Failures grouped by error type: ${t}` };
    }
    case "same_file": {
      const parts = representative.file.split("/");
      const name = parts[parts.length - 1] ?? representative.file;
      return {
        category: `failures in ${name}`,
        description: `Multiple failures in the same test file: ${representative.file}`,
      };
    }
    case "directory": {
      const dir = dirOf(representative.file);
      return {
        category: `failures in ${dir}/`,
        description: `Failures in the same directory: ${dir}/`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

export async function categorizeFailures(
  input: CategorizeFailuresInput,
): Promise<ToolResult<CategorizeFailuresResult>> {
  const { failures, refined_categories } = input;

  // Validate: failures must be non-empty
  if (failures.length === 0) {
    return toolError("INVALID_INPUT", "failures array must not be empty", false);
  }

  // Step 4: LLM refinement pass-through — when refined_categories is provided, skip pattern matching
  if (refined_categories !== undefined) {
    return applyRefinedCategories(failures, refined_categories);
  }

  // Track which failure entries have been assigned to a group already
  const assigned = new Set<number>();
  const categories: FailureCategory[] = [];

  // Step 1: Exact error match (confidence 0.95)
  const exactErrorGroups = new Map<string, number[]>();
  for (let i = 0; i < failures.length; i++) {
    const key = failures[i].error_message;
    if (!exactErrorGroups.has(key)) exactErrorGroups.set(key, []);
    exactErrorGroups.get(key)!.push(i);
  }
  for (const [_msg, indices] of exactErrorGroups) {
    if (indices.length >= 2) {
      // Only group when 2+ failures share the exact error message
      const entries = indices.map((i) => failures[i]);
      const { category, description } = makeCategoryLabel("exact_error", entries[0]);
      const files = [...new Set(entries.map((e) => e.file))];
      categories.push({ category, description, confidence: 0.95, files, entries });
      for (const i of indices) assigned.add(i);
    }
  }

  // Step 2: Error type grouping (confidence 0.9) — only unassigned failures
  const errorTypeGroups = new Map<string, number[]>();
  for (let i = 0; i < failures.length; i++) {
    if (assigned.has(i)) continue;
    const t = failures[i].error_type;
    if (!t) continue;
    if (!errorTypeGroups.has(t)) errorTypeGroups.set(t, []);
    errorTypeGroups.get(t)!.push(i);
  }
  for (const [_type, indices] of errorTypeGroups) {
    if (indices.length >= 2) {
      const entries = indices.map((i) => failures[i]);
      const { category, description } = makeCategoryLabel("error_type", entries[0]);
      const files = [...new Set(entries.map((e) => e.file))];
      categories.push({ category, description, confidence: 0.9, files, entries });
      for (const i of indices) assigned.add(i);
    }
    // Single failure with error_type but no group — leave for next signal
  }

  // Step 3: Same file grouping (confidence 0.85) — only unassigned failures
  const fileGroups = new Map<string, number[]>();
  for (let i = 0; i < failures.length; i++) {
    if (assigned.has(i)) continue;
    const f = failures[i].file;
    if (!fileGroups.has(f)) fileGroups.set(f, []);
    fileGroups.get(f)!.push(i);
  }
  for (const [_file, indices] of fileGroups) {
    if (indices.length >= 2) {
      const entries = indices.map((i) => failures[i]);
      const { category, description } = makeCategoryLabel("same_file", entries[0]);
      const files = [...new Set(entries.map((e) => e.file))];
      categories.push({ category, description, confidence: 0.85, files, entries });
      for (const i of indices) assigned.add(i);
    }
  }

  // Step 4: Directory prefix grouping (confidence 0.7) — only unassigned failures
  const dirGroups = new Map<string, number[]>();
  for (let i = 0; i < failures.length; i++) {
    if (assigned.has(i)) continue;
    const d = dirOf(failures[i].file);
    if (!dirGroups.has(d)) dirGroups.set(d, []);
    dirGroups.get(d)!.push(i);
  }
  for (const [_dir, indices] of dirGroups) {
    if (indices.length >= 2) {
      const entries = indices.map((i) => failures[i]);
      const messages = entries.map((e) => e.error_message);
      const commonSub = longestCommonSubstring(messages);
      const confidence = commonSub !== null ? 0.8 : 0.7;
      const { category, description } = makeCategoryLabel("directory", entries[0]);
      const files = [...new Set(entries.map((e) => e.file))];
      categories.push({ category, description, confidence, files, entries });
      for (const i of indices) assigned.add(i);
    }
  }

  // Step 5: Singleton exact-error groups — remaining unassigned failures each get their own
  // exact-error group at confidence 0.95 (no peer means the error is unique but still classified).
  for (let i = 0; i < failures.length; i++) {
    if (assigned.has(i)) continue;
    const entry = failures[i];
    const { category, description } = makeCategoryLabel("exact_error", entry);
    categories.push({ category, description, confidence: 0.95, files: [entry.file], entries: [entry] });
    assigned.add(i);
  }

  // Collect uncategorized — failures not assigned to any group
  const uncategorized: FailureEntry[] = failures.filter((_, i) => !assigned.has(i));

  // Evaluate needs_refinement
  const hasLowConfidenceGroup = categories.some((c) => c.confidence < CONFIDENCE_THRESHOLD);
  const hasMultipleUncategorized = uncategorized.length > 1;
  const needs_refinement = hasLowConfidenceGroup || hasMultipleUncategorized;

  return toolOk({ categories, uncategorized, needs_refinement });
}

// ---------------------------------------------------------------------------
// LLM refinement pass-through
// ---------------------------------------------------------------------------

function applyRefinedCategories(
  failures: FailureEntry[],
  refinedCategories: Array<{ category: string; description: string; files: string[] }>,
): ToolResult<CategorizeFailuresResult> {
  const failureFileSet = new Set(failures.map((f) => f.file));

  // Validate all files in refined_categories exist in failures
  for (const rc of refinedCategories) {
    for (const f of rc.files) {
      if (!failureFileSet.has(f)) {
        return toolError(
          "INVALID_INPUT",
          `refined_categories references file "${f}" which does not exist in failures`,
          false,
          { invalid_file: f },
        );
      }
    }
  }

  // Build categories from refined_categories with confidence 1.0
  const categories: FailureCategory[] = refinedCategories.map((rc) => {
    const entries = failures.filter((f) => rc.files.includes(f.file));
    return {
      category: rc.category,
      description: rc.description,
      confidence: 1.0,
      files: rc.files,
      entries,
    };
  });

  // Compute uncategorized (failures not mentioned in any refined category)
  const refinedFileSet = new Set(refinedCategories.flatMap((rc) => rc.files));
  const uncategorized = failures.filter((f) => !refinedFileSet.has(f.file));

  return toolOk({ categories, uncategorized, needs_refinement: false });
}
