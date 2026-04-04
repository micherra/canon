/**
 * drive-flow-types — Type definitions and Zod schemas for the drive_flow tool.
 *
 * DriveFlowAction: discriminated union describing what the tool should do next.
 * DriveFlowInput: validated input for the drive_flow tool.
 */

import { z } from "zod";
import { ResolvedFlowSchema } from "./flow-schema.ts";

// SpawnRequest — one agent spawn instruction

export type SpawnRequest = {
  /** Agent type identifier (e.g., "canon:canon-implementor") */
  agent_type: string;
  /** Prompt to pass to the agent */
  prompt: string;
  /** Workspace isolation mode */
  isolation: "worktree" | "branch" | "none";
  /** Optional role name (for parallel-per states) */
  role?: string;
  /** Optional task ID (for wave implementors) */
  task_id?: string;
  /** Optional worktree path for worktree-isolated agents */
  worktree_path?: string;
  /**
   * Optional session continuation.
   * When present, the orchestrator should use SendMessage({ to: agent_id })
   * to resume the previous agent session rather than spawning fresh.
   */
  continue_from?: {
    /** agentId returned by Claude Code's Agent tool */
    agent_id: string;
    /** Summary of context from previous session */
    context_summary: string;
  };
};

// HitlBreakpoint — human-in-the-loop pause point

export type HitlBreakpoint = {
  /** Why execution is paused */
  reason: string;
  /** Contextual information for the human */
  context: string;
  /** Optional list of choices to present */
  options?: string[];
};

// ApprovalBreakpoint — approval gate pause point (ADR-017)

export type ApprovalBreakpoint = {
  /** Which state just completed and requires approval */
  state_id: string;
  /** Agent type that produced the work */
  agent_type: string;
  /** Artifact paths produced by the agent */
  artifacts: string[];
  /** Summary of what was produced */
  summary: string;
  /** Available response options */
  options: readonly ["approved", "revise", "reject"];
};

// DriveFlowAction — discriminated union: what drive_flow does next

export type DriveFlowAction =
  | { action: "spawn"; requests: SpawnRequest[] }
  | { action: "hitl"; breakpoint: HitlBreakpoint }
  | { action: "approval"; breakpoint: ApprovalBreakpoint }
  | { action: "done"; terminal_state: string; summary: string };

// DriveFlowInput — validated input for the drive_flow tool

export type DriveFlowInput = {
  /** Workspace directory path */
  workspace: string;
  /** Resolved flow definition */
  flow: z.infer<typeof ResolvedFlowSchema>;
  /** Optional result from the most recently completed agent */
  result?: {
    state_id: string;
    status: string;
    artifacts?: string[];
    parallel_results?: Array<{
      item: string;
      status: string;
      artifacts?: string[];
    }>;
    metrics?: Record<string, unknown>;
    agent_session_id?: string;
    /** Optional task ID for wave implementors. */
    task_id?: string;
  };
};

// Zod schemas for runtime validation

export const DriveFlowResultSchema = z.object({
  agent_session_id: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
  parallel_results: z
    .array(
      z.object({
        artifacts: z.array(z.string()).optional(),
        item: z.string(),
        status: z.string(),
      }),
    )
    .optional(),
  state_id: z.string(),
  status: z.string(),
  /** Optional task ID for wave implementors — typed here so callers don't need a type assertion. */
  task_id: z.string().optional(),
});

export const DriveFlowInputSchema = z.object({
  flow: ResolvedFlowSchema,
  result: DriveFlowResultSchema.optional(),
  workspace: z.string().min(1),
});
