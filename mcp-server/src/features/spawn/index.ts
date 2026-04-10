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
  | "learn";

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
    research:
      "Investigate the target files and surrounding code. Do NOT write code. Produce a compressed findings document under the artifact path below.",
    review:
      "Review the diff for correctness, Canon principle compliance, and drift from plan. Emit a verdict: clean | concerns | blocking.",
    scribe: "Update CLAUDE.md and related context documents to reflect contract-level changes.",
    security:
      "Identify security vulnerabilities, unsafe patterns, and compliance issues. Rank findings by severity.",
    ship: "Synthesize build artifacts into a PR description and changelog entry.",
    test: "Write or extend tests. Run the suite. Report pass/fail counts and any newly-discovered gaps.",
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
): string {
  const lines: string[] = [];
  lines.push(`You are acting as **${role}**.`);
  lines.push("");
  lines.push("## Required artifact");
  lines.push("");
  lines.push(`- **${contract.label}** (id: \`${contract.artifact_id}\`)`);
  lines.push(
    `- Must exist under the workspace at: \`.canon/workspaces/${workspaceId}/${contract.artifact_path}\``,
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
  const { role, task_type, target_files, upstream_artifact_refs, workspace_id } = input;
  const contract = ROLE_ARTIFACT_CONTRACTS[role];
  if (!contract) {
    throw new Error(`assembleSpawnPrompt: unknown role "${role}"`);
  }

  const header = `# Canon teammate: ${role}`;
  const subheader = `Task type: \`${task_type}\` · Workspace: \`${workspace_id}\``;

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
    renderCompletionContract(role, contract, workspace_id),
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
