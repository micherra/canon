/**
 * Agent tool profile registry and resolver (ADR-014).
 *
 * Each agent has a declared set of allowed and disallowed tools. The
 * resolveToolProfile function applies optional per-spawn overrides and
 * computes the final tool list passed to the Agent spawn request.
 */

import type { ToolOverrides } from "@domains/flows/flow-definition-schemas.ts";

/** Base tool profile for an agent type. */
export type AgentToolProfile = {
  allowed: string[];
  disallowed: string[];
  /**
   * Optional path-prefix constraint for the Write tool.
   * When present, the agent's system prompt receives a hard constraint
   * restricting Write calls to these path prefixes only.
   * Post-hoc validation via validateLearnerOutput enforces this at runtime.
   */
  write_scope?: string[];
};

/** A structured audit warning produced by resolveToolProfile. */
export type ToolScopeWarning = {
  event: "adr014_replace_override_grants_disallowed";
  agent: string;
  granted_disallowed: string[];
};

/** Resolved tool configuration for a single agent spawn. */
export type ResolvedProfile = {
  tools: string[];
  disallowed_tools: string[];
  permission_mode: "auto" | "prompt" | "deny_unknown";
  /** Structured audit warnings — present when a replace override grants disallowed tools. */
  warnings?: ToolScopeWarning[];
};

/**
 * Fail-closed profile for unknown agents — no tools allowed.
 * Dangerous tools are explicitly disallowed so that tool_overrides.allow
 * cannot grant them to unknown agents (disallowed wins rule).
 */
export const EMPTY_PROFILE: AgentToolProfile = {
  allowed: [],
  disallowed: ["Edit", "Write", "Bash", "NotebookEdit"],
} as const;

/** Registry of declared tool profiles for all Canon agent types. */
export const AGENT_TOOL_PROFILES: Record<string, AgentToolProfile> = {
  "canon-architect": {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "graph_query",
      "get_file_context",
      "semantic_search",
      "codebase_graph",
      "write_plan_index",
      "update_board",
      "write_design_brief",
      "post_event",
    ],
    disallowed: ["Edit", "Write", "NotebookEdit"],
  },
  "canon-chat": {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "graph_query",
      "semantic_search",
      "get_file_context",
      "codebase_graph",
    ],
    disallowed: ["Edit", "Write", "Bash", "NotebookEdit"],
  },
  "canon-fixer": {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Edit",
      "Write",
      "graph_query",
      "semantic_search",
      "get_file_context",
      "post_event",
    ],
    disallowed: [],
  },
  "canon-guide": {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "graph_query",
      "semantic_search",
      "get_file_context",
      "codebase_graph",
    ],
    disallowed: ["Edit", "Write", "Bash", "NotebookEdit"],
  },
  "canon-implementor": {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "write_implementation_summary",
      "post_message",
      "get_messages",
      "graph_query",
      "post_event",
    ],
    disallowed: [],
  },
  "canon-learner": {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Write", // ADR-016: scoped to .canon/proposed-learnings/ via write_scope constraint
      "get_history",     // ADR-019: query execution history during pattern analysis
      "get_drift_report", // Query drift data for principle health
      "graph_query",
      "semantic_search",
      "get_file_context",
      "codebase_graph",
      "post_event",
    ],
    disallowed: ["Edit", "NotebookEdit"],
    // Hard path-prefix constraint injected into the agent prompt (Advisory 1 / ADR-016).
    // Post-hoc validation enforced by validateLearnerOutput in learn-gate.ts.
    write_scope: [".canon/proposed-learnings/"],
  },
  "canon-researcher": {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "WebFetch",
      "graph_query",
      "get_file_context",
      "semantic_search",
      "codebase_graph",
      "write_research_synthesis",
      "post_event",
    ],
    disallowed: ["Edit", "Write", "NotebookEdit"],
  },
  "canon-reviewer": {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "review_code",
      "write_review",
      "graph_query",
      "semantic_search",
      "get_file_context",
      "codebase_graph",
      "post_event",
    ],
    disallowed: ["Edit", "Write", "NotebookEdit"],
  },
  "canon-scribe": {
    allowed: ["Read", "Grep", "Glob", "Edit"],
    disallowed: ["Bash", "Write", "NotebookEdit"],
  },
  "canon-security": {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "graph_query",
      "get_file_context",
      "semantic_search",
      "codebase_graph",
      "post_event",
    ],
    disallowed: ["Edit", "Write", "NotebookEdit"],
  },
  "canon-shipper": {
    allowed: ["Read", "Grep", "Glob", "Bash", "post_event"],
    disallowed: ["Edit", "Write", "NotebookEdit"],
  },
  "canon-tester": {
    allowed: ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "write_test_report", "graph_query", "post_event"],
    disallowed: [],
  },
  "canon-writer": {
    allowed: ["Read", "Grep", "Glob", "Edit", "Write"],
    disallowed: ["Bash", "NotebookEdit"],
  },
} as const;

/**
 * Options for resolveToolProfile. All parameters beyond `agent` are optional
 * and grouped here for forward extensibility and readability.
 */
export type ResolveToolProfileOptions = {
  overrides?: ToolOverrides;
  worktreePath?: string;
  /**
   * Trust-derived permission mode from the KG-informed trust resolver.
   * Only "auto" | "prompt" (not "deny_unknown") because the trust resolver
   * only produces these two values. Precedence: overrides.permission_mode >
   * trustPermissionMode > worktreePath fallback.
   */
  trustPermissionMode?: "auto" | "prompt";
};

/**
 * Resolve the final tool profile for an agent spawn.
 *
 * Resolution algorithm:
 * 1. Look up base profile (fail-closed: unknown agents get EMPTY_PROFILE)
 * 2. Apply allowed overrides: replace > allow > base
 * 3. Apply disallowed overrides: deny extends base disallowed
 * 4. Disallowed wins: remove any disallowed tools from allowed
 * 5. Determine permission_mode: overrides.permission_mode > trustPermissionMode > worktree auto > prompt
 */
export const resolveToolProfile = (
  agent: string,
  options?: ResolveToolProfileOptions,
): ResolvedProfile => {
  const overrides = options?.overrides;
  const worktreePath = options?.worktreePath;
  const normalizedAgent = agent.startsWith("canon:") ? agent.slice("canon:".length) : agent;
  const base = AGENT_TOOL_PROFILES[normalizedAgent] ?? EMPTY_PROFILE;

  // Resolve effective allowed list
  let effectiveAllowed: string[];
  let warnings: ToolScopeWarning[] | undefined;
  if (overrides?.replace) {
    // Audit: collect a structured warning when replace grants tools that are in the
    // base disallowed list. This is permitted by the caller but must be persisted
    // to the SQLite event log — callers are responsible for forwarding warnings.
    const grantedDisallowed = overrides.replace.filter((t) => base.disallowed.includes(t));
    if (grantedDisallowed.length > 0) {
      warnings = [
        {
          agent,
          event: "adr014_replace_override_grants_disallowed",
          granted_disallowed: grantedDisallowed,
        },
      ];
    }
    effectiveAllowed = overrides.replace;
  } else if (overrides?.allow) {
    effectiveAllowed = [...base.allowed, ...overrides.allow];
  } else {
    effectiveAllowed = base.allowed;
  }

  // Resolve effective disallowed list
  const effectiveDisallowed: string[] = overrides?.deny
    ? [...base.disallowed, ...overrides.deny]
    : base.disallowed;

  // Disallowed wins — filter out any disallowed tools from allowed
  const finalAllowed = effectiveAllowed.filter((t) => !effectiveDisallowed.includes(t));

  // Determine permission mode.
  // Precedence chain:
  //   1. overrides.permission_mode — explicit flow override always wins
  //   2. trustPermissionMode — KG-informed trust resolver result
  //   3. worktreePath fallback — worktree_path signals agent works in a sandboxed directory
  //      (Canon worktree or Agent tool worktree). When present, auto permission mode is safe.
  const permissionMode: "auto" | "prompt" | "deny_unknown" =
    overrides?.permission_mode ??
    options?.trustPermissionMode ??
    (worktreePath ? "auto" : "prompt");

  const result: ResolvedProfile = {
    disallowed_tools: effectiveDisallowed,
    permission_mode: permissionMode,
    tools: finalAllowed,
  };
  if (warnings) result.warnings = warnings;
  return result;
};
