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
import {
  assembleSpawnPrompt,
  CANON_ROLES,
  type CanonRole,
  getRoleArtifactContract,
  getWaveArtifactSuffix,
  resolveWaveArtifactPath,
  type TaskType,
  type UpstreamArtifactRef,
  WAVE_COMPATIBLE_ROLES,
  type WaveContext,
} from "@domains/spawn/index.ts";
import { type ReadTaskListOptions, readTasksByStatus } from "@domains/task-list/index.ts";
import { parse as parseYaml } from "yaml";

/** HITL gate values recognized in a runbook step. */
export type RunbookHitl = false | "after" | "after_if_verdict_not_clean";

/** One step in a runbook. */
export type RunbookStep = {
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
  role: CanonRole;
  task_type: TaskType;
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
};

/** Parsed runbook contents. */
export type Runbook = {
  description: string;
  name: string;
  steps: RunbookStep[];
  tier: "small" | "medium" | "large";
};

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
export type PlanRunWaveContext = {
  /** Stable plan-index slug. Must match /^[a-zA-Z0-9_-]+$/. */
  slug: string;
  /** Ordered list of task ids. Empty is rejected at plan time. */
  task_ids: string[];
};

/** Input to `planRun`. */
export type PlanRunInput = {
  runbook: Runbook;
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
  workspace_id: string;
};

/** Output of `planRun`: an ordered list of spawn descriptors. */
export type SpawnDescriptor = {
  /** Artifact this step is required to produce (logical id). */
  artifact: string;
  /** Artifact path relative to the workspace root. */
  artifact_path: string;
  /** HITL policy for this step. */
  hitl: RunbookHitl;
  /** Logical artifact ids the step depends on. */
  required_artifacts: string[];
  /** Canon role to spawn. */
  role: CanonRole;
  /** Fully assembled spawn prompt. */
  spawn_prompt: string;
  /**
   * Stable per-descriptor id. Flat (Phase 1) shape:
   *     `<runbook_name>-<NN>-<role>`
   * Wave-expanded (Phase 2) shape:
   *     `<runbook_name>-<slug>-<task_id>-<role>`
   * Both shapes round-trip through the workspace-local state files and
   * the hooks look up either one by exact match.
   */
  task_id: string;
  /** Task type tag passed to the spawn module. */
  task_type: TaskType;
  /**
   * Phase 2 addition. Present only on descriptors produced from a
   * `wave: true` step. Carries the concrete (slug, task_id) pair used
   * to derive the artifact path so downstream tools (the smoke-test
   * harness, observability) can inspect the expansion without re-parsing
   * the task id string.
   */
  wave_context?: WaveContext;
};

/** The state file format consumed by the workspace-local hooks. */
export type TaskArtifactState = {
  [task_id: string]: {
    role: CanonRole;
    artifact: string;
    artifact_path: string;
  };
};

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
export async function loadRunbook(pluginDir: string, name: string): Promise<Runbook> {
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
    throw new RunbookError(`Failed to parse runbook YAML at ${source}: ${(err as Error).message}`);
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
    throw new RunbookError(`Runbook "${name}" is missing a string "description"`);
  }
  if (tier !== "small" && tier !== "medium" && tier !== "large") {
    throw new RunbookError(`Runbook "${name}" has invalid tier ${JSON.stringify(tier)}`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new RunbookError(`Runbook "${name}" must declare at least one step`);
  }

  const parsedSteps: RunbookStep[] = steps.map((step, index) => parseStep(step, name, index));
  return { description, name, steps: parsedSteps, tier };
}

function parseStep(raw: unknown, runbookName: string, index: number): RunbookStep {
  const s = requireStepObject(raw, runbookName, index);
  const ctx = `Runbook "${runbookName}" step ${index}`;
  const role = requireCanonRole(s.role, ctx);
  const wave = parseOptionalBooleanField(s, "wave", ctx);
  // Phase 2: `wave: true` steps must use a role that is registered in
  // WAVE_COMPATIBLE_ROLES. Single-agent roles (canon-guide, canon-chat,
  // canon-writer, canon-learner) never participate in waves and would
  // blow up downstream in the spawn assembler if we let them through.
  if (wave === true && !WAVE_COMPATIBLE_ROLES.includes(role)) {
    throw new RunbookError(
      `${ctx}: role ${role} is not wave-compatible (see WAVE_COMPATIBLE_ROLES)`,
    );
  }
  const step: RunbookStep = {
    artifact: requireString(s, "artifact", ctx),
    artifact_path: requireString(s, "artifact_path", ctx),
    hitl: requireHitl(s.hitl, ctx),
    required_artifacts: requireStringArray(s.required_artifacts, "required_artifacts", ctx),
    role,
    task_type: requireString(s, "task_type", ctx) as TaskType,
  };
  if (wave !== undefined) {
    step.wave = wave;
  }
  return step;
}

/**
 * Phase 2 helper. Reads an optional boolean field from a raw step
 * object. Returns `undefined` when the field is absent (preserving
 * Phase 1 byte-compatibility for runbooks that don't set `wave:`).
 * Throws when the field is present but not a boolean — this catches
 * typos like `wave: yes` at parse time rather than letting them
 * silently expand into a truthy string.
 */
function parseOptionalBooleanField(
  obj: Record<string, unknown>,
  field: string,
  ctx: string,
): boolean | undefined {
  const raw = obj[field];
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  throw new RunbookError(
    `${ctx}: ${field} must be a boolean if present, got ${JSON.stringify(raw)}`,
  );
}

function requireStepObject(
  raw: unknown,
  runbookName: string,
  index: number,
): Record<string, unknown> {
  if (raw === null || typeof raw !== "object") {
    throw new RunbookError(
      `Runbook "${runbookName}" step ${index}: expected object, got ${typeof raw}`,
    );
  }
  return raw as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string, ctx: string): string {
  const value = obj[field];
  if (typeof value !== "string") {
    throw new RunbookError(`${ctx}: missing string "${field}"`);
  }
  return value;
}

function requireCanonRole(raw: unknown, ctx: string): CanonRole {
  if (typeof raw !== "string" || !CANON_ROLES.includes(raw as CanonRole)) {
    throw new RunbookError(`${ctx}: unknown role ${JSON.stringify(raw)}`);
  }
  return raw as CanonRole;
}

function requireHitl(raw: unknown, ctx: string): RunbookHitl {
  if (raw === false) return false;
  if (raw === "after" || raw === "after_if_verdict_not_clean") return raw;
  throw new RunbookError(`${ctx}: invalid hitl value ${JSON.stringify(raw)}`);
}

function requireStringArray(raw: unknown, field: string, ctx: string): string[] {
  const source = raw ?? [];
  if (!Array.isArray(source)) {
    throw new RunbookError(`${ctx}: ${field} must be an array`);
  }
  return source.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new RunbookError(`${ctx}: ${field}[${i}] must be a string`);
    }
    return entry;
  });
}

/** Expected template shape of a wave step's declared artifact path. */
const WAVE_PATH_TEMPLATE_RE = /^plans\/<slug>\/<task_id>-[A-Z][A-Z0-9-]*\.md$/;

/**
 * Running index of which step produced which logical artifact. Phase 1
 * steps set `path` to the single flat output; Phase 2 wave-expanded
 * steps set `wavePaths` to a map of `task_id → per-task path` so a
 * downstream step (flat or wave) can resolve its upstream ref by task
 * id. Exactly one of `path` or `wavePaths` is populated per entry.
 */
type ArtifactIndex = Map<
  string,
  {
    description?: string;
    path?: string;
    produced_by: CanonRole;
    wavePaths?: Map<string, string>;
  }
>;

/** Per-step context threaded through `buildStepDescriptor`. */
type StepContext = {
  artifactIndex: ArtifactIndex;
  index: number;
  runbook: Runbook;
  step: RunbookStep;
  target_files: string[];
  workspace_id: string;
};

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
  // supply a wave_context with at least one task id, a valid slug, and
  // a unique set of task ids. Raise recognisable RunbookErrors here
  // rather than letting failures surface deep inside assembleSpawnPrompt.
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
    const seenTaskIds = new Set<string>();
    for (const tid of wave_context.task_ids) {
      if (!/^[a-zA-Z0-9_-]+$/.test(tid)) {
        throw new RunbookError(
          `Runbook "${runbook.name}" wave_context.task_ids contains invalid id ${JSON.stringify(tid)}; must match /^[a-zA-Z0-9_-]+$/`,
        );
      }
      if (seenTaskIds.has(tid)) {
        throw new RunbookError(
          `Runbook "${runbook.name}" wave_context.task_ids contains duplicate id ${JSON.stringify(tid)}; each task id must appear at most once per wave`,
        );
      }
      seenTaskIds.add(tid);
    }
  }

  const artifactIndex: ArtifactIndex = new Map();
  const descriptors: SpawnDescriptor[] = [];

  for (let i = 0; i < runbook.steps.length; i++) {
    const step = runbook.steps[i]!;

    if (step.wave !== true) {
      // Phase 1 flat path — delegate to the refactored helper that base
      // extracted. It handles artifact-id / artifact_path cross-checks,
      // upstream ref resolution (including wave-to-flat glob synthesis),
      // spawn prompt assembly, and descriptor construction.
      const descriptor = buildStepDescriptor({
        artifactIndex,
        index: i,
        runbook,
        step,
        target_files,
        workspace_id,
      });
      descriptors.push(descriptor);
      artifactIndex.set(step.artifact, {
        path: descriptor.artifact_path,
        produced_by: step.role,
      });
      continue;
    }

    // Phase 2 wave-expanded step — inline expansion, one descriptor per
    // task id supplied in wave_context. We cannot delegate to
    // buildStepDescriptor here because the step shape is one-to-many.
    if (!wave_context) {
      // Already caught by the top-of-function guard; belt-and-suspenders.
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
    // wave path for this role by materializing a sample expansion with
    // a placeholder slug/task_id and comparing shapes.
    const templateSample = resolveWaveArtifactPath(step.role, {
      slug: "PROBE",
      task_id: "PROBE",
    });
    const templateShape = templateSample.replace("PROBE/PROBE", "<slug>/<task_id>");
    if (step.artifact_path !== templateShape) {
      throw new RunbookError(
        `Runbook "${runbook.name}" step ${i}: declared wave artifact_path ${step.artifact_path} does not match the canonical wave shape for role ${step.role} (${templateShape})`,
      );
    }
    const contract = getRoleArtifactContract(step.role);
    if (contract.artifact_id !== step.artifact) {
      throw new RunbookError(
        `Runbook "${runbook.name}" step ${i}: artifact id ${step.artifact} does not match canonical contract ${contract.artifact_id} for role ${step.role}`,
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
        artifact: step.artifact,
        artifact_path: concretePath,
        hitl: step.hitl,
        required_artifacts: step.required_artifacts,
        role: step.role,
        spawn_prompt,
        task_id: expandedId,
        task_type: step.task_type,
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

/** Validate a step, resolve its upstream refs, and assemble its prompt. */
function buildStepDescriptor(ctx: StepContext): SpawnDescriptor {
  const { step, index, runbook, workspace_id, target_files, artifactIndex } = ctx;
  assertContractMatches(step, index, runbook);
  // resolveUpstreamRefsForFlatStep handles both same-flat upstreams and
  // wave-to-flat fan-in globs; base's resolveUpstreamRefs helper was
  // removed during the Phase 2 merge because it assumed hit.path was
  // always defined, which is not true after wave-expanded steps exist.
  const upstream = resolveUpstreamRefsForFlatStep(step, index, runbook, artifactIndex);
  const task_id = `${runbook.name}-${String(index).padStart(2, "0")}-${step.role}`;
  const spawn_prompt = assembleSpawnPrompt({
    role: step.role,
    target_files,
    task_type: step.task_type,
    upstream_artifact_refs: upstream,
    workspace_id,
  });
  return {
    artifact: step.artifact,
    artifact_path: step.artifact_path,
    hitl: step.hitl,
    required_artifacts: step.required_artifacts,
    role: step.role,
    spawn_prompt,
    task_id,
    task_type: step.task_type,
  };
}

/**
 * Validate that the step's declared artifact matches the role's canonical
 * contract. The spawn prompt embeds the canonical path; a mismatch would
 * silently diverge from what the hooks enforce.
 */
function assertContractMatches(step: RunbookStep, index: number, runbook: Runbook): void {
  const contract = getRoleArtifactContract(step.role);
  if (contract.artifact_path !== step.artifact_path) {
    throw new RunbookError(
      `Runbook "${runbook.name}" step ${index}: artifact_path ${step.artifact_path} does not match canonical contract ${contract.artifact_path} for role ${step.role}`,
    );
  }
  if (contract.artifact_id !== step.artifact) {
    throw new RunbookError(
      `Runbook "${runbook.name}" step ${index}: artifact id ${step.artifact} does not match canonical contract ${contract.artifact_id} for role ${step.role}`,
    );
  }
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
  runbook: Runbook,
  artifactIndex: ArtifactIndex,
): UpstreamArtifactRef[] {
  return step.required_artifacts.map((refId) => {
    const hit = artifactIndex.get(refId);
    if (!hit) {
      throw new RunbookError(
        `Runbook "${runbook.name}" step ${index} (${step.role}): required artifact "${refId}" is not produced by any earlier step`,
      );
    }
    if (hit.path !== undefined) {
      return {
        description: hit.description,
        id: refId,
        path: hit.path,
        produced_by: hit.produced_by,
      };
    }
    // Wave upstream — synthesize a glob-shaped path so the flat consumer
    // has a concrete pointer into the wave output directory.
    if (!hit.wavePaths || hit.wavePaths.size === 0) {
      throw new RunbookError(
        `Runbook "${runbook.name}" step ${index} (${step.role}): wave upstream "${refId}" produced zero per-task artifacts`,
      );
    }
    // Every wave entry lives in the same parent dir, so any one is fine
    // for the parent-dir extraction.
    const samplePath = hit.wavePaths.values().next().value!;
    const globPath = waveGlobFromSamplePath(samplePath, hit.produced_by);
    return {
      description: `Wave fan-in glob — one artifact per task id produced by the wave step (${hit.wavePaths.size} total).`,
      id: refId,
      path: globPath,
      produced_by: hit.produced_by,
    };
  });
}

/**
 * Derive a glob-shaped upstream path from a concrete wave artifact path.
 * Example:
 *     (`plans/fix-bug/t1-SUMMARY.md`, `canon-implementor`) → `plans/fix-bug/*-SUMMARY.md`
 *
 * Uses the authoritative suffix table from the spawn module rather than
 * regex-splitting the sample path. A regex approach is unsafe because a
 * task id may contain a hyphen followed by uppercase letters (e.g.
 * `foo-A1`), which would make the lazy regex latch onto the wrong
 * boundary and silently narrow the glob to only match that one task id.
 *
 * Falls back to the sample path unchanged if the parent dir cannot be
 * extracted or the role has no registered wave suffix — both are
 * unreachable in the happy path (`produced_by` must be a
 * wave-compatible role for the wavePaths entry to exist in the first
 * place) but we never throw here to keep planRun pure.
 */
function waveGlobFromSamplePath(samplePath: string, role: CanonRole): string {
  const suffix = getWaveArtifactSuffix(role);
  if (!suffix) return samplePath;
  const lastSlash = samplePath.lastIndexOf("/");
  if (lastSlash < 0) return samplePath;
  return `${samplePath.slice(0, lastSlash + 1)}*${suffix}`;
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
  artifactIndex: ArtifactIndex,
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
        description: hit.description,
        id: refId,
        path: hit.path,
        produced_by: hit.produced_by,
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
      description: hit.description,
      id: refId,
      path: p,
      produced_by: hit.produced_by,
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
      artifact: d.artifact,
      artifact_path: d.artifact_path,
      role: d.role,
    };
    if (d.wave_context) {
      // Wave-expanded teammate — key the teammate state by the
      // expanded task id so the hook can resolve it. The flat role
      // name is intentionally NOT overwritten here; wave teammates do
      // not own the shared flat key, since multiple descriptors share
      // the same role and last-writer-wins would be misleading.
      teammateState[d.task_id] = {
        artifact: d.artifact,
        artifact_path: d.artifact_path,
        role: d.role,
      };
    } else {
      // Phase 1 behavior: one teammate per role per team, keyed by
      // the role name directly.
      teammateState[d.role] = {
        artifact: d.artifact,
        artifact_path: d.artifact_path,
        role: d.role,
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
export function assertLeadModeEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isLeadModeEnabled(env)) {
    throw new Error(`${LEAD_MODE_ENV_VAR} must be set to "on" to use lead-mode`);
  }
}

/**
 * Filter a descriptor list down to the descriptors whose tasks have not
 * yet been marked `completed` in the pinned Claude Code task list.
 *
 * This is the server-side half of the "cross-session resume" story
 * described in docs/agent-teams-mode.md. On resume, the team lead reads
 * the pinned task list via `CLAUDE_CODE_TASK_LIST_ID`, asks this
 * function for the set of descriptors that still need work, and spawns
 * teammates only for those.
 *
 * Pure with respect to the passed-in descriptors (no mutation). Reads
 * the task list directory lazily via `readTasksByStatus`; if the list
 * is empty (env unset, directory missing, etc.) every descriptor is
 * treated as still pending — matching the "first run" semantics.
 */
export function filterPendingDescriptors(
  descriptors: readonly SpawnDescriptor[],
  taskListOptions: ReadTaskListOptions = {},
): SpawnDescriptor[] {
  const completedIds = new Set(readTasksByStatus("completed", taskListOptions).map((t) => t.id));
  return descriptors.filter((d) => !completedIds.has(d.task_id));
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
  return { descriptors, runbook };
}

// Re-export types from the spawn module so callers can import one place.
export type { CanonRole, TaskType, UpstreamArtifactRef } from "@domains/spawn/index.ts";

// Explicitly mark that `dirname` is not unused — it's consumed by
// future lead-mode helpers that derive plugin paths from module urls.
// (Phase 1 does not exercise that path yet.)
void dirname;
