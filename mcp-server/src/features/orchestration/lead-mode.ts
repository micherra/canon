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
  resolveWaveArtifactPath,
  type TaskType,
  type UpstreamArtifactRef,
  WAVE_COMPATIBLE_ROLES,
  type WaveContext,
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
  /**
   * Declared artifact path. For a non-wave step this is the Phase 1 flat
   * path that must match the role's canonical contract. For a
   * wave-expanded step (`wave: true`) this is a TEMPLATE path of the
   * shape `plans/<slug>/<TASK_ID><SUFFIX>` whose concrete expansion is
   * resolved at plan time via {@link resolveWaveArtifactPath}. Runbook
   * authors write it in that template form so the declaration is
   * self-describing even before planning.
   */
  artifact_path: string;
  hitl: RunbookHitl;
  required_artifacts: string[];
  /**
   * Phase 2 addition. When `true`, this step is spawned once per task id
   * provided in {@link PlanRunInput.wave_context}. The resulting
   * descriptors each carry their own wave_context, write to a per-task
   * path under `plans/<slug>/`, and share the same upstream refs. When
   * absent or `false`, Phase 1 single-agent behavior applies and the
   * step's `artifact_path` is cross-checked against the canonical flat
   * contract in `ROLE_ARTIFACT_CONTRACTS`.
   */
  wave?: boolean;
}

/** Parsed runbook contents. */
export interface Runbook {
  name: string;
  description: string;
  tier: "small" | "medium" | "large";
  steps: RunbookStep[];
}

/**
 * Optional wave context supplied at plan time for runbooks that contain
 * `wave: true` steps. Phase 2 addition.
 *
 * The caller (the smoke-test harness today; the team-lead orchestrator
 * in Phase 3) supplies a stable slug and an ordered list of task ids.
 * Each wave step is expanded into one descriptor per task id, keyed off
 * the expanded id `<runbook>-<slug>-<task_id>-<role>`.
 *
 * This is the static-shape version of wave support. Adaptive wave
 * planning — where the architect rewrites the next wave's task list
 * from the previous wave's output — is Phase 3.
 */
export interface PlanRunWaveContext {
  /** Stable plan-index slug. Must match /^[a-zA-Z0-9_-]+$/. */
  slug: string;
  /** Ordered list of task ids. Empty is rejected at plan time. */
  task_ids: string[];
}

/** Input to `planRun`. */
export interface PlanRunInput {
  runbook: Runbook;
  workspace_id: string;
  /** Target files the user's request pins. Passed to every step that
   * needs them; Phase 1 does not do per-step scoping. */
  target_files: string[];
  /**
   * Phase 2 addition. Required when the runbook contains any `wave:
   * true` step; must be omitted or empty when every step is flat.
   * Supplying a wave_context for a flat runbook is not an error, it is
   * simply ignored — this keeps the smoke-test harness simple.
   */
  wave_context?: PlanRunWaveContext;
}

/** Output of `planRun`: an ordered list of spawn descriptors. */
export interface SpawnDescriptor {
  /**
   * Stable per-descriptor id. Flat (Phase 1) shape:
   *     `<runbook_name>-<NN>-<role>`
   * Wave-expanded (Phase 2) shape:
   *     `<runbook_name>-<slug>-<task_id>-<role>`
   * Both shapes round-trip through the workspace-local state files and
   * the hooks look up either one by exact match.
   */
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
  /**
   * Phase 2 addition. Present only on descriptors produced from a
   * `wave: true` step. Carries the concrete (slug, task_id) pair used
   * to derive the artifact path so downstream tools (the smoke-test
   * harness, observability) can inspect the expansion without re-parsing
   * the task id string.
   */
  wave_context?: WaveContext;
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

  // Phase 2: optional `wave: true | false` field. Absent / undefined
  // defaults to `false`, which keeps Phase 1 runbooks (`fast-path.yaml`)
  // parse-compatible with this parser. Any value other than boolean is
  // rejected to catch typos like `wave: yes`.
  const waveRaw = s.wave;
  let wave: boolean | undefined;
  if (waveRaw === undefined) {
    wave = undefined;
  } else if (typeof waveRaw === "boolean") {
    wave = waveRaw;
  } else {
    throw new RunbookError(
      `Runbook "${runbookName}" step ${index}: wave must be a boolean if present, got ${JSON.stringify(waveRaw)}`,
    );
  }
  if (wave === true && !WAVE_COMPATIBLE_ROLES.includes(role as CanonRole)) {
    throw new RunbookError(
      `Runbook "${runbookName}" step ${index}: role ${role} is not wave-compatible (see WAVE_COMPATIBLE_ROLES)`,
    );
  }

  return {
    role: role as CanonRole,
    task_type: task_type as TaskType,
    artifact,
    artifact_path,
    hitl,
    required_artifacts,
    ...(wave !== undefined ? { wave } : {}),
  };
}

/** Expected template shape of a wave step's declared artifact path. */
const WAVE_PATH_TEMPLATE_RE = /^plans\/<slug>\/<task_id>-[A-Z][A-Z0-9-]*\.md$/;

/**
 * Plan a runbook execution against a workspace.
 *
 * Walks each step in order, resolves upstream artifact refs from earlier
 * steps, and calls `assembleSpawnPrompt` to build the prompt. Supports
 * both flat (Phase 1) and wave-expanded (Phase 2) steps.
 *
 * Pure function — no filesystem writes. The workspace-local state files
 * that the hooks consume are written by `writeTaskArtifactState`.
 */
export function planRun(input: PlanRunInput): SpawnDescriptor[] {
  const { runbook, workspace_id, target_files, wave_context } = input;

  // Up-front validation: if any step is wave-expanded, the caller must
  // supply a wave_context with at least one task id. This is a soft
  // error with a helpful message — we emit it here rather than letting
  // it surface deep inside assembleSpawnPrompt so the smoke-test harness
  // sees a recognizable RunbookError.
  const hasWave = runbook.steps.some((s) => s.wave === true);
  if (hasWave) {
    if (!wave_context || wave_context.task_ids.length === 0) {
      throw new RunbookError(
        `Runbook "${runbook.name}" has wave-expanded step(s) but no wave_context.task_ids were provided at plan time`,
      );
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(wave_context.slug)) {
      throw new RunbookError(
        `Runbook "${runbook.name}" wave_context.slug ${JSON.stringify(wave_context.slug)} must match /^[a-zA-Z0-9_-]+$/`,
      );
    }
    for (const tid of wave_context.task_ids) {
      if (!/^[a-zA-Z0-9_-]+$/.test(tid)) {
        throw new RunbookError(
          `Runbook "${runbook.name}" wave_context.task_ids contains invalid id ${JSON.stringify(tid)}; must match /^[a-zA-Z0-9_-]+$/`,
        );
      }
    }
  }

  // Map of logical artifact id -> { produced_by role, description,
  //   path | wavePaths }.
  //   - `path` is set for flat steps (one physical artifact per run).
  //   - `wavePaths` is a Map<task_id, path> for wave-expanded steps so
  //     downstream wave steps can resolve their upstream ref to the
  //     matching per-task path rather than a single path.
  interface ArtifactIndexEntry {
    produced_by: CanonRole;
    description?: string;
    path?: string;
    wavePaths?: Map<string, string>;
  }
  const artifactIndex = new Map<string, ArtifactIndexEntry>();

  const descriptors: SpawnDescriptor[] = [];
  for (let i = 0; i < runbook.steps.length; i++) {
    const step = runbook.steps[i]!;
    const contract = getRoleArtifactContract(step.role);
    // The flat role artifact id is always the same across flat and
    // waved spawns — it names the logical artifact the step produces.
    if (contract.artifact_id !== step.artifact) {
      throw new RunbookError(
        `Runbook "${runbook.name}" step ${i}: artifact id ${step.artifact} does not match canonical contract ${contract.artifact_id} for role ${step.role}`,
      );
    }

    if (step.wave !== true) {
      // Phase 1 flat path — behavior must be byte-identical to Phase 1.
      if (contract.artifact_path !== step.artifact_path) {
        throw new RunbookError(
          `Runbook "${runbook.name}" step ${i}: artifact_path ${step.artifact_path} does not match canonical contract ${contract.artifact_path} for role ${step.role}`,
        );
      }
      const upstream = resolveUpstreamRefsForFlatStep(
        step,
        i,
        runbook.name,
        artifactIndex,
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
      artifactIndex.set(step.artifact, {
        path: step.artifact_path,
        produced_by: step.role,
      });
      continue;
    }

    // Phase 2 wave-expanded step.
    if (!wave_context) {
      // Already caught by the top-of-function guard; this is belt-and-
      // suspenders for direct callers that somehow got past it.
      throw new RunbookError(
        `Runbook "${runbook.name}" step ${i}: wave_context is required for wave steps`,
      );
    }
    if (!WAVE_PATH_TEMPLATE_RE.test(step.artifact_path)) {
      throw new RunbookError(
        `Runbook "${runbook.name}" step ${i}: wave step artifact_path ${step.artifact_path} must be of the template form "plans/<slug>/<task_id>-<NAME>.md"`,
      );
    }
    // Cross-check that the declared template expands to the canonical
    // wave path for this role. We do this by materializing a sample
    // expansion with a placeholder slug/task_id and comparing shapes.
    const templateSample = resolveWaveArtifactPath(step.role, {
      slug: "PROBE",
      task_id: "PROBE",
    });
    if (
      step.artifact_path !== templateSample.replace("PROBE/PROBE", "<slug>/<task_id>")
    ) {
      throw new RunbookError(
        `Runbook "${runbook.name}" step ${i}: declared wave artifact_path ${step.artifact_path} does not match the canonical wave shape for role ${step.role} (${templateSample.replace("PROBE/PROBE", "<slug>/<task_id>")})`,
      );
    }

    const waveOutputPaths = new Map<string, string>();
    for (const taskIdLocal of wave_context.task_ids) {
      const wc: WaveContext = { slug: wave_context.slug, task_id: taskIdLocal };
      const concretePath = resolveWaveArtifactPath(step.role, wc);
      const upstream = resolveUpstreamRefsForWaveStep(
        step,
        i,
        runbook.name,
        artifactIndex,
        taskIdLocal,
      );
      const spawn_prompt = assembleSpawnPrompt({
        role: step.role,
        task_type: step.task_type,
        target_files,
        upstream_artifact_refs: upstream,
        workspace_id,
        wave_context: wc,
      });
      const expandedId = `${runbook.name}-${wave_context.slug}-${taskIdLocal}-${step.role}`;
      descriptors.push({
        task_id: expandedId,
        role: step.role,
        task_type: step.task_type,
        artifact: step.artifact,
        artifact_path: concretePath,
        hitl: step.hitl,
        spawn_prompt,
        required_artifacts: step.required_artifacts,
        wave_context: wc,
      });
      waveOutputPaths.set(taskIdLocal, concretePath);
    }
    artifactIndex.set(step.artifact, {
      produced_by: step.role,
      wavePaths: waveOutputPaths,
    });
  }

  return descriptors;
}

/**
 * Resolve upstream artifact refs for a flat (non-wave) step.
 *
 * A flat step sees one of two shapes per upstream ref:
 *   1. Flat upstream: a single physical path, emitted as-is.
 *   2. Wave upstream: a glob-shaped path of the form
 *      `plans/<slug>/<*>-<SUFFIX>.md` pointing at every per-task artifact
 *      the earlier wave produced. The downstream flat teammate (tester,
 *      scribe, reviewer, shipper) is expected to discover the matching
 *      files at runtime. This is Phase 2's compromise for fan-in: the
 *      linear runbook format cannot enumerate N paths in a single upstream
 *      ref, so we hand over a concrete glob the teammate can expand.
 *
 * The description field is annotated so the teammate understands it is
 * a glob and not a single file.
 */
function resolveUpstreamRefsForFlatStep(
  step: RunbookStep,
  index: number,
  runbookName: string,
  artifactIndex: Map<
    string,
    {
      produced_by: CanonRole;
      description?: string;
      path?: string;
      wavePaths?: Map<string, string>;
    }
  >,
): UpstreamArtifactRef[] {
  return step.required_artifacts.map((refId) => {
    const hit = artifactIndex.get(refId);
    if (!hit) {
      throw new RunbookError(
        `Runbook "${runbookName}" step ${index} (${step.role}): required artifact "${refId}" is not produced by any earlier step`,
      );
    }
    if (hit.path !== undefined) {
      return {
        id: refId,
        path: hit.path,
        produced_by: hit.produced_by,
        description: hit.description,
      };
    }
    // Wave upstream — synthesize a glob-shaped path so the flat consumer
    // has a concrete pointer into the wave output directory.
    if (!hit.wavePaths || hit.wavePaths.size === 0) {
      throw new RunbookError(
        `Runbook "${runbookName}" step ${index} (${step.role}): wave upstream "${refId}" produced zero per-task artifacts`,
      );
    }
    // Every wave entry lives in the same parent dir, so any one is fine
    // for shape extraction.
    const samplePath = hit.wavePaths.values().next().value!;
    const globPath = waveGlobFromSamplePath(samplePath);
    return {
      id: refId,
      path: globPath,
      produced_by: hit.produced_by,
      description: `Wave fan-in glob — one artifact per task id produced by the wave step (${hit.wavePaths.size} total).`,
    };
  });
}

/**
 * Derive a glob-shaped upstream path from a concrete wave artifact path.
 * Example:
 *     `plans/fix-bug/t1-SUMMARY.md` → `plans/fix-bug/*-SUMMARY.md`
 * Strips the per-task prefix preserving the suffix so the glob is as
 * narrow as possible.
 */
function waveGlobFromSamplePath(samplePath: string): string {
  // Expected shape: plans/<slug>/<task_id>-<REST>.md
  const m = /^(plans\/[^/]+\/)([^/]+?)(-[A-Z][A-Z0-9-]*\.md)$/.exec(samplePath);
  if (!m) return samplePath; // Give up gracefully — still returns a usable ref.
  return `${m[1]}*${m[3]}`;
}

/**
 * Resolve upstream artifact refs for a wave-expanded step running
 * against a specific task id. Wave steps can reference:
 *   - Flat upstreams (single path shared across the whole wave)
 *   - Wave upstreams from an earlier step (same task id; one-to-one
 *     match by the shared task id key)
 * If a wave upstream has no entry for the current task id, it is an
 * authoring error — the wave shapes do not line up.
 */
function resolveUpstreamRefsForWaveStep(
  step: RunbookStep,
  index: number,
  runbookName: string,
  artifactIndex: Map<
    string,
    {
      produced_by: CanonRole;
      description?: string;
      path?: string;
      wavePaths?: Map<string, string>;
    }
  >,
  taskId: string,
): UpstreamArtifactRef[] {
  return step.required_artifacts.map((refId) => {
    const hit = artifactIndex.get(refId);
    if (!hit) {
      throw new RunbookError(
        `Runbook "${runbookName}" step ${index} (${step.role}): required artifact "${refId}" is not produced by any earlier step`,
      );
    }
    if (hit.path !== undefined) {
      // Flat upstream — every wave task sees the same path.
      return {
        id: refId,
        path: hit.path,
        produced_by: hit.produced_by,
        description: hit.description,
      };
    }
    // Wave upstream — resolve by task id.
    const p = hit.wavePaths?.get(taskId);
    if (!p) {
      throw new RunbookError(
        `Runbook "${runbookName}" step ${index} (${step.role}): required wave artifact "${refId}" has no entry for task id "${taskId}"`,
      );
    }
    return {
      id: refId,
      path: p,
      produced_by: hit.produced_by,
      description: hit.description,
    };
  });
}

/**
 * Write the workspace-local state files the hooks consume.
 *
 * Creates `.canon/workspaces/<workspace_id>/agent-teams/task-artifacts.json`
 * and `.../teammate-artifacts.json`. Both are keyed so the hooks can do
 * a quick lookup:
 *   - `task-artifacts.json` is keyed by descriptor `task_id` — flat
 *     ids for Phase 1 steps, expanded ids for Phase 2 wave steps.
 *   - `teammate-artifacts.json` is keyed by role name for flat steps
 *     (Phase 1 convention, unchanged) AND by the expanded task id for
 *     wave steps. This lets `idle-backstop.sh` find the Phase 1 entries
 *     by the plain role name while still giving the hook a
 *     task-id-keyed entry for wave teammates whose Claude Code
 *     teammate_name embeds the expanded id.
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
    if (d.wave_context) {
      // Wave-expanded teammate — key the teammate state by the
      // expanded task id so the hook can resolve it. The flat role
      // name is intentionally NOT overwritten here; wave teammates do
      // not own the shared flat key, since multiple descriptors share
      // the same role and last-writer-wins would be misleading.
      teammateState[d.task_id] = {
        role: d.role,
        artifact: d.artifact,
        artifact_path: d.artifact_path,
      };
    } else {
      // Phase 1 behavior: one teammate per role per team, keyed by
      // the role name directly.
      teammateState[d.role] = {
        role: d.role,
        artifact: d.artifact,
        artifact_path: d.artifact_path,
      };
    }
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
