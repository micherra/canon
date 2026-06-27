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
