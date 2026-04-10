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
      "load_flow",
      "simulate_flow",
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
      "get_history", // ADR-019: query execution history during pattern analysis
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
    allowed: ["Read", "Grep", "Glob", "Bash", "Edit"],
    disallowed: ["Write", "NotebookEdit"],
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
    allowed: ["Read", "Grep", "Glob", "Bash", "Edit", "post_event"],
    disallowed: ["Write", "NotebookEdit"],
  },
  "canon-tester": {
    allowed: [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Edit",
      "Write",
      "write_test_report",
      "graph_query",
      "post_event",
    ],
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
 * Resolve the effective allowed list and any audit warnings for tool override.
 * Returns the allowed list and optional warnings when a replace override grants disallowed tools.
 */
function resolveAllowedList(
  agent: string,
  base: AgentToolProfile,
  overrides?: ToolOverrides,
): { effectiveAllowed: string[]; warnings?: ToolScopeWarning[] } {
  if (!overrides?.replace && !overrides?.allow) {
    return { effectiveAllowed: base.allowed };
  }
  if (overrides.replace) {
    // Audit: replace override may grant tools in the base disallowed list
    const grantedDisallowed = overrides.replace.filter((t) => base.disallowed.includes(t));
    const warnings: ToolScopeWarning[] | undefined =
      grantedDisallowed.length > 0
        ? [
            {
              agent,
              event: "adr014_replace_override_grants_disallowed",
              granted_disallowed: grantedDisallowed,
            },
          ]
        : undefined;
    return { effectiveAllowed: overrides.replace, warnings };
  }
  return { effectiveAllowed: [...base.allowed, ...overrides.allow!] };
}

/**
 * Determine the permission mode for an agent spawn.
 * Precedence: overrides.permission_mode > trustPermissionMode > worktree auto > read-only auto > prompt
 */
function resolvePermissionMode(
  base: AgentToolProfile,
  overrides?: ToolOverrides,
  worktreePath?: string,
  trustPermissionMode?: "auto" | "prompt",
): "auto" | "prompt" | "deny_unknown" {
  if (overrides?.permission_mode) return overrides.permission_mode;
  if (trustPermissionMode) return trustPermissionMode;
  if (worktreePath) return "auto";
  // Read-only agents (Write+Edit both disallowed at base) are safe everywhere
  const isReadOnly = base.disallowed.includes("Write") && base.disallowed.includes("Edit");
  return isReadOnly ? "auto" : "prompt";
}

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
  const normalizedAgent = agent.startsWith("canon:") ? agent.slice("canon:".length) : agent;
  const base = AGENT_TOOL_PROFILES[normalizedAgent] ?? EMPTY_PROFILE;

  const { effectiveAllowed, warnings } = resolveAllowedList(agent, base, overrides);
  const effectiveDisallowed: string[] = overrides?.deny
    ? [...base.disallowed, ...overrides.deny]
    : base.disallowed;
  const finalAllowed = effectiveAllowed.filter((t) => !effectiveDisallowed.includes(t));
  const permissionMode = resolvePermissionMode(
    base,
    overrides,
    options?.worktreePath,
    options?.trustPermissionMode,
  );

  const result: ResolvedProfile = {
    disallowed_tools: effectiveDisallowed,
    permission_mode: permissionMode,
    tools: finalAllowed,
  };
  if (warnings) result.warnings = warnings;
  return result;
};
