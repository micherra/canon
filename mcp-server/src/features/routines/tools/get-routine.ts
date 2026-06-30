import {
  brandUntrusted,
  rawUntrustedForStructuralUse,
  renderUntrusted,
  renderUntrustedProjection,
} from "@shared/lib/overlay-untrusted-text.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { Routine } from "@shared/routine.ts";
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
    /** Absent for project-local routines — the charset-valid value is inside the fenced body. */
    cron?: string;
    /** Absent for project-local routines — inside the fenced body. */
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
  /** Absent for project-local routines — inside the fenced body. */
  repos?: string[];
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
// Project-local helper — fences all project-authored content
// ---------------------------------------------------------------------------

/**
 * Builds the model-facing output for project-local routines.
 *
 * USER ADDENDUM: the full projection (title + body + trigger.cron/event + repos)
 * is fenced inside a CANON_UNTRUSTED_OVERLAY envelope. Top-level `trigger.cron`,
 * `trigger.event`, and `repos` are ABSENT — they appear only inside the fence.
 */
function buildProjectOutput(
  routine: Routine,
  resolved_binding: GetRoutineOutput["resolved_binding"],
  drift: BindingDrift,
  state: RoutineState | null,
): ToolResult<GetRoutineOutput> {
  const ref = `.canon/routines/${routine.name}`;
  const rawTitle = rawUntrustedForStructuralUse(routine.title);
  const rawBody = rawUntrustedForStructuralUse(routine.body);

  const metaParts: string[] = [];
  if (routine.trigger.cron !== undefined) {
    metaParts.push(`trigger.cron: ${routine.trigger.cron}`);
  }
  if (routine.trigger.event !== undefined) {
    metaParts.push(`trigger.event: ${routine.trigger.event}`);
  }
  if (routine.repos.length > 0) {
    metaParts.push(`repos: ${routine.repos.join(", ")}`);
  }
  const metaBlock = metaParts.length > 0 ? `\n\n---\n${metaParts.join("\n")}` : "";
  const fullProjection = `# ${rawTitle}\n\n${rawBody}${metaBlock}`;

  const fencedBody = renderUntrustedProjection(
    { body: brandUntrusted(fullProjection) },
    { ref, source: "project" },
  );

  return toolOk({
    body: fencedBody,
    drift,
    guardrails: routine.guardrails,
    name: routine.name,
    needs: routine.needs,
    recurrence: routine.recurrence,
    // cron, event, repos are ABSENT from top-level; they appear only inside the fence.
    repos: undefined,
    resolved_binding,
    scope: routine.scope,
    source: routine.source,
    state,
    status: routine.status,
    // Safe name identifier in title field; untrusted title is inside the fenced body.
    title: routine.name,
    trigger: { kind: routine.trigger.kind },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Get a single routine by name with full details, resolved binding, drift, and state.
 *
 * Thin handler — delegates to services. Returns ToolResult<GetRoutineOutput>.
 * Returns INVALID_INPUT when name is empty or routine not found.
 *
 * Plugin routines are trusted (dc-05): rendered unfenced, all fields included.
 * Project-local routines: all project-authored content fenced (see buildProjectOutput).
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
  const ref = `.canon/routines/${routine.name}`;

  if (routine.source === "project") {
    return buildProjectOutput(routine, resolved_binding, drift, state);
  }

  // Plugin routines are trusted (dc-05): render unfenced, include all fields.
  return toolOk({
    body: renderUntrusted(routine.body, { ref, source: "plugin" }),
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
    title: renderUntrusted(routine.title, { ref, source: "plugin" }),
    trigger: routine.trigger,
  });
}
