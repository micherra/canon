/**
 * PR Review Data — Helper Functions
 *
 * Extracted from pr-review-data.ts: classifyFile, generateNarrative,
 * buildFileViolationMap, and their sub-functions.
 */

import type { FilePriorityScore } from "@graph/priority.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import type { PrFileInfo, PrViolation } from "./pr-review-data.ts";

/**
 * Classify a single file into an attention bucket with a human-readable reason.
 * Pure function — no side effects.
 *
 * Thresholds:
 *   needs-attention: violation_count > 0, OR (in_degree >= 5 AND is_changed)
 *   worth-a-look:    priority_score >= 5 (but not needs-attention)
 *   low-risk:        everything else
 */
export function classifyFile(file: Omit<PrFileInfo, "bucket" | "reason">): {
  bucket: PrFileInfo["bucket"];
  reason: string;
} {
  const factors = file.priority_factors;

  // needs-attention: violations
  if (factors && factors.violation_count > 0) {
    const count = factors.violation_count;
    const word = count === 1 ? "violation" : "violations";
    return {
      bucket: "needs-attention",
      reason: `Has ${count} ${word} that need fixing`,
    };
  }

  // needs-attention: high impact + changed
  if (factors && factors.in_degree >= 5 && factors.is_changed) {
    return {
      bucket: "needs-attention",
      reason: `High impact — ${factors.in_degree} files depend on this and it changed`,
    };
  }

  // worth-a-look: medium priority score
  const score = file.priority_score ?? 0;
  if (score >= 5) {
    const layer = factors?.layer ?? file.layer ?? "this";
    return {
      bucket: "worth-a-look",
      reason: `Medium impact — central to the ${layer} layer`,
    };
  }

  // low-risk: everything else
  return {
    bucket: "low-risk",
    reason: "Low risk — minimal dependencies",
  };
}

/** Find the file with the highest in_degree among changed files. */
function findMostConsequentialFile(
  files: Array<Omit<PrFileInfo, "bucket" | "reason">>,
): { path: string; in_degree: number } | null {
  let maxInDegree = -1;
  let consequentialFile: string | undefined;
  for (const f of files) {
    const deg = f.priority_factors?.in_degree;
    if (deg !== undefined && deg > maxInDegree) {
      maxInDegree = deg;
      consequentialFile = f.path;
    }
  }
  if (consequentialFile !== undefined && maxInDegree > 0) {
    return { in_degree: maxInDegree, path: consequentialFile };
  }
  return null;
}

/** Count total violations across all files. */
function countTotalViolations(files: Array<Omit<PrFileInfo, "bucket" | "reason">>): number {
  let total = 0;
  for (const f of files) {
    total += f.priority_factors?.violation_count ?? f.violations?.length ?? 0;
  }
  return total;
}

/** Build the layer summary sentence. */
function buildLayerSummary(layers: Array<{ name: string; file_count: number }>): string {
  const topLayer =
    layers.length > 0
      ? layers.reduce((a, b) => (b.file_count > a.file_count ? b : a)).name
      : "unknown";
  const topLayerCount = layers.find((l) => l.name === topLayer)?.file_count ?? 0;
  const layerDesc =
    topLayerCount === 1
      ? `with ${topLayerCount} file changed`
      : `with ${topLayerCount} files changed`;
  return `This PR primarily touches the ${topLayer} layer — ${layerDesc}.`;
}

/** Build the consequential file sentence, or empty string. */
function buildConsequentialSentence(files: Array<Omit<PrFileInfo, "bucket" | "reason">>): string {
  const consequential = findMostConsequentialFile(files);
  if (!consequential) return "";
  const basename = consequential.path.split("/").pop() ?? consequential.path;
  const depWord = consequential.in_degree === 1 ? "file depends" : "files depend";
  return `The most consequential change is ${basename} (${consequential.in_degree} ${depWord} on it).`;
}

/** Build the violation count sentence, or empty string. */
function buildViolationSentence(files: Array<Omit<PrFileInfo, "bucket" | "reason">>): string {
  const totalViolations = countTotalViolations(files);
  if (totalViolations === 0) return "";
  const vWord = totalViolations === 1 ? "violation" : "violations";
  return `There ${totalViolations === 1 ? "is" : "are"} ${totalViolations} principle ${vWord} to address.`;
}

/**
 * Generate a 3-4 sentence plain-English narrative summary for the PR.
 * Pure function — no side effects.
 */
export function generateNarrative(
  files: Array<Omit<PrFileInfo, "bucket" | "reason">>,
  layers: Array<{ name: string; file_count: number }>,
): string {
  if (files.length === 0) return "This PR has no changed files.";

  const sentence1 = buildLayerSummary(layers);
  const layerWord = layers.length === 1 ? "layer" : "layers";
  const sentence2 = `${files.length} ${files.length === 1 ? "file" : "files"} across ${layers.length} ${layerWord}.`;
  const sentence3 = buildConsequentialSentence(files);
  const sentence4 = buildViolationSentence(files);

  return [sentence1, sentence2, sentence3, sentence4].filter(Boolean).join(" ");
}

/** Append a violation to the per-file violation map. */
function appendViolation(
  map: Map<string, PrViolation[]>,
  targetFile: string,
  violation: PrViolation,
): void {
  const entry = map.get(targetFile);
  if (entry) {
    entry.push(violation);
  } else {
    map.set(targetFile, [violation]);
  }
}

/**
 * Build a per-file violation map from DriftStore review entries.
 * Pure function — takes reviews, returns a Map. No I/O.
 */
export function buildFileViolationMap(reviews: ReviewEntry[]): Map<string, PrViolation[]> {
  const map = new Map<string, PrViolation[]>();

  for (const review of reviews) {
    for (const v of review.violations) {
      const targetFile = v.file_path ?? review.files[0];
      if (!targetFile) continue;

      appendViolation(map, targetFile, {
        principle_id: v.principle_id,
        severity: v.severity as PrViolation["severity"],
        ...(v.message !== undefined ? { message: v.message } : {}),
      });
    }
  }

  return map;
}

/** Parse a single line from name-status diff output into path and status. */
export function parseNameStatusLine(
  line: string,
): { path: string; status: PrFileInfo["status"] } | null {
  const parts = line.split("\t");
  const statusLetter = parts[0];
  const status = mapStatus(statusLetter);
  const resolved = status === "renamed" && parts[2] ? parts[2] : parts[1];
  if (!resolved) return null;
  return { path: resolved, status };
}

type StatusLetter = "A" | "M" | "D" | "R" | string;

function mapStatus(letter: StatusLetter): PrFileInfo["status"] {
  if (letter.startsWith("R")) return "renamed";
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    default:
      return "modified";
  }
}

export function parseDiffOutput(
  stdout: string,
  isNameOnly: boolean,
  inferLayer: (path: string) => string,
  priorityMap: Map<string, FilePriorityScore>,
): PrFileInfo[] {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const results: PrFileInfo[] = [];

  for (const line of lines) {
    let path: string;
    let status: PrFileInfo["status"];

    if (isNameOnly) {
      path = line;
      status = "modified";
    } else {
      const parsed = parseNameStatusLine(line);
      if (!parsed) continue;
      ({ path, status } = parsed);
    }

    const layer = inferLayer(path) || "unknown";
    const priority = priorityMap.get(path);
    const file: PrFileInfo = { bucket: "low-risk", layer, path, reason: "", status };
    if (priority) {
      file.priority_score = priority.priority_score;
      file.priority_factors = priority.factors;
    }
    results.push(file);
  }

  return results;
}
