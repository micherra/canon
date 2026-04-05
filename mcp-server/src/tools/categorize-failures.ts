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

import type { ToolResult } from "../shared/lib/tool-result.ts";
import { toolError, toolOk } from "../shared/lib/tool-result.ts";

export type FailureEntry = {
  file: string;
  test_name?: string;
  error_message: string;
  error_type?: string;
};

export type FailureCategory = {
  category: string;
  description: string;
  confidence: number;
  files: string[];
  entries: FailureEntry[];
};

export type CategorizeFailuresInput = {
  workspace: string;
  failures: FailureEntry[];
  refined_categories?: Array<{
    category: string;
    description: string;
    files: string[];
  }>;
};

export type CategorizeFailuresResult = {
  categories: FailureCategory[];
  uncategorized: FailureEntry[];
  needs_refinement: boolean;
};

const CONFIDENCE_THRESHOLD = 0.8;
const SUBSTRING_BOOST_LENGTH = 20;

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
/** Check if a candidate substring is present in all messages. */
function isSubstringInAll(candidate: string, messages: string[]): boolean {
  return messages.every((m) => m.includes(candidate));
}

function longestCommonSubstring(messages: string[]): string | null {
  if (messages.length === 0) return null;
  const MAX_MSG_LEN = 200;
  const capped = messages.map((m) => m.slice(0, MAX_MSG_LEN));
  const first: string = capped[0] as string;

  for (let len = first.length; len > SUBSTRING_BOOST_LENGTH; len--) {
    for (let start = 0; start <= first.length - len; start++) {
      const candidate = first.slice(start, start + len);
      if (isSubstringInAll(candidate, capped)) return candidate;
    }
  }

  return null;
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

// Core implementation

/** Group failure indices by a key function, skipping already-assigned indices. */
function groupByKey(
  failures: FailureEntry[],
  assigned: Set<number>,
  keyFn: (entry: FailureEntry) => string | null,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < failures.length; i++) {
    if (assigned.has(i)) continue;
    const key = keyFn(failures[i]);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  }
  return groups;
}

/** Options for assigning groups to categories. */
type AssignGroupsOptions = {
  signal: "exact_error" | "error_type" | "same_file" | "directory";
  confidence: number;
  categories: FailureCategory[];
};

/** Assign groups with 2+ entries to categories, marking indices as assigned. */
function assignGroups(
  failures: FailureEntry[],
  groups: Map<string, number[]>,
  assigned: Set<number>,
  options: AssignGroupsOptions,
): void {
  const { signal, confidence, categories } = options;
  for (const [_key, indices] of groups) {
    if (indices.length < 2) continue;
    const entries = indices.map((i) => failures[i]);
    const { category, description } = makeCategoryLabel(signal, entries[0]);
    const files = [...new Set(entries.map((e) => e.file))];
    categories.push({ category, confidence, description, entries, files });
    for (const i of indices) assigned.add(i);
  }
}

/** Assign directory groups with common substring boost. */
function assignDirectoryGroups(
  failures: FailureEntry[],
  groups: Map<string, number[]>,
  assigned: Set<number>,
  categories: FailureCategory[],
): void {
  for (const [_dir, indices] of groups) {
    if (indices.length < 2) continue;
    const entries = indices.map((i) => failures[i]);
    const messages = entries.map((e) => e.error_message);
    const commonSub = longestCommonSubstring(messages);
    const confidence = commonSub !== null ? 0.8 : 0.7;
    const { category, description } = makeCategoryLabel("directory", entries[0]);
    const files = [...new Set(entries.map((e) => e.file))];
    categories.push({ category, confidence, description, entries, files });
    for (const i of indices) assigned.add(i);
  }
}

/** Assign singleton categories for failures with partial signal (error_type present). */
function assignSingletons(
  failures: FailureEntry[],
  assigned: Set<number>,
  categories: FailureCategory[],
): void {
  for (let i = 0; i < failures.length; i++) {
    if (assigned.has(i)) continue;
    const entry = failures[i];
    if (!entry.error_type) continue;
    const { category, description } = makeCategoryLabel("error_type", entry);
    categories.push({
      category,
      confidence: 0.6,
      description,
      entries: [entry],
      files: [entry.file],
    });
    assigned.add(i);
  }
}

export async function categorizeFailures(
  input: CategorizeFailuresInput,
): Promise<ToolResult<CategorizeFailuresResult>> {
  const { failures, refined_categories } = input;

  if (failures.length === 0) {
    return toolError("INVALID_INPUT", "failures array must not be empty", false);
  }

  if (refined_categories !== undefined) {
    return applyRefinedCategories(failures, refined_categories);
  }

  const assigned = new Set<number>();
  const categories: FailureCategory[] = [];

  // Step 1: Exact error match (confidence 0.95)
  const exactGroups = groupByKey(failures, assigned, (e) => e.error_message);
  assignGroups(failures, exactGroups, assigned, {
    categories,
    confidence: 0.95,
    signal: "exact_error",
  });

  // Step 2: Error type grouping (confidence 0.9)
  const typeGroups = groupByKey(failures, assigned, (e) => e.error_type ?? null);
  assignGroups(failures, typeGroups, assigned, {
    categories,
    confidence: 0.9,
    signal: "error_type",
  });

  // Step 3: Same file grouping (confidence 0.85)
  const fileGroups = groupByKey(failures, assigned, (e) => e.file);
  assignGroups(failures, fileGroups, assigned, {
    categories,
    confidence: 0.85,
    signal: "same_file",
  });

  // Step 4: Directory prefix grouping (confidence 0.7/0.8)
  const dirGroups = groupByKey(failures, assigned, (e) => dirOf(e.file));
  assignDirectoryGroups(failures, dirGroups, assigned, categories);

  // Step 5: Singletons
  assignSingletons(failures, assigned, categories);

  const uncategorized: FailureEntry[] = failures.filter((_, i) => !assigned.has(i));
  const needs_refinement =
    categories.some((c) => c.confidence < CONFIDENCE_THRESHOLD) || uncategorized.length > 1;

  return toolOk({ categories, needs_refinement, uncategorized });
}

// LLM refinement pass-through

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

  // Validate file sets are disjoint across refined categories (issue #23).
  // A file appearing in multiple categories would cause duplicate fixing and confuse fan-out.
  const seenFiles = new Map<string, string>(); // file → first category that claimed it
  for (const rc of refinedCategories) {
    for (const f of rc.files) {
      const prior = seenFiles.get(f);
      if (prior !== undefined) {
        return toolError(
          "INVALID_INPUT",
          `refined_categories contains overlapping file sets: file "${f}" appears in both "${prior}" and "${rc.category}"`,
          false,
          { duplicate_file: f, first_category: prior, second_category: rc.category },
        );
      }
      seenFiles.set(f, rc.category);
    }
  }

  // Build categories from refined_categories with confidence 1.0
  const categories: FailureCategory[] = refinedCategories.map((rc) => {
    const entries = failures.filter((f) => rc.files.includes(f.file));
    return {
      category: rc.category,
      confidence: 1.0,
      description: rc.description,
      entries,
      files: rc.files,
    };
  });

  // Compute uncategorized (failures not mentioned in any refined category)
  const refinedFileSet = new Set(refinedCategories.flatMap((rc) => rc.files));
  const uncategorized = failures.filter((f) => !refinedFileSet.has(f.file));

  return toolOk({ categories, needs_refinement: false, uncategorized });
}
