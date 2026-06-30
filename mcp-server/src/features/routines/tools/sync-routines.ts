import { join } from "node:path";
import { brandUntrusted, renderUntrusted } from "@shared/lib/overlay-untrusted-text.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import type { Routine } from "@shared/routine.ts";
import { loadAllRoutines } from "@shared/routine.ts";
import type { RoutineEnv } from "../services/routine-drift.ts";
import { syncAllRoutines, syncRoutine } from "../services/routine-sync.ts";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export type SyncRoutinesInput = {
  /** When provided, sync only the named routine. When absent, sync all enabled routines. */
  name?: string;
};

export type SyncEntry =
  | { name: string; kind: "recipe"; recipe: string }
  | { name: string; kind: "desktop"; path: string };

export type SyncRoutinesOutput = {
  synced: SyncEntry[];
  total: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a successful syncRoutine result to a SyncEntry. */
function toEntry(
  routine: Routine,
  result:
    | { ok: true; kind: "recipe"; recipe: string }
    | { ok: true; kind: "desktop"; path: string },
): SyncEntry {
  if (result.kind === "recipe") {
    // Fence the recipe in the model-facing response for project-local routines.
    // emitCloudRecipe writes the raw (unfenced) disk artifact — correct for user-paste docs.
    // The model-facing tool response must be fenced for project-local untrusted content.
    // Plugin routines are trusted (dc-05): recipe passed through unfenced.
    const recipe =
      routine.source === "project"
        ? renderUntrusted(brandUntrusted(result.recipe), {
            ref: `.canon/routines/${routine.name}`,
            source: "project",
          })
        : result.recipe;
    return { kind: "recipe", name: routine.name, recipe };
  }
  return { kind: "desktop", name: routine.name, path: result.path };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Sync one or all Canon routines to their binding targets.
 *
 * - name provided → sync that single routine
 * - name absent   → sync all enabled routines
 *
 * Thin handler — all sync logic delegated to routine-sync.ts.
 * Returns ToolResult<SyncRoutinesOutput>; never throws for expected errors.
 *
 * Guardrail: this is the ONLY runtime write path for SKILL.md files and
 * cloud recipes. It is invoked explicitly; it is never called from the
 * session-start hook (which is read-only).
 */
export async function syncRoutines(
  input: SyncRoutinesInput,
  projectDir: string,
  pluginDir: string,
  env: RoutineEnv,
): Promise<ToolResult<SyncRoutinesOutput>> {
  const allRoutines = await loadAllRoutines(projectDir, pluginDir);
  const indexPath = join(projectDir, "routines", ".claude", "CLAUDE.md");

  if (input.name !== undefined && input.name !== "") {
    return syncSingle(input.name, allRoutines, env, indexPath);
  }
  return syncAll(allRoutines, env, indexPath);
}

async function syncSingle(
  name: string,
  allRoutines: Routine[],
  env: RoutineEnv,
  indexPath: string,
): Promise<ToolResult<SyncRoutinesOutput>> {
  const routine = allRoutines.find((r) => r.name === name);
  if (!routine) {
    return toolOk({ synced: [], total: 0 });
  }

  const result = await syncRoutine(routine, env, allRoutines, indexPath);
  if (!result.ok) {
    return result;
  }
  return toolOk({ synced: [toEntry(routine, result)], total: 1 });
}

async function syncAll(
  allRoutines: Routine[],
  env: RoutineEnv,
  indexPath: string,
): Promise<ToolResult<SyncRoutinesOutput>> {
  const enabled = allRoutines.filter((r) => r.status === "enabled");
  if (enabled.length === 0) {
    return toolOk({ synced: [], total: 0 });
  }

  const results = await syncAllRoutines(enabled, env, indexPath);
  const synced: SyncEntry[] = [];

  for (let i = 0; i < enabled.length; i++) {
    const r = results[i];
    if (r.ok) {
      synced.push(toEntry(enabled[i], r));
    }
    // Individual failures skipped — observable-best-effort: caller sees successful syncs
  }

  return toolOk({ synced, total: synced.length });
}
