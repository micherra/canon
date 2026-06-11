import { existsSync as nodeExistsSync } from "node:fs";
import { join } from "node:path";
import type { Routine } from "@shared/routine.ts";
import { resolveBinding } from "./resolve-binding.ts";

// ---------------------------------------------------------------------------
// Env seam — injected for testability; never reads real ~/.claude in tests
// ---------------------------------------------------------------------------

/**
 * Injectable environment seam for drift computation.
 *
 * - `homeDir`: the home directory to look under for `~/.claude/scheduled-tasks/`
 * - `existsSync`: injectable file-existence check (default: real node:fs existsSync)
 * - `hasCloudRecipeMarker`: optional check for cloud-routine recipe presence
 * - `listScheduledTasks`: optional listing of live desktop-task entries
 *
 * Production callers only need to pass `{ homeDir }` — all other fields default to
 * real implementations. Tests inject all fields to prevent real filesystem access.
 */
export type RoutineEnv = {
  homeDir: string;
  existsSync?: (path: string) => boolean;
  hasCloudRecipeMarker?: (name: string) => boolean;
  listScheduledTasks?: () => string[];
};

// ---------------------------------------------------------------------------
// Drift result type
// ---------------------------------------------------------------------------

export type BindingDrift = "bound" | "unbound" | "orphan";

// ---------------------------------------------------------------------------
// computeBindingDrift
// ---------------------------------------------------------------------------

/**
 * Compute the binding drift status for a single routine.
 *
 * - `"bound"`: the routine has a live binding artifact
 * - `"unbound"`: an enabled routine has no live binding (or disabled with no live binding)
 * - `"orphan"`: a live binding with no backing routine (see findOrphans)
 *
 * Pure-ish: all I/O is injected via `env`. Never reads the real `~/.claude` in tests.
 */
export function computeBindingDrift(routine: Routine, env: RoutineEnv): BindingDrift {
  const bindingTarget = routine.binding_target ?? resolveBinding(routine.needs);
  const existsSync = env.existsSync ?? nodeExistsSync;

  if (bindingTarget === "desktop-task") {
    const skillPath = join(env.homeDir, ".claude", "scheduled-tasks", routine.name, "SKILL.md");
    return existsSync(skillPath) ? "bound" : "unbound";
  }

  // cloud-routine
  if (env.hasCloudRecipeMarker && env.hasCloudRecipeMarker(routine.name)) {
    return "bound";
  }
  return "unbound";
}

// ---------------------------------------------------------------------------
// findOrphans
// ---------------------------------------------------------------------------

/**
 * Find orphaned live bindings — desktop task entries that have no backing routine.
 *
 * Returns the names of scheduled-task entries (from `~/.claude/scheduled-tasks/`)
 * that do not correspond to any known routine.
 *
 * Returns `[]` when `env.listScheduledTasks` is not provided (fail-open).
 */
export function findOrphans(routines: Routine[], env: RoutineEnv): string[] {
  if (!env.listScheduledTasks) return [];

  const liveTasks = env.listScheduledTasks();
  const knownNames = new Set(routines.map((r) => r.name));

  return liveTasks.filter((task) => !knownNames.has(task));
}
