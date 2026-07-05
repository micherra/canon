/**
 * check_context_staleness MCP Tool Handler
 *
 * Reads the committed context-manifest.json and compares it against the
 * installed artifact tree to detect drift. Returns a StalenessReport.
 *
 * Canon principles:
 * - errors-are-values: manifest unreadable → toolError, not a throw
 * - deep-modules: thin wrapper; all logic in services/context-manifest.ts
 * - no-dead-abstractions: no new crypto; hashContent reused via service
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { isPathInWorktree } from "@shared/lib/worktree-guard.ts";
import {
  type ContextManifest,
  checkContextStaleness as checkStaleness,
  type StalenessReport,
} from "../services/context-manifest.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckContextStalenessInput = {
  /** Project root directory. Default manifest path is <project_dir>/context-manifest.json. */
  project_dir: string;
  /** Optional explicit path to the committed manifest JSON file. */
  manifest_path?: string;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Read the committed manifest, re-scan the installed artifact tree, and
 * return a StalenessReport as a ToolResult.
 *
 * Fail-safe: manifest file unreadable → `toolError("INVALID_INPUT", "MANIFEST_NOT_FOUND: ...")`.
 */
export async function checkContextStaleness(
  input: CheckContextStalenessInput,
): Promise<ToolResult<StalenessReport>> {
  const manifestPath = input.manifest_path ?? join(input.project_dir, "context-manifest.json");

  let manifest: ContextManifest;
  try {
    const raw = await readFile(manifestPath, "utf-8");
    manifest = JSON.parse(raw) as ContextManifest;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(
      "INVALID_INPUT",
      `MANIFEST_NOT_FOUND: cannot read manifest at ${manifestPath} — ${msg}`,
      false,
    );
  }

  const report = await checkStaleness(input.project_dir, manifest);
  return toolOk(report);
}

/**
 * Scope-containment wrapper for `check_context_staleness` (R6, Codex P2 fix).
 *
 * Rejects a `project_dir` outside the resolved session scope fail-closed
 * before any read; delegates to the unchanged `checkContextStaleness` when
 * the override is the scope root or a subpath of it. `manifest_path` is
 * deliberately not guarded here — it selects a manifest JSON file to parse,
 * never returned to the caller, so it is not a content-disclosure surface.
 */
export async function checkContextStalenessGuarded(
  input: CheckContextStalenessInput,
  scope: string,
): Promise<ToolResult<StalenessReport>> {
  const contained = await isPathInWorktree(input.project_dir, scope);
  if (!contained.ok) {
    return toolError(
      "INVALID_INPUT",
      `check_context_staleness: project_dir "${input.project_dir}" is outside the resolved project scope "${scope}"`,
      false,
    );
  }
  return checkContextStaleness(input);
}
