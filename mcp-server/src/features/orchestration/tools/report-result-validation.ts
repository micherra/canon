/**
 * Artifact and handoff validation for report-result.
 * Handles required_artifacts (ADR-010) and required_handoffs (ADR-018) checks.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { RequiredArtifact } from "@domains/flows/flow-definition-schemas.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError } from "@shared/lib/tool-result.ts";
import { isPathContained, isPathInWorktree } from "@shared/lib/worktree-guard.ts";

/** Statuses that imply success — blocked when test_results.failed > 0 without baseline evidence. */
export const SUCCESS_STATUSES = new Set([
  "done",
  "done_with_concerns", // CRITICAL: agents cannot use concerns to bypass
  "fixed",
  "partial_fix",
  "all_passing",
  "findings",
  "clean",
  "updated",
  "no_updates",
  "epic_complete",
  "approved",
]);

// Artifact validation (ADR-010)

type MetaJson = {
  _type: string;
  _version: number;
  [key: string]: unknown;
};

/**
 * Validates that all required artifacts exist and have the correct _type in
 * their .meta.json sidecar files. Searches both the reported artifacts list
 * and common locations (reviews/ and plans/ subdirectories).
 *
 * Returns toolError("INVALID_INPUT") when any required artifact is missing
 * or has the wrong type. Returns null when all artifacts are valid.
 *
 * Honors errors-are-values: never throws; all errors returned as ToolResult.
 */
function matchesArtifactName(artifactPath: string, reqName: string, metaName: string): boolean {
  const b = basename(artifactPath);
  if (b === metaName || artifactPath.endsWith(metaName)) return true;
  for (const ext of [".md", ".txt", ".json"]) {
    if (b === `${reqName}${ext}` || artifactPath.endsWith(`${reqName}${ext}`)) return true;
  }
  return false;
}

async function validateMatchedArtifact(
  workspace: string,
  match: string,
  req: RequiredArtifact,
): Promise<ToolResult<void> | null> {
  const fullPath = isAbsolute(match) ? match : join(workspace, match);
  // Two-layer workspace boundary check (ADR-014a).
  // Layer 1: logical containment (no .. traversal) — always enforced, no filesystem I/O.
  if (!isPathContained(workspace, fullPath)) {
    return toolError("INVALID_INPUT", `Artifact path "${match}" resolves outside workspace`);
  }
  // Layer 2: symlink resolution via realpath — catches symlink-based escapes for paths
  // that exist on disk. When the path does not yet exist (realpath fails), layer 1 suffices.
  const guard = await isPathInWorktree(fullPath, workspace);
  if (!guard.ok && guard.message.includes("via symlink")) {
    return toolError("INVALID_INPUT", `Artifact path "${match}" resolves outside workspace`);
  }
  const metaPath = fullPath.endsWith(".meta.json")
    ? fullPath
    : fullPath.replace(/\.(md|txt|json)$/, ".meta.json");
  try {
    const content = await readFile(metaPath, "utf-8");
    const meta: MetaJson = JSON.parse(content);
    if (meta._type !== req.type) {
      return toolError(
        "INVALID_INPUT",
        `Artifact "${req.name}" has type "${meta._type}" but expected "${req.type}"`,
      );
    }
  } catch {
    return toolError(
      "INVALID_INPUT",
      `Required artifact "${req.name}" meta file not readable at "${metaPath}"`,
    );
  }
  return null;
}

async function validateMetaAtPath(
  filePath: string,
  req: RequiredArtifact,
  location: string,
): Promise<{ found: boolean; error: ToolResult<void> | null }> {
  try {
    const content = await readFile(filePath, "utf-8");
    try {
      const meta: MetaJson = JSON.parse(content);
      if (meta._type !== req.type) {
        return {
          error: toolError(
            "INVALID_INPUT",
            `Artifact "${req.name}" has type "${meta._type}" but expected "${req.type}"`,
          ),
          found: false,
        };
      }
      return { error: null, found: true };
    } catch {
      return {
        error: toolError(
          "INVALID_INPUT",
          `Artifact "${req.name}" found at ${location} but contains malformed JSON`,
        ),
        found: false,
      };
    }
  } catch {
    return { error: null, found: false };
  }
}

async function searchPlansForArtifact(
  workspace: string,
  metaName: string,
  req: RequiredArtifact,
): Promise<{ found: boolean; error: ToolResult<void> | null }> {
  const plansDir = join(workspace, "plans");
  const subdirs = await readdir(plansDir).catch(() => [] as string[]);
  for (const sub of subdirs) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential scan with early-exit — cannot parallelize without losing short-circuit semantics
    const result = await validateMetaAtPath(
      join(plansDir, sub, metaName),
      req,
      `plans/${sub}/${metaName}`,
    );
    if (result.error) return result;
    if (result.found) return { error: null, found: true };
  }
  return { error: null, found: false };
}

async function validateSingleArtifact(
  workspace: string,
  artifacts: string[],
  req: RequiredArtifact,
): Promise<ToolResult<void> | null> {
  const metaName = `${req.name}.meta.json`;
  const match = artifacts.find((a) => matchesArtifactName(a, req.name, metaName));

  if (match) return validateMatchedArtifact(workspace, match, req);

  const reviewResult = await validateMetaAtPath(
    join(workspace, "reviews", metaName),
    req,
    `reviews/${metaName}`,
  );
  if (reviewResult.error) return reviewResult.error;
  if (reviewResult.found) return null;

  const plansResult = await searchPlansForArtifact(workspace, metaName, req);
  if (plansResult.error) return plansResult.error;
  if (plansResult.found) return null;

  return toolError(
    "INVALID_INPUT",
    `Required artifact "${req.name}" not found. Expected .meta.json sidecar with type "${req.type}"`,
  );
}

export async function validateRequiredArtifacts(
  workspace: string,
  artifacts: string[],
  required: RequiredArtifact[],
): Promise<ToolResult<void> | null> {
  for (const req of required) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential validation with early-exit on first error — cannot parallelize without losing short-circuit semantics
    const err = await validateSingleArtifact(workspace, artifacts, req);
    if (err) return err;
  }
  return null;
}

/**
 * Validates required handoff files declared on a state definition (ADR-018).
 *
 * Unlike validateRequiredArtifacts, this is non-blocking: missing or mistyped
 * handoffs produce warning strings rather than ToolResult errors. Returns an
 * array of warning strings (empty when all handoffs are present and correct).
 * Never throws.
 */
async function validateHandoffEntry(workspace: string, req: RequiredArtifact): Promise<string[]> {
  const metaPath = join(workspace, "handoffs", `${req.name}.meta.json`);
  let content: string;
  try {
    content = await readFile(metaPath, "utf-8");
  } catch {
    return [`Required handoff "${req.name}" not found in handoffs/`];
  }
  // Symlink guard (ADR-018 security follow-up): after confirming the file exists,
  // verify it doesn't escape the workspace via symlink resolution.
  const symlinkGuard = await isPathInWorktree(metaPath, workspace);
  if (!symlinkGuard.ok && symlinkGuard.message.includes("via symlink")) {
    return [`Required handoff "${req.name}" resolves outside workspace via symlink`];
  }
  try {
    const meta: MetaJson = JSON.parse(content);
    if (meta._type !== req.type) {
      return [`Required handoff "${req.name}" has type "${meta._type}" but expected "${req.type}"`];
    }
    return [];
  } catch {
    return [`Required handoff "${req.name}" has malformed JSON in handoffs/`];
  }
}

export async function validateRequiredHandoffs(
  workspace: string,
  required: RequiredArtifact[],
): Promise<string[]> {
  const perEntry = await Promise.all(required.map((req) => validateHandoffEntry(workspace, req)));
  return perEntry.flat();
}
