/**
 * Zod schemas and TypeScript types for Canon board and session runtime state.
 *
 * This file contains types belonging to the "board state" bounded context:
 * board entries, session lifecycle, iteration history, wave results, and
 * the runtime state of a flow execution.
 *
 * Bounded context: Orchestration (board/session runtime)
 * See: decompose-by-domain-not-layer, information-hiding
 */

import { z } from "zod";
import {
  DiscoveredGateSchema,
  GateResultSchema,
  PostconditionAssertionSchema,
  PostconditionResultSchema,
  TestResultsSchema,
  ViolationSeveritiesSchema,
} from "./flow-definition-schemas.js";

// Board state schemas

export const BoardStateStatusSchema = z.enum([
  "pending",
  "in_progress",
  "done",
  "skipped",
  "blocked",
]);

export const ConsultationResultSchema = z.object({
  artifact: z.string().optional(),
  status: z.string(),
  summary: z.string().nullable().optional(),
});

export const WorktreeEntrySchema = z.object({
  branch: z.string(),
  status: z.enum(["active", "merged", "failed"]).default("active"),
  task_id: z.string(),
  worktree_path: z.string(),
});

export const WaveResultSchema = z.object({
  consultations: z
    .object({
      after: z.record(z.string(), ConsultationResultSchema).optional(),
      before: z.record(z.string(), ConsultationResultSchema).optional(),
      between: z.record(z.string(), ConsultationResultSchema).optional(),
    })
    .optional(),
  gate: z.string().optional(),
  gate_output: z.string().optional(),
  status: z.string(),
  tasks: z.array(z.string()),
  worktree_entries: z.array(WorktreeEntrySchema).optional(),
});

export const StateMetricsSchema = z.object({
  cache_read_tokens: z.number().optional(),
  cache_write_tokens: z.number().optional(),
  duration_ms: z.number().optional(),
  files_changed: z.number().optional(),
  gate_results: z.array(GateResultSchema).optional(),
  input_tokens: z.number().optional(),
  model: z.string().optional(),
  orientation_calls: z.number().optional(),
  output_tokens: z.number().optional(),
  postcondition_results: z.array(PostconditionResultSchema).optional(),
  revision_count: z.number().optional(),
  spawns: z.number().optional(),
  test_results: TestResultsSchema.optional(),
  // ADR-003a agent performance metrics
  tool_calls: z.number().optional(),
  turns: z.number().optional(),
  violation_count: z.number().optional(),
  violation_severities: ViolationSeveritiesSchema.optional(),
});

/** Focused schema for agent-reported performance metrics (ADR-003a input validation). */
export const AgentMetricsSchema = z.object({
  cache_read_tokens: z.number().optional(),
  cache_write_tokens: z.number().optional(),
  duration_ms: z.number().optional(),
  input_tokens: z.number().optional(),
  orientation_calls: z.number().optional(),
  output_tokens: z.number().optional(),
  tool_calls: z.number().optional(),
  turns: z.number().optional(),
});
export type AgentMetrics = z.infer<typeof AgentMetricsSchema>;

export const ArtifactHistoryEntrySchema = z.object({
  artifacts: z.array(z.string()),
  entry: z.number(),
});

export const BoardStateEntrySchema = z.object({
  artifact_history: z.array(ArtifactHistoryEntrySchema).optional(),
  artifacts: z.array(z.string()).optional(),
  compete_results: z
    .array(
      z.object({
        artifacts: z.array(z.string()).optional(),
        lens: z.string().optional(),
        status: z.string(),
      }),
    )
    .optional(),
  completed_at: z.string().optional(),
  discovered_gates: z.array(DiscoveredGateSchema).optional(),
  discovered_postconditions: z.array(PostconditionAssertionSchema).optional(),
  entered_at: z.string().optional(),
  entries: z.number().default(0),
  error: z.string().optional(),
  commits: z
    .object({
      files_changed: z.array(z.string()),
      shas: z.array(z.string()),
    })
    .optional(),
  gate_results: z.array(GateResultSchema).optional(),
  inserted_return_to: z.string().optional(),
  metrics: StateMetricsSchema.optional(),
  parallel_results: z
    .array(
      z.object({
        artifacts: z.array(z.string()).optional(),
        item: z.string(),
        status: z.string(),
      }),
    )
    .optional(),
  postcondition_results: z.array(PostconditionResultSchema).optional(),
  result: z.string().optional(),
  status: BoardStateStatusSchema,
  synthesized: z.boolean().optional(),
  wave: z.number().optional(),
  wave_results: z.record(z.string(), WaveResultSchema).optional(),
  wave_total: z.number().optional(),
});

export const CannotFixItemSchema = z.object({
  file_path: z.string(),
  principle_id: z.string(),
});

// History entry variants — one per stuck_when strategy
export const ViolationHistoryEntrySchema = z.object({
  file_paths: z.array(z.string()),
  principle_ids: z.array(z.string()),
});

export const FileTestHistoryEntrySchema = z.object({
  pairs: z.array(z.object({ file: z.string(), test: z.string() })),
});

export const StatusHistoryEntrySchema = z.object({
  status: z.string(),
});

export const ProgressHistoryEntrySchema = z.object({
  artifact_count: z.number(),
  commit_sha: z.string(),
});

export const GateProgressHistoryEntrySchema = z.object({
  gate_output_hash: z.string(),
  passed: z.boolean(),
});

export const HistoryEntrySchema = z.union([
  ViolationHistoryEntrySchema,
  FileTestHistoryEntrySchema,
  StatusHistoryEntrySchema,
  ProgressHistoryEntrySchema,
  GateProgressHistoryEntrySchema,
]);

export const IterationEntrySchema = z.object({
  cannot_fix: z.array(CannotFixItemSchema).optional(),
  count: z.number(),
  history: z.array(HistoryEntrySchema),
  max: z.number(),
});

export const BlockedInfoSchema = z
  .object({
    reason: z.string(),
    since: z.string(),
    state: z.string(),
  })
  .nullable();

export const ConcernEntrySchema = z.object({
  agent: z.string(),
  message: z.string(),
  state_id: z.string(),
  timestamp: z.string(),
});

export const BoardSchema = z.object({
  base_commit: z.string(),
  blocked: BlockedInfoSchema,
  concerns: z.array(ConcernEntrySchema),
  current_state: z.string(),
  entry: z.string(),
  flow: z.string(),
  iterations: z.record(z.string(), IterationEntrySchema),
  last_updated: z.string(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  skipped: z.array(z.string()),
  started: z.string(),
  states: z.record(z.string(), BoardStateEntrySchema),
  task: z.string(),
});

// Session schema

export const SessionSchema = z.object({
  branch: z.string(),
  completed_at: z.string().optional(),
  created: z.string(),
  flow: z.string(),
  original_task: z.string().optional(),
  rolled_back_at: z.string().optional(),
  rolled_back_to: z.string().optional(),
  sanitized: z.string(),
  slug: z.string(),
  status: z.enum(["active", "completed", "aborted", "rolled_back"]),
  task: z.string(),
  tier: z.enum(["small", "medium", "large"]),
  worktree_branch: z.string().optional(),
  worktree_path: z.string().optional(),
});

// Inferred TypeScript types

export type BoardStateStatus = z.infer<typeof BoardStateStatusSchema>;
export type ConsultationResult = z.infer<typeof ConsultationResultSchema>;
export type WorktreeEntry = z.infer<typeof WorktreeEntrySchema>;
export type WaveResult = z.infer<typeof WaveResultSchema>;
export type StateMetrics = z.infer<typeof StateMetricsSchema>;
export type BoardStateEntry = z.infer<typeof BoardStateEntrySchema>;
export type CannotFixItem = z.infer<typeof CannotFixItemSchema>;
export type ViolationHistoryEntry = z.infer<typeof ViolationHistoryEntrySchema>;
export type FileTestHistoryEntry = z.infer<typeof FileTestHistoryEntrySchema>;
export type StatusHistoryEntry = z.infer<typeof StatusHistoryEntrySchema>;
export type ProgressHistoryEntry = z.infer<typeof ProgressHistoryEntrySchema>;
export type GateProgressHistoryEntry = z.infer<typeof GateProgressHistoryEntrySchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type IterationEntry = z.infer<typeof IterationEntrySchema>;
export type BlockedInfo = z.infer<typeof BlockedInfoSchema>;
export type ConcernEntry = z.infer<typeof ConcernEntrySchema>;
export type Board = z.infer<typeof BoardSchema>;
export type Session = z.infer<typeof SessionSchema>;
