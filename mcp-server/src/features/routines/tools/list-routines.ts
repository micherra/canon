import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import { loadAllRoutines } from "@shared/routine.ts";
import { resolveRoutineBinding } from "../services/resolve-binding.ts";
import type { BindingDrift, RoutineEnv } from "../services/routine-drift.ts";
import { computeBindingDrift } from "../services/routine-drift.ts";
import { readRoutineState } from "../services/routine-state.ts";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export type ListRoutinesInput = {
  filter_status?: "enabled" | "disabled" | "draft";
};

export type ListRoutinesOutput = {
  routines: Array<{
    name: string;
    title: string;
    status: "enabled" | "disabled" | "draft";
    resolved_binding: {
      target: "cloud-routine" | "desktop-task";
      overridden: boolean;
    };
    last_run: string | null;
    drift: BindingDrift;
  }>;
  total: number;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * List all routines with resolved binding, drift status, and run-state.
 *
 * Thin handler — delegates to services. Returns ToolResult<ListRoutinesOutput>.
 * Fail-open: absent routines dir → empty list.
 */
export async function listRoutines(
  input: ListRoutinesInput,
  projectDir: string,
  pluginDir: string,
  env: RoutineEnv,
): Promise<ToolResult<ListRoutinesOutput>> {
  const allRoutines = await loadAllRoutines(projectDir, pluginDir);

  const filtered =
    input.filter_status !== undefined
      ? allRoutines.filter((r) => r.status === input.filter_status)
      : allRoutines;

  const routines = await Promise.all(
    filtered.map(async (routine) => {
      const resolved_binding = resolveRoutineBinding(routine);
      const drift = computeBindingDrift(routine, env);
      const state = await readRoutineState(projectDir, routine.name);
      const last_run = state?.last_run ?? null;

      return {
        drift,
        last_run,
        name: routine.name,
        resolved_binding,
        status: routine.status,
        title: routine.title,
      };
    }),
  );

  return toolOk({ routines, total: routines.length });
}
