import { fenceUntrustedOverlay } from "@shared/lib/overlay-fence.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import { loadAllRoutines } from "@shared/routine.ts";
import { resolveRoutineBinding } from "../services/resolve-binding.ts";
import type { BindingDrift, RoutineEnv } from "../services/routine-drift.ts";
import { computeBindingDrift } from "../services/routine-drift.ts";
import type { RoutineState } from "../services/routine-state.ts";
import { readRoutineState } from "../services/routine-state.ts";

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export type GetRoutineInput = {
  name: string;
};

export type GetRoutineOutput = {
  name: string;
  title: string;
  status: "enabled" | "disabled" | "draft";
  body: string;
  trigger: {
    kind: "schedule" | "github-event" | "api";
    cron?: string;
    event?: string;
  };
  needs: {
    state: "git-native" | "local-canon";
    daemon: boolean;
  };
  guardrails: {
    mutates_running_build: boolean;
    repo_writes: "notify-only" | "draft-pr" | "none";
    consent: "opt-in" | "tier-gated";
  };
  repos: string[];
  scope: "repo" | "account";
  recurrence: "standing" | "one-shot";
  source: "project" | "plugin";
  resolved_binding: {
    target: "cloud-routine" | "desktop-task";
    overridden: boolean;
  };
  drift: BindingDrift;
  state: RoutineState | null;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Get a single routine by name with full details, resolved binding, drift, and state.
 *
 * Thin handler — delegates to services. Returns ToolResult<GetRoutineOutput>.
 * Returns INVALID_INPUT when name is empty or routine not found.
 */
export async function getRoutine(
  input: GetRoutineInput,
  projectDir: string,
  pluginDir: string,
  env: RoutineEnv,
): Promise<ToolResult<GetRoutineOutput>> {
  if (!input.name) {
    return toolError("INVALID_INPUT", "name is required", false);
  }

  const allRoutines = await loadAllRoutines(projectDir, pluginDir);
  const routine = allRoutines.find((r) => r.name === input.name);

  if (!routine) {
    return toolError("INVALID_INPUT", `Routine '${input.name}' not found`, false, {
      name: input.name,
    });
  }

  const resolved_binding = resolveRoutineBinding(routine);
  const drift = computeBindingDrift(routine, env);
  const state = await readRoutineState(projectDir, routine.name);

  // For project-local routines: fence the full projection (title + body together) so that
  // untrusted content — including the title (old F4 under-scan) — never reaches instruction
  // position. Plugin routines are trusted; they render unfenced.
  const isProject = routine.source === "project";
  const fencedBody = isProject
    ? fenceUntrustedOverlay(`# ${routine.title}\n\n${routine.body}`, {
        source: `.canon/routines/${routine.name}`,
      })
    : routine.body;
  // For project-local routines, expose only the safe name identifier in the title field;
  // the full untrusted title is inside the fenced body projection.
  const safeTitle = isProject ? routine.name : routine.title;

  return toolOk({
    body: fencedBody,
    drift,
    guardrails: routine.guardrails,
    name: routine.name,
    needs: routine.needs,
    recurrence: routine.recurrence,
    repos: routine.repos,
    resolved_binding,
    scope: routine.scope,
    source: routine.source,
    state,
    status: routine.status,
    title: safeTitle,
    trigger: routine.trigger,
  });
}
