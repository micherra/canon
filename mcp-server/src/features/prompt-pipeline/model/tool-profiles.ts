/**
 * Agent tool profile registry and resolver (ADR-014).
 *
 * Each agent has a declared set of allowed and disallowed tools. The
 * resolveToolProfile function applies optional per-spawn overrides and
 * computes the final tool list passed to the Agent spawn request.
 */

import type { ToolOverrides } from "@domains/flows/flow-schema.ts";

/** Base tool profile for an agent type. */
export type AgentToolProfile = {
  allowed: string[];
  disallowed: string[];
};

/** Resolved tool configuration for a single agent spawn. */
export type ResolvedProfile = {
  tools: string[];
  disallowed_tools: string[];
  permission_mode: "auto" | "prompt" | "deny_unknown";
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
      "write_plan_index",
      "update_board",
    ],
    disallowed: ["Edit", "Write", "NotebookEdit"],
  },
  "canon-chat": {
    allowed: ["Read", "Grep", "Glob"],
    disallowed: ["Edit", "Write", "Bash", "NotebookEdit"],
  },
  "canon-fixer": {
    allowed: ["Read", "Grep", "Glob", "Bash", "Edit", "Write"],
    disallowed: [],
  },
  "canon-guide": {
    allowed: ["Read", "Grep", "Glob"],
    disallowed: ["Edit", "Write", "Bash", "NotebookEdit"],
  },
  "canon-implementor": {
    allowed: ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "NotebookEdit"],
    disallowed: [],
  },
  "canon-learner": {
    allowed: ["Read", "Grep", "Glob", "Bash"],
    disallowed: ["Edit", "Write", "NotebookEdit"],
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
    ],
    disallowed: ["Edit", "Write", "NotebookEdit"],
  },
  "canon-reviewer": {
    allowed: ["Read", "Grep", "Glob", "Bash", "review_code"],
    disallowed: ["Edit", "Write", "NotebookEdit"],
  },
  "canon-scribe": {
    allowed: ["Read", "Grep", "Glob", "Edit"],
    disallowed: ["Bash", "Write", "NotebookEdit"],
  },
  "canon-security": {
    allowed: ["Read", "Grep", "Glob", "Bash", "graph_query", "get_file_context"],
    disallowed: ["Edit", "Write", "NotebookEdit"],
  },
  "canon-shipper": {
    allowed: ["Read", "Grep", "Glob", "Bash"],
    disallowed: ["Edit", "Write", "NotebookEdit"],
  },
  "canon-tester": {
    allowed: ["Read", "Grep", "Glob", "Bash", "Edit", "Write"],
    disallowed: [],
  },
  "canon-writer": {
    allowed: ["Read", "Grep", "Glob", "Edit", "Write"],
    disallowed: ["Bash", "NotebookEdit"],
  },
} as const;

/**
 * Resolve the final tool profile for an agent spawn.
 *
 * Resolution algorithm:
 * 1. Look up base profile (fail-closed: unknown agents get EMPTY_PROFILE)
 * 2. Apply allowed overrides: replace > allow > base
 * 3. Apply disallowed overrides: deny extends base disallowed
 * 4. Disallowed wins: remove any disallowed tools from allowed
 * 5. Determine permission_mode: overrides.permission_mode > worktree auto > prompt
 */
export const resolveToolProfile = (
  agent: string,
  overrides?: ToolOverrides,
  isolation?: string,
  worktreePath?: string,
): ResolvedProfile => {
  const normalizedAgent = agent.startsWith("canon:") ? agent.slice("canon:".length) : agent;
  const base = AGENT_TOOL_PROFILES[normalizedAgent] ?? EMPTY_PROFILE;

  // Resolve effective allowed list
  let effectiveAllowed: string[];
  if (overrides?.replace) {
    // Audit: warn when replace grants tools that are in the base disallowed list.
    // This is permitted by the caller but should be visible in logs.
    const grantedDisallowed = overrides.replace.filter((t) => base.disallowed.includes(t));
    if (grantedDisallowed.length > 0) {
      console.warn(
        `[ADR-014] tool_overrides.replace grants disallowed tools for ${agent}: ${grantedDisallowed.join(", ")}`,
      );
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

  // Determine permission mode
  const permissionMode: "auto" | "prompt" | "deny_unknown" =
    overrides?.permission_mode ?? (isolation === "worktree" && worktreePath ? "auto" : "prompt");

  return {
    disallowed_tools: effectiveDisallowed,
    permission_mode: permissionMode,
    tools: finalAllowed,
  };
};
