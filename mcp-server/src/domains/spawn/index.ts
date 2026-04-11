/**
 * Canon spawn module — pure spawn-prompt assembly library.
 *
 * Phase 1 of the Canon → agent teams migration. This module is the sole
 * context-injection channel for teammates in agent-teams mode, because
 * teammate sessions do not observe UserPromptSubmit or SessionStart hooks.
 * Everything the teammate needs must be in the spawn prompt at creation
 * time.
 *
 * This is a pure function with no I/O. Callers (lead-mode.ts) are
 * responsible for reading principles, file context, conventions, and
 * upstream artifact contents and passing them via the input. This keeps
 * the module trivially testable and free of hidden dependencies on the
 * MCP server's runtime state.
 *
 * Scope: Phase 1 only — the input schema is intentionally minimal.
 * Additional priming (domain-specific conventions, KG context, etc.) will
 * be layered in Phase 2 as the remaining flows are converted.
 */

/** Canon roles recognized by the spawn module. Matches agents/<role>.md. */
export type CanonRole =
  | "canon-architect"
  | "canon-chat"
  | "canon-fixer"
  | "canon-guide"
  | "canon-implementor"
  | "canon-learner"
  | "canon-researcher"
  | "canon-reviewer"
  | "canon-scribe"
  | "canon-security"
  | "canon-shipper"
  | "canon-tester"
  | "canon-writer";

/** High-level task categories. Selects prompt shaping for each role. */
export type TaskType =
  | "research"
  | "design"
  | "implement"
  | "review"
  | "test"
  | "fix"
  | "security"
  | "ship"
  | "scribe"
  | "explore"
  | "chat"
  | "write"
  | "learn"
  // Phase 2: task-type tags added for the six converted flows. These select
  // prompt-shaping guidance without branching per-role inside the assembler.
  | "refactor"
  | "migrate"
  | "security-audit"
  | "test-gap";

/** Reference to an upstream artifact the spawned teammate must read. */
export type UpstreamArtifactRef = {
  /** Short description to include in the prompt. */
  description?: string;
  /** Logical artifact id, e.g. "research_synthesis". */
  id: string;
  /** Path relative to the workspace root (`.canon/workspaces/<id>/`). */
  path: string;
  /** Role that produced the artifact. */
  produced_by: CanonRole;
};

/**
 * Wave-scoped context for a **single spawned teammate**. Phase 2 addition.
 *
 * When present in {@link AssembleSpawnPromptInput}, the completion contract
 * renders a wave-scoped artifact path of the shape
 *     `plans/<slug>/<task_id><SUFFIX>`
 * where SUFFIX comes from {@link WAVE_ARTIFACT_SUFFIXES}. When absent, the
 * prompt falls back to the flat contract in ROLE_ARTIFACT_CONTRACTS (Phase 1
 * behavior, byte-identical).
 *
 * Phase 2 only writes one teammate per (slug, task_id, role) tuple. Phase 3
 * may extend this with wave-level metadata once adaptive wave planning lands.
 *
 * ## Relationship to `PlanRunWaveContext`
 *
 * The orchestration layer defines a sibling type `PlanRunWaveContext` in
 * `features/orchestration/lead-mode.ts` that carries the **entire plan's**
 * wave context (a single slug plus an ordered list of task ids). That type
 * is one-to-many with this one: `planRun` fans `PlanRunWaveContext.task_ids`
 * out into N `WaveContext` instances — one per wave teammate it spawns.
 * Think of it as:
 *
 *     PlanRunWaveContext = { slug, task_ids: [t1, t2, t3] }
 *                          ↓
 *     WaveContext[]      = [{slug, task_id: t1}, {slug, task_id: t2}, {slug, task_id: t3}]
 *
 * The singular `WaveContext` lives in `domains/spawn/` because the spawn
 * module operates on a single teammate at a time. The plural
 * `PlanRunWaveContext` lives in the orchestration layer because it
 * represents a caller-supplied input to `planRun`, which is where wave
 * fan-out actually happens.
 */
export interface WaveContext {
  /** Plan-index slug — matches `plans/<slug>/INDEX.md` on disk. */
  slug: string;
  /** Per-task id — matches the task id column in `plans/<slug>/INDEX.md`. */
  task_id: string;
}

/** Input to the spawn-prompt assembler. */
export type AssembleSpawnPromptInput = {
  /** Canon role to spawn. */
  role: CanonRole;
  /** Files the teammate is expected to read/modify. Relative or absolute. */
  target_files: string[];
  /** Task type — selects role-specific priming. */
  task_type: TaskType;
  /** Upstream artifacts the teammate must consume. */
  upstream_artifact_refs: UpstreamArtifactRef[];
  /**
   * Optional wave context. Phase 2 addition. When present, the completion
   * contract renders the wave-scoped artifact path for the given (slug,
   * task_id) and the role's entry in {@link WAVE_ARTIFACT_SUFFIXES}. When
   * absent (Phase 1 default), the flat contract from
   * {@link ROLE_ARTIFACT_CONTRACTS} is used instead.
   */
  wave_context?: WaveContext;
  /** Workspace identifier (matches `.canon/workspaces/<id>/`). */
  workspace_id: string;
};

/**
 * Describes what artifact a given role is expected to produce and under
 * which path inside the workspace. Used for the task-completion contract
 * section of the spawn prompt.
 */
type RoleArtifactContract = {
  /** Logical id — matches the ids emitted by runbooks. */
  artifact_id: string;
  /** Path relative to the workspace root. */
  artifact_path: string;
  /** Short human label for the artifact. */
  label: string;
  /** Template-path hint the role should follow, if any. */
  template?: string;
};

/** Canonical artifact contract per role. */
const ROLE_ARTIFACT_CONTRACTS: Record<CanonRole, RoleArtifactContract> = {
  "canon-architect": {
    artifact_id: "plan_index",
    artifact_path: "plans/INDEX.md",
    label: "Plan index",
    template: "templates/plan-index.md",
  },
  "canon-chat": {
    artifact_id: "discussion_brief",
    artifact_path: "decisions/DISCUSSION.md",
    label: "Discussion brief",
  },
  "canon-fixer": {
    artifact_id: "fix_summary",
    artifact_path: "plans/FIX-SUMMARY.md",
    label: "Fix summary",
  },
  "canon-guide": {
    artifact_id: "guide_response",
    artifact_path: "decisions/GUIDE.md",
    label: "Guide response",
  },
  "canon-implementor": {
    artifact_id: "implementation_summary",
    artifact_path: "plans/SUMMARY.md",
    label: "Implementation summary",
    template: "templates/implementation-log.md",
  },
  "canon-learner": {
    artifact_id: "learning_report",
    artifact_path: "decisions/LEARNING.md",
    label: "Learning report",
  },
  "canon-researcher": {
    artifact_id: "research_synthesis",
    artifact_path: "research/SYNTHESIS.md",
    label: "Research synthesis",
    template: "templates/research-synthesis.md",
  },
  "canon-reviewer": {
    artifact_id: "review",
    artifact_path: "reviews/REVIEW.md",
    label: "Review verdict",
    template: "templates/review.md",
  },
  "canon-scribe": {
    artifact_id: "context_sync",
    artifact_path: "decisions/CONTEXT-SYNC.md",
    label: "Context sync report",
  },
  "canon-security": {
    artifact_id: "security_assessment",
    artifact_path: "reviews/SECURITY.md",
    label: "Security assessment",
  },
  "canon-shipper": {
    artifact_id: "ship_notes",
    artifact_path: "plans/SHIP.md",
    label: "Ship notes",
  },
  "canon-tester": {
    artifact_id: "test_report",
    artifact_path: "reviews/TEST-REPORT.md",
    label: "Test report",
  },
  "canon-writer": {
    artifact_id: "principle_draft",
    artifact_path: "decisions/PRINCIPLE-DRAFT.md",
    label: "Principle draft",
  },
};

/**
 * Per-role file-name suffix used when a teammate spawns inside a wave.
 *
 * Phase 2 addition. Wave-expanded steps write to
 *     `plans/<slug>/<task_id><SUFFIX>`
 * where <SUFFIX> comes from this table. The leading `-` is intentional:
 * task ids match /^[a-zA-Z0-9_-]+$/ (see `write-plan-index.ts`), so the
 * concatenation `<task_id>-<ROLE>.md` is the stable on-disk shape Canon's
 * wave runtime has used since before the migration began.
 *
 * Only the roles that can appear inside a wave are represented. The
 * single-agent roles (`canon-guide`, `canon-chat`, `canon-writer`,
 * `canon-learner`) never participate in waves and are omitted — passing
 * them to {@link resolveWaveArtifactPath} throws. That limit is deliberate:
 * it catches misauthored runbooks at plan time rather than blowing up
 * inside the prompt assembler.
 */
const WAVE_ARTIFACT_SUFFIXES: Partial<Record<CanonRole, string>> = {
  "canon-researcher": "-RESEARCH.md",
  "canon-architect": "-DESIGN.md",
  "canon-implementor": "-SUMMARY.md",
  "canon-reviewer": "-REVIEW.md",
  "canon-tester": "-TEST-REPORT.md",
  "canon-fixer": "-FIX-SUMMARY.md",
  "canon-security": "-SECURITY.md",
  "canon-scribe": "-CONTEXT-SYNC.md",
  "canon-shipper": "-SHIP.md",
};

/**
 * Resolve the on-disk artifact path for a wave-expanded teammate spawn.
 *
 * Phase 2 wave runtime. Returns the relative path (under
 * `.canon/workspaces/<workspace_id>/`) where the teammate is expected to
 * write its artifact. Callers (lead-mode.ts planRun) pass this path into
 * the completion-contract section of the spawn prompt and into the
 * workspace-local task-artifacts.json so the TaskCompleted hook can look
 * it up by task id.
 *
 * Contract:
 *   - `slug` must be a non-empty string matching /^[a-zA-Z0-9_-]+$/ (the
 *     same pattern `write-plan-index.ts` enforces for plan-index slugs).
 *   - `task_id` must match the same pattern.
 *   - `role` must have an entry in {@link WAVE_ARTIFACT_SUFFIXES}; single-
 *     agent roles throw here to catch authoring mistakes early.
 *
 * This helper is deliberately dumb string concatenation. It does no I/O,
 * never reads the workspace directory, and never allocates a real path.
 */
export function resolveWaveArtifactPath(
  role: CanonRole,
  context: WaveContext,
): string {
  const suffix = WAVE_ARTIFACT_SUFFIXES[role];
  if (!suffix) {
    throw new Error(
      `resolveWaveArtifactPath: role "${role}" is not wave-compatible (no entry in WAVE_ARTIFACT_SUFFIXES)`,
    );
  }
  if (!context.slug || !SLUG_OR_TASK_ID_PATTERN.test(context.slug)) {
    throw new Error(
      `resolveWaveArtifactPath: invalid slug ${JSON.stringify(context.slug)}; must match /^[a-zA-Z0-9_-]+$/`,
    );
  }
  if (!context.task_id || !SLUG_OR_TASK_ID_PATTERN.test(context.task_id)) {
    throw new Error(
      `resolveWaveArtifactPath: invalid task_id ${JSON.stringify(context.task_id)}; must match /^[a-zA-Z0-9_-]+$/`,
    );
  }
  return `plans/${context.slug}/${context.task_id}${suffix}`;
}

/**
 * Slug / task-id validation pattern. Mirrors the pattern used by
 * `write-plan-index.ts` so the spawn module and the plan-index writer
 * stay in lockstep without either importing the other.
 */
const SLUG_OR_TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * List of roles that can appear inside a wave. Derived from
 * {@link WAVE_ARTIFACT_SUFFIXES} and exposed for tests and the runbook
 * loader, which rejects `wave: true` steps that use a non-wave role.
 */
export const WAVE_COMPATIBLE_ROLES: readonly CanonRole[] = Object.freeze(
  Object.keys(WAVE_ARTIFACT_SUFFIXES) as CanonRole[],
);

/**
 * Return the canonical wave file-name suffix for a role (e.g. `-SUMMARY.md`
 * for `canon-implementor`) or `undefined` if the role never participates
 * in waves. Exposed so callers that need the suffix — e.g. lead-mode's
 * wave-to-flat fan-in glob synthesizer — can avoid fragile regex
 * splitting on concrete paths that embed the suffix inside the task id.
 */
export function getWaveArtifactSuffix(role: CanonRole): string | undefined {
  return WAVE_ARTIFACT_SUFFIXES[role];
}

/** Role-specific task-type guidance block. */
function taskTypeGuidance(role: CanonRole, taskType: TaskType): string {
  const common: Partial<Record<TaskType, string>> = {
    chat: "Discuss the topic. If the discussion converges on action, capture a brief.",
    design:
      "Design a concrete plan of attack. Reference Canon principles. Do NOT write code. Produce a plan index that downstream implementors can follow task by task.",
    explore: "Answer the investigation question. Cite files and line numbers. Do NOT modify code.",
    fix: "Resolve the failing tests or violated principles in place. Preserve behavior. Commit atomically.",
    implement:
      "Execute the plan: write code, run tests, and commit. Follow Canon principles and keep diffs minimal.",
    learn: "Analyze patterns, propose improvements, and produce a learning report.",
    // Phase 2 task-type extensions (migrate, refactor, security-audit, test-gap)
    // live inline in alphabetical order below. Each selects a slightly
    // different framing of the existing role brief so the assembler does
    // not need to branch per-role on new flow conversions. The kebab-case
    // form matches the runbook filenames / flow names (flows/test-gap.md,
    // skills/canon/runbooks/security-audit.yaml) — one spelling per
    // concept per `ubiquitous-language-in-code`.
    migrate:
      "Move the codebase from one technology, API, or schema to another. Plan migration waves, keep both sides working during cutover when feasible, and record a rollback path in the artifact.",
    refactor:
      "Restructure existing code without changing observable behavior. Preserve public contracts, keep diffs surgical, and ensure every refactor step is covered by tests before and after.",
    research:
      "Investigate the target files and surrounding code. Do NOT write code. Produce a compressed findings document under the artifact path below.",
    review:
      "Review the diff for correctness, Canon principle compliance, and drift from plan. Emit a verdict: clean | concerns | blocking.",
    scribe: "Update CLAUDE.md and related context documents to reflect contract-level changes.",
    security:
      "Identify security vulnerabilities, unsafe patterns, and compliance issues. Rank findings by severity.",
    "security-audit":
      "Audit for security vulnerabilities, misuse of auth/authz, secret handling, injection surfaces, and unsafe defaults. Rank findings by blast radius and exploitability. Do NOT attempt fixes in the audit step.",
    ship: "Synthesize build artifacts into a PR description and changelog entry.",
    test: "Write or extend tests. Run the suite. Report pass/fail counts and any newly-discovered gaps.",
    "test-gap":
      "Inventory test coverage gaps for the pinned targets. Add missing tests that exercise meaningful behavior, not line coverage. Report pass/fail counts and any regressions surfaced while writing the tests.",
    write: "Draft or edit a Canon principle following the principle template.",
  };
  const override: Partial<Record<CanonRole, string>> = {
    "canon-architect":
      "You are the architect. Favor the smallest correct design that satisfies the research synthesis and Canon principles.",
    "canon-reviewer":
      "You are the reviewer. Do not modify code. Produce a verdict block and a concrete list of required changes.",
  };
  return override[role] ?? common[taskType] ?? "Execute the task as described in the role brief.";
}

/** Format the upstream-artifact block. */
function renderUpstreamArtifacts(refs: readonly UpstreamArtifactRef[]): string {
  if (refs.length === 0) {
    return "_No upstream artifacts — this is an entry-point step._";
  }
  const lines = refs.map((ref) => {
    const desc = ref.description ? ` — ${ref.description}` : "";
    return `- \`${ref.path}\` (id: \`${ref.id}\`, produced by \`${ref.produced_by}\`)${desc}`;
  });
  lines.push("");
  lines.push(
    "Read every upstream artifact before starting work. Quote relevant lines by path:line when you cite them.",
  );
  return lines.join("\n");
}

/** Format the target-files block. */
function renderTargetFiles(files: readonly string[]): string {
  if (files.length === 0) {
    return "_No target files pinned — use your tools to locate the relevant files._";
  }
  return files.map((f) => `- \`${f}\``).join("\n");
}

/** Format the task-completion contract block. */
function renderCompletionContract(
  role: CanonRole,
  contract: RoleArtifactContract,
  workspaceId: string,
  waveContext: WaveContext | undefined,
): string {
  // In a wave context the teammate writes to a per-task-id path under
  // plans/<slug>/. The flat contract's artifact_id stays the same — it
  // is the logical id downstream steps use to reference this artifact —
  // but the physical path changes. When wave_context is omitted we fall
  // back to the Phase 1 byte-identical behavior.
  const artifactPath = waveContext
    ? resolveWaveArtifactPath(role, waveContext)
    : contract.artifact_path;

  const lines: string[] = [];
  lines.push(`You are acting as **${role}**.`);
  lines.push("");
  if (waveContext) {
    lines.push(
      `## Wave context\n\n- Slug: \`${waveContext.slug}\`\n- Task id: \`${waveContext.task_id}\``,
    );
    lines.push("");
  }
  lines.push("## Required artifact");
  lines.push("");
  lines.push(`- **${contract.label}** (id: \`${contract.artifact_id}\`)`);
  lines.push(
    `- Must exist under the workspace at: \`.canon/workspaces/${workspaceId}/${artifactPath}\``,
  );
  if (contract.template) {
    lines.push(`- Follow the template: \`${contract.template}\``);
  }
  lines.push("");
  lines.push("## Completion rules");
  lines.push("");
  lines.push(
    "1. Produce the artifact at the exact path above. The `TaskCompleted` hook blocks task completion if the file is missing or empty.",
  );
  lines.push("2. Mark your task complete (via the task list) only after the artifact is written.");
  lines.push(
    "3. If you cannot produce the artifact, leave the task in-progress and emit a short explanation instead of forcing completion.",
  );
  if (waveContext) {
    lines.push(
      "4. Do NOT write to the flat Phase 1 path (`" +
        contract.artifact_path +
        "`). This teammate is part of a wave — every teammate in the wave has its own per-task-id path under `plans/`.",
    );
  }
  return lines.join("\n");
}

/**
 * Assemble a complete spawn prompt for a Canon teammate in agent-teams mode.
 *
 * Pure function: no I/O, no filesystem access, no external calls. Given
 * the same input, returns the same output. Suitable for unit tests with
 * deterministic fixtures.
 */
export function assembleSpawnPrompt(input: AssembleSpawnPromptInput): string {
  const {
    role,
    task_type,
    target_files,
    upstream_artifact_refs,
    workspace_id,
    wave_context,
  } = input;
  const contract = ROLE_ARTIFACT_CONTRACTS[role];
  if (!contract) {
    throw new Error(`assembleSpawnPrompt: unknown role "${role}"`);
  }
  if (wave_context && !WAVE_ARTIFACT_SUFFIXES[role]) {
    // Fail early on misauthored wave runbooks: if a wave: true step
    // specifies a role that never appears inside waves (e.g. canon-guide),
    // resolveWaveArtifactPath would throw deep inside the contract
    // renderer with a confusing stack. Surface it at the top instead.
    throw new Error(
      `assembleSpawnPrompt: role "${role}" is not wave-compatible but wave_context was supplied`,
    );
  }

  const header = `# Canon teammate: ${role}`;
  const subheader = wave_context
    ? `Task type: \`${task_type}\` · Workspace: \`${workspace_id}\` · Wave task: \`${wave_context.task_id}\``
    : `Task type: \`${task_type}\` · Workspace: \`${workspace_id}\``;

  const sections: string[] = [
    header,
    "",
    subheader,
    "",
    "## Role brief",
    "",
    taskTypeGuidance(role, task_type),
    "",
    "## Target files",
    "",
    renderTargetFiles(target_files),
    "",
    "## Upstream artifacts",
    "",
    renderUpstreamArtifacts(upstream_artifact_refs),
    "",
    "## Canon principles",
    "",
    "Consult the principles layer before acting. Rules are blocking; strong-opinions require justification to deviate; conventions are advisory. Cite principle ids in your artifact when they informed a decision.",
    "",
    "## Task-completion contract",
    "",
    renderCompletionContract(role, contract, workspace_id, wave_context),
    "",
  ];

  return sections.join("\n");
}

/**
 * Return the canonical artifact contract for a role. Exposed for runbook
 * loaders that need to look up the expected artifact path without re-running
 * the full prompt assembler.
 */
export function getRoleArtifactContract(role: CanonRole): RoleArtifactContract {
  const contract = ROLE_ARTIFACT_CONTRACTS[role];
  if (!contract) {
    throw new Error(`getRoleArtifactContract: unknown role "${role}"`);
  }
  return { ...contract };
}

/** All roles recognized by the spawn module. Useful for tests and callers. */
export const CANON_ROLES: readonly CanonRole[] = Object.keys(
  ROLE_ARTIFACT_CONTRACTS,
) as CanonRole[];
