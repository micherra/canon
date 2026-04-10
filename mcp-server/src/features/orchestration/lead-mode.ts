/**
 * lead-mode — Canon agent-teams orchestrator entry point.
 *
 * Phase 1 of docs/agent-teams-migration-plan.md. This module is the
 * server-side half of the "team lead" path. It is imported and used by
 * the Claude Code session that acts as the team lead when
 * CANON_AGENT_TEAMS_MODE=on; when the flag is unset or off, no existing
 * code path references this file, and behavior is byte-identical to
 * today.
 *
 * What this module does:
 *   1. Resolves whether lead-mode is enabled (env flag).
 *   2. Loads a runbook from `skills/canon/runbooks/<name>.yaml`.
 *   3. Plans a run: walks the runbook steps, calls the spawn module to
 *      assemble a prompt per step, and returns an ordered list of spawn
 *      descriptors ready for the team lead to execute.
 *   4. Writes the workspace-local hook state files so the
 *      artifact-enforce and idle-backstop hooks can look up expected
 *      artifact paths by task id / teammate name.
 *
 * This module has **no MCP tool surface** and is **not registered** in
 * `register-orchestration.ts`. That is intentional: when the flag is
 * off, the existing drive_flow path must not observe any additional
 * code paths. The smoke test harness and Phase 2 team-lead code are the
 * only expected callers.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type CanonRole,
  CANON_ROLES,
  assembleSpawnPrompt,
  getRoleArtifactContract,
  type TaskType,
  type UpstreamArtifactRef,
} from "@features/spawn/index.ts";

/** HITL gate values recognized in a runbook step. */
export type RunbookHitl =
  | false
  | "after"
  | "after_if_verdict_not_clean";

/** One step in a runbook. */
export interface RunbookStep {
  role: CanonRole;
  task_type: TaskType;
  artifact: string;
  artifact_path: string;
  hitl: RunbookHitl;
  required_artifacts: string[];
}

/** Parsed runbook contents. */
export interface Runbook {
  name: string;
  description: string;
  tier: "small" | "medium" | "large";
  steps: RunbookStep[];
}

/** Input to `planRun`. */
export interface PlanRunInput {
  runbook: Runbook;
  workspace_id: string;
  /** Target files the user's request pins. Passed to every step that
   * needs them; Phase 1 does not do per-step scoping. */
  target_files: string[];
}

/** Output of `planRun`: an ordered list of spawn descriptors. */
export interface SpawnDescriptor {
  /** Stable per-step id; derived as `<runbook_name>-<index>-<role>`. */
  task_id: string;
  /** Canon role to spawn. */
  role: CanonRole;
  /** Task type tag passed to the spawn module. */
  task_type: TaskType;
  /** Artifact this step is required to produce (logical id). */
  artifact: string;
  /** Artifact path relative to the workspace root. */
  artifact_path: string;
  /** HITL policy for this step. */
  hitl: RunbookHitl;
  /** Fully assembled spawn prompt. */
  spawn_prompt: string;
  /** Logical artifact ids the step depends on. */
  required_artifacts: string[];
}

/** The state file format consumed by the workspace-local hooks. */
export interface TaskArtifactState {
  [task_id: string]: {
    role: CanonRole;
    artifact: string;
    artifact_path: string;
  };
}

/** Env var name that gates the module. */
export const LEAD_MODE_ENV_VAR = "CANON_AGENT_TEAMS_MODE";

/**
 * Return `true` when the feature flag explicitly enables lead-mode.
 * Any other value (including unset) returns `false`. Used by callers
 * that want to branch on the flag without parsing the env themselves.
 */
export function isLeadModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LEAD_MODE_ENV_VAR] === "on";
}

/** Error thrown when a runbook fails validation. */
export class RunbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunbookError";
  }
}

/**
 * Load a runbook YAML file from the given plugin root.
 *
 * Path convention: `<pluginDir>/skills/canon/runbooks/<name>.yaml`.
 */
export async function loadRunbook(
  pluginDir: string,
  name: string,
): Promise<Runbook> {
  const path = join(pluginDir, "skills", "canon", "runbooks", `${name}.yaml`);
  if (!existsSync(path)) {
    throw new RunbookError(`Runbook not found: ${path}`);
  }
  const raw = await readFile(path, "utf8");
  return parseRunbook(raw, path);
}

/** Parse + validate a runbook from raw YAML text. Exposed for tests. */
export function parseRunbook(raw: string, source = "<in-memory>"): Runbook {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new RunbookError(
      `Failed to parse runbook YAML at ${source}: ${(err as Error).message}`,
    );
  }

  if (doc === null || typeof doc !== "object") {
    throw new RunbookError(`Runbook at ${source} is not an object`);
  }
  const obj = doc as Record<string, unknown>;

  const name = obj.name;
  const description = obj.description;
  const tier = obj.tier;
  const steps = obj.steps;

  if (typeof name !== "string") {
    throw new RunbookError(`Runbook at ${source} is missing a string "name"`);
  }
  if (typeof description !== "string") {
    throw new RunbookError(
      `Runbook "${name}" is missing a string "description"`,
    );
  }
  if (tier !== "small" && tier !== "medium" && tier !== "large") {
    throw new RunbookError(
      `Runbook "${name}" has invalid tier ${JSON.stringify(tier)}`,
    );
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new RunbookError(`Runbook "${name}" must declare at least one step`);
  }

  const parsedSteps: RunbookStep[] = steps.map((step, index) =>
    parseStep(step, name, index),
  );
  return { name, description, tier, steps: parsedSteps };
}

function parseStep(
  raw: unknown,
  runbookName: string,
  index: number,
): RunbookStep {
  if (raw === null || typeof raw !== "object") {
    throw new RunbookError(
      `Runbook "${runbookName}" step ${index}: expected object, got ${typeof raw}`,
    );
  }
  const s = raw as Record<string, unknown>;
  const role = s.role;
  if (typeof role !== "string" || !CANON_ROLES.includes(role as CanonRole)) {
    throw new RunbookError(
      `Runbook "${runbookName}" step ${index}: unknown role ${JSON.stringify(role)}`,
    );
  }
  const task_type = s.task_type;
  if (typeof task_type !== "string") {
    throw new RunbookError(
      `Runbook "${runbookName}" step ${index}: missing string "task_type"`,
    );
  }
  const artifact = s.artifact;
  if (typeof artifact !== "string") {
    throw new RunbookError(
      `Runbook "${runbookName}" step ${index}: missing string "artifact"`,
    );
  }
  const artifact_path = s.artifact_path;
  if (typeof artifact_path !== "string") {
    throw new RunbookError(
      `Runbook "${runbookName}" step ${index}: missing string "artifact_path"`,
    );
  }
  const hitlRaw = s.hitl;
  let hitl: RunbookHitl;
  if (hitlRaw === false) {
    hitl = false;
  } else if (
    hitlRaw === "after" ||
    hitlRaw === "after_if_verdict_not_clean"
  ) {
    hitl = hitlRaw;
  } else {
    throw new RunbookError(
      `Runbook "${runbookName}" step ${index}: invalid hitl value ${JSON.stringify(hitlRaw)}`,
    );
  }
  const requiredRaw = s.required_artifacts ?? [];
  if (!Array.isArray(requiredRaw)) {
    throw new RunbookError(
      `Runbook "${runbookName}" step ${index}: required_artifacts must be an array`,
    );
  }
  const required_artifacts = requiredRaw.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new RunbookError(
        `Runbook "${runbookName}" step ${index}: required_artifacts[${i}] must be a string`,
      );
    }
    return entry;
  });

  return {
    role: role as CanonRole,
    task_type: task_type as TaskType,
    artifact,
    artifact_path,
    hitl,
    required_artifacts,
  };
}

/**
 * Plan a runbook execution against a workspace.
 *
 * Walks each step in order, resolves upstream artifact refs from
 * earlier steps, and calls `assembleSpawnPrompt` to build the prompt.
 *
 * Pure function — no filesystem writes. The workspace-local state
 * files that the hooks consume are written by `writeTaskArtifactState`.
 */
export function planRun(input: PlanRunInput): SpawnDescriptor[] {
  const { runbook, workspace_id, target_files } = input;

  // Map of logical artifact id -> { path, produced_by }. Populated as we
  // walk the steps, so downstream steps can resolve their upstream refs.
  const artifactIndex = new Map<
    string,
    { path: string; produced_by: CanonRole; description?: string }
  >();

  const descriptors: SpawnDescriptor[] = [];
  for (let i = 0; i < runbook.steps.length; i++) {
    const step = runbook.steps[i]!;
    // Validate that the step's declared artifact matches the role's
    // canonical contract; the spawn prompt embeds the canonical path and
    // a mismatch would silently diverge from what the hooks enforce.
    const contract = getRoleArtifactContract(step.role);
    if (contract.artifact_path !== step.artifact_path) {
      throw new RunbookError(
        `Runbook "${runbook.name}" step ${i}: artifact_path ${step.artifact_path} does not match canonical contract ${contract.artifact_path} for role ${step.role}`,
      );
    }
    if (contract.artifact_id !== step.artifact) {
      throw new RunbookError(
        `Runbook "${runbook.name}" step ${i}: artifact id ${step.artifact} does not match canonical contract ${contract.artifact_id} for role ${step.role}`,
      );
    }

    // Resolve upstream refs from earlier steps' outputs.
    const upstream: UpstreamArtifactRef[] = step.required_artifacts.map(
      (refId) => {
        const hit = artifactIndex.get(refId);
        if (!hit) {
          throw new RunbookError(
            `Runbook "${runbook.name}" step ${i} (${step.role}): required artifact "${refId}" is not produced by any earlier step`,
          );
        }
        return {
          id: refId,
          path: hit.path,
          produced_by: hit.produced_by,
          description: hit.description,
        };
      },
    );

    const task_id = `${runbook.name}-${String(i).padStart(2, "0")}-${step.role}`;
    const spawn_prompt = assembleSpawnPrompt({
      role: step.role,
      task_type: step.task_type,
      target_files,
      upstream_artifact_refs: upstream,
      workspace_id,
    });

    descriptors.push({
      task_id,
      role: step.role,
      task_type: step.task_type,
      artifact: step.artifact,
      artifact_path: step.artifact_path,
      hitl: step.hitl,
      spawn_prompt,
      required_artifacts: step.required_artifacts,
    });

    // Index this step's output for downstream consumers.
    artifactIndex.set(step.artifact, {
      path: step.artifact_path,
      produced_by: step.role,
    });
  }

  return descriptors;
}

/**
 * Write the workspace-local state files the hooks consume.
 *
 * Creates `.canon/workspaces/<workspace_id>/agent-teams/task-artifacts.json`
 * and `.../teammate-artifacts.json`. Both are keyed differently (task id
 * vs teammate name) but carry the same underlying data so either hook
 * can do a quick lookup.
 */
export function writeTaskArtifactState(
  workspaceDir: string,
  descriptors: readonly SpawnDescriptor[],
): { task_state_path: string; teammate_state_path: string } {
  const dir = join(workspaceDir, "agent-teams");
  mkdirSync(dir, { recursive: true });

  const taskState: TaskArtifactState = {};
  const teammateState: TaskArtifactState = {};
  for (const d of descriptors) {
    taskState[d.task_id] = {
      role: d.role,
      artifact: d.artifact,
      artifact_path: d.artifact_path,
    };
    // Teammate-name convention: use the role name directly. Phase 1
    // spawns at most one instance of a role per team, so this is
    // unambiguous. Phase 3 adaptive waves will need a richer key.
    teammateState[d.role] = {
      role: d.role,
      artifact: d.artifact,
      artifact_path: d.artifact_path,
    };
  }

  const task_state_path = join(dir, "task-artifacts.json");
  const teammate_state_path = join(dir, "teammate-artifacts.json");
  writeFileSync(task_state_path, JSON.stringify(taskState, null, 2));
  writeFileSync(teammate_state_path, JSON.stringify(teammateState, null, 2));
  return { task_state_path, teammate_state_path };
}

/**
 * Derive a stable CLAUDE_CODE_TASK_LIST_ID for a workspace. Phase 1
 * convention: `canon-<workspace_id>` — simple, reversible, unique per
 * workspace. Exposed so the bootstrap script can export it into the
 * environment consistently on every resume.
 */
export function deriveTaskListId(workspaceId: string): string {
  return `canon-${workspaceId}`;
}

/**
 * Ensure the lead-mode gate is on; throw a clear error otherwise.
 * Useful at the entry of any lead-mode call site so the off-path
 * cannot accidentally invoke it.
 */
export function assertLeadModeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isLeadModeEnabled(env)) {
    throw new Error(
      `${LEAD_MODE_ENV_VAR} must be set to "on" to use lead-mode`,
    );
  }
}

/**
 * Convenience helper: load a runbook and plan a run in one step.
 *
 * Gated: throws if CANON_AGENT_TEAMS_MODE is not on. Callers that want
 * to run the pure planner without the flag gate should use
 * `parseRunbook` + `planRun` directly.
 */
export async function loadAndPlan(
  pluginDir: string,
  runbookName: string,
  input: Omit<PlanRunInput, "runbook">,
): Promise<{ runbook: Runbook; descriptors: SpawnDescriptor[] }> {
  assertLeadModeEnabled();
  const runbook = await loadRunbook(pluginDir, runbookName);
  const descriptors = planRun({ runbook, ...input });
  return { runbook, descriptors };
}

// Re-export types from the spawn module so callers can import one place.
export type { CanonRole, TaskType, UpstreamArtifactRef } from "@features/spawn/index.ts";

// Explicitly mark that `dirname` is not unused — it's consumed by
// future lead-mode helpers that derive plugin paths from module urls.
// (Phase 1 does not exercise that path yet.)
void dirname;
