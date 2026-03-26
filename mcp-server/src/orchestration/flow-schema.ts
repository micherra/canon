/**
 * Zod schemas and TypeScript types for Canon flow definitions, board state,
 * and orchestration data structures.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Status keywords and aliases
// ---------------------------------------------------------------------------

/** All recognized agent status keywords (agents report UPPERCASE). */
export const STATUS_KEYWORDS = [
  "done",
  "done_with_concerns",
  "blocked",
  "needs_context",
  "clean",
  "warning",
  "blocking",
  "all_passing",
  "implementation_issue",
  "fixed",
  "partial_fix",
  "cannot_fix",
  "has_questions",
  "findings",
  "critical",
  "updated",
  "no_updates",
] as const;

/** Maps agent-reported statuses to transition conditions. */
export const STATUS_ALIASES: Record<string, string> = {
  fixed: "done",
  partial_fix: "done",
  findings: "done",
  done_with_concerns: "done",
  needs_context: "hitl",
  has_questions: "has_questions",
};

// ---------------------------------------------------------------------------
// Flow definition schemas
// ---------------------------------------------------------------------------

export const StateTypeSchema = z.enum([
  "single",
  "parallel",
  "wave",
  "parallel-per",
  "terminal",
]);

export const StuckWhenSchema = z.enum([
  "same_violations",
  "same_file_test",
  "same_status",
  "no_progress",
]);

export const SkipWhenSchema = z.enum([
  "no_contract_changes",
  "no_fix_requested",
]);

export const ContextInjectionSchema = z.object({
  from: z.string(),
  section: z.string().optional(),
  as: z.string(),
  prompt: z.string().optional(),
});

export const ConsultationsMapSchema = z.object({
  before: z.array(z.string()).optional(),
  between: z.array(z.string()).optional(),
  after: z.array(z.string()).optional(),
});

export const RoleEntrySchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    optional: z.boolean().optional(),
  }),
]);

export const EffectTypeSchema = z.enum([
  "persist_review",
  "persist_decisions",
  "persist_patterns",
  "check_postconditions",
]);

export const EffectSchema = z.object({
  type: EffectTypeSchema,
  artifact: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Quality gate result schemas
// ---------------------------------------------------------------------------

/** Gate result stored on board state (source of truth imported from here, not local interfaces). */
export const GateResultSchema = z.object({
  passed: z.boolean(),
  gate: z.string(),
  command: z.string(),
  output: z.string(),
  exitCode: z.number(),
});

/** Discovered gate command reported by agents (e.g. tester, reviewer). */
export const DiscoveredGateSchema = z.object({
  command: z.string(),
  source: z.string(), // agent that discovered it, e.g. "tester", "reviewer"
});

/** Postcondition assertion declaration (for flow YAML or agent-discovered). */
export const PostconditionAssertionSchema = z.object({
  type: z.enum(["file_exists", "file_changed", "pattern_match", "no_pattern", "bash_check"]),
  target: z.string().optional(),
  pattern: z.string().optional(),
  command: z.string().optional(),
});

/** Postcondition evaluation result. */
export const PostconditionResultSchema = z.object({
  passed: z.boolean(),
  name: z.string(),
  type: z.string(),
  output: z.string(),
});

/** Violation severity counts. */
export const ViolationSeveritiesSchema = z.object({
  blocking: z.number(),
  warning: z.number(),
});

/** Test result counts. */
export const TestResultsSchema = z.object({
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
});

export const StateDefinitionSchema = z.object({
  type: StateTypeSchema,
  agent: z.string().optional(),
  agents: z.array(z.string()).optional(),
  role: z.string().optional(),
  roles: z.array(RoleEntrySchema).optional(),
  template: z.union([z.string(), z.array(z.string())]).optional(),
  transitions: z.record(z.string(), z.string()).optional(),
  max_iterations: z.coerce.number().optional(),
  stuck_when: StuckWhenSchema.optional(),
  gate: z.string().optional(),
  gates: z.array(z.string()).optional(),
  postconditions: z.array(PostconditionAssertionSchema).optional(),
  consultations: ConsultationsMapSchema.optional(),
  iterate_on: z.string().optional(),
  inject_context: z.array(ContextInjectionSchema).optional(),
  skip_when: SkipWhenSchema.optional(),
  large_diff_threshold: z.number().optional(),
  cluster_by: z.enum(["directory", "layer"]).optional(),
  timeout: z.string().optional(),
  overlays: z.array(z.string()).optional(),
  effects: z.array(EffectSchema).optional(),
});

export const FragmentIncludeSchema = z.object({
  fragment: z.string(),
  with: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  as: z.string().optional(),
  overrides: z
    .record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])))
    .optional(),
});

export const FlowDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  tier: z.enum(["small", "medium", "large"]).optional(),
  entry: z.string().optional(),
  progress: z.string().optional(),
  review_threshold: z.enum(["blocking", "warning"]).optional(),
  gates: z.record(z.string(), z.string()).optional(),
  includes: z.array(FragmentIncludeSchema).optional(),
  states: z.record(z.string(), StateDefinitionSchema).optional(),
});

// ---------------------------------------------------------------------------
// Fragment definition schemas
// ---------------------------------------------------------------------------

/** Loose state schema for fragments — allows param placeholders in numeric fields. */
export const FragmentStateDefinitionSchema = z.object({
  type: StateTypeSchema,
  agent: z.string().optional(),
  agents: z.array(z.string()).optional(),
  role: z.string().optional(),
  roles: z.array(RoleEntrySchema).optional(),
  template: z.union([z.string(), z.array(z.string())]).optional(),
  transitions: z.record(z.string(), z.string()).optional(),
  max_iterations: z.union([z.coerce.number(), z.string()]).optional(),
  stuck_when: z.union([StuckWhenSchema, z.string()]).optional(),
  gate: z.string().optional(),
  gates: z.array(z.string()).optional(),
  postconditions: z.array(PostconditionAssertionSchema).optional(),
  consultations: ConsultationsMapSchema.optional(),
  iterate_on: z.string().optional(),
  inject_context: z.array(ContextInjectionSchema).optional(),
  skip_when: z.string().optional(),
  large_diff_threshold: z.union([z.number(), z.string()]).optional(),
  cluster_by: z.enum(["directory", "layer"]).optional(),
  timeout: z.string().optional(),
  overlays: z.array(z.string()).optional(),
  effects: z.array(EffectSchema).optional(),
});

export const FragmentDefinitionSchema = z.object({
  fragment: z.string(),
  description: z.string().optional(),
  type: z.literal("consultation").optional(),
  entry: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
  states: z.record(z.string(), FragmentStateDefinitionSchema).optional(),
  // Consultation-specific fields
  agent: z.string().optional(),
  role: z.string().optional(),
  section: z.string().optional(),
  artifact: z.string().optional(),
  timeout: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Resolved flow (after fragment resolution)
// ---------------------------------------------------------------------------

export const ConsultationFragmentSchema = z.object({
  fragment: z.string(),
  description: z.string().optional(),
  agent: z.string(),
  role: z.string(),
  section: z.string().optional(),
  artifact: z.string().optional(),
  timeout: z.string().optional(),
  spawn_instruction: z.string().optional(),
});

export const ResolvedFlowSchema = FlowDefinitionSchema.extend({
  entry: z.string(), // guaranteed after resolution
  states: z.record(z.string(), StateDefinitionSchema), // required after resolution
  spawn_instructions: z.record(z.string(), z.string()),
  consultations: z.record(z.string(), ConsultationFragmentSchema).optional(),
});

// ---------------------------------------------------------------------------
// Board state schemas
// ---------------------------------------------------------------------------

export const BoardStateStatusSchema = z.enum([
  "pending",
  "in_progress",
  "done",
  "skipped",
  "blocked",
]);

export const ConsultationResultSchema = z.object({
  status: z.string(),
  summary: z.string().nullable().optional(),
  artifact: z.string().optional(),
});

export const WaveResultSchema = z.object({
  tasks: z.array(z.string()),
  status: z.string(),
  gate: z.string().optional(),
  gate_output: z.string().optional(),
  consultations: z
    .object({
      before: z
        .record(z.string(), ConsultationResultSchema)
        .optional(),
      between: z
        .record(z.string(), ConsultationResultSchema)
        .optional(),
      after: z
        .record(z.string(), ConsultationResultSchema)
        .optional(),
    })
    .optional(),
});

export const StateMetricsSchema = z.object({
  duration_ms: z.number().optional(),
  spawns: z.number().optional(),
  model: z.string().optional(),
  gate_results: z.array(GateResultSchema).optional(),
  postcondition_results: z.array(PostconditionResultSchema).optional(),
  violation_count: z.number().optional(),
  violation_severities: ViolationSeveritiesSchema.optional(),
  test_results: TestResultsSchema.optional(),
  files_changed: z.number().optional(),
  revision_count: z.number().optional(),
});

export const ArtifactHistoryEntrySchema = z.object({
  entry: z.number(),
  artifacts: z.array(z.string()),
});

export const BoardStateEntrySchema = z.object({
  status: BoardStateStatusSchema,
  entered_at: z.string().optional(),
  completed_at: z.string().optional(),
  entries: z.number().default(0),
  result: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  artifact_history: z.array(ArtifactHistoryEntrySchema).optional(),
  error: z.string().optional(),
  wave: z.number().optional(),
  wave_total: z.number().optional(),
  wave_results: z.record(z.string(), WaveResultSchema).optional(),
  metrics: StateMetricsSchema.optional(),
  gate_results: z.array(GateResultSchema).optional(),
  postcondition_results: z.array(PostconditionResultSchema).optional(),
  discovered_gates: z.array(DiscoveredGateSchema).optional(),
  discovered_postconditions: z.array(PostconditionAssertionSchema).optional(),
  parallel_results: z.array(z.object({
    item: z.string(),
    status: z.string(),
    artifacts: z.array(z.string()).optional(),
  })).optional(),
});

export const CannotFixItemSchema = z.object({
  principle_id: z.string(),
  file_path: z.string(),
});

// History entry variants — one per stuck_when strategy
export const ViolationHistoryEntrySchema = z.object({
  principle_ids: z.array(z.string()),
  file_paths: z.array(z.string()),
});

export const FileTestHistoryEntrySchema = z.object({
  pairs: z.array(z.object({ file: z.string(), test: z.string() })),
});

export const StatusHistoryEntrySchema = z.object({
  status: z.string(),
});

export const ProgressHistoryEntrySchema = z.object({
  commit_sha: z.string(),
  artifact_count: z.number(),
});

export const HistoryEntrySchema = z.union([
  ViolationHistoryEntrySchema,
  FileTestHistoryEntrySchema,
  StatusHistoryEntrySchema,
  ProgressHistoryEntrySchema,
]);

export const IterationEntrySchema = z.object({
  count: z.number(),
  max: z.number(),
  history: z.array(HistoryEntrySchema),
  cannot_fix: z.array(CannotFixItemSchema).optional(),
});

export const BlockedInfoSchema = z
  .object({
    state: z.string(),
    reason: z.string(),
    since: z.string(),
  })
  .nullable();

export const ConcernEntrySchema = z.object({
  state_id: z.string(),
  agent: z.string(),
  message: z.string(),
  timestamp: z.string(),
});

export const BoardSchema = z.object({
  flow: z.string(),
  task: z.string(),
  entry: z.string(),
  current_state: z.string(),
  base_commit: z.string(),
  started: z.string(),
  last_updated: z.string(),
  states: z.record(z.string(), BoardStateEntrySchema),
  iterations: z.record(z.string(), IterationEntrySchema),
  blocked: BlockedInfoSchema,
  concerns: z.array(ConcernEntrySchema),
  skipped: z.array(z.string()),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

// ---------------------------------------------------------------------------
// Session schema
// ---------------------------------------------------------------------------

export const SessionSchema = z.object({
  branch: z.string(),
  sanitized: z.string(),
  created: z.string(),
  task: z.string(),
  original_task: z.string().optional(),
  tier: z.enum(["small", "medium", "large"]),
  flow: z.string(),
  slug: z.string(),
  status: z.enum(["active", "completed", "aborted", "rolled_back"]),
  completed_at: z.string().optional(),
  rolled_back_at: z.string().optional(),
  rolled_back_to: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type EffectType = z.infer<typeof EffectTypeSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type GateResult = z.infer<typeof GateResultSchema>;
export type DiscoveredGate = z.infer<typeof DiscoveredGateSchema>;
export type PostconditionAssertion = z.infer<typeof PostconditionAssertionSchema>;
export type PostconditionResult = z.infer<typeof PostconditionResultSchema>;
export type ViolationSeverities = z.infer<typeof ViolationSeveritiesSchema>;
export type TestResults = z.infer<typeof TestResultsSchema>;
export type StateType = z.infer<typeof StateTypeSchema>;
export type StuckWhen = z.infer<typeof StuckWhenSchema>;
export type SkipWhen = z.infer<typeof SkipWhenSchema>;
export type ContextInjection = z.infer<typeof ContextInjectionSchema>;
export type ConsultationsMap = z.infer<typeof ConsultationsMapSchema>;
export type RoleEntry = z.infer<typeof RoleEntrySchema>;
export type StateDefinition = z.infer<typeof StateDefinitionSchema>;
export type FragmentInclude = z.infer<typeof FragmentIncludeSchema>;
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;
export type FragmentDefinition = z.infer<typeof FragmentDefinitionSchema>;
export type ConsultationFragment = z.infer<typeof ConsultationFragmentSchema>;
export type ResolvedFlow = z.infer<typeof ResolvedFlowSchema>;
export type BoardStateStatus = z.infer<typeof BoardStateStatusSchema>;
export type ConsultationResult = z.infer<typeof ConsultationResultSchema>;
export type WaveResult = z.infer<typeof WaveResultSchema>;
export type StateMetrics = z.infer<typeof StateMetricsSchema>;
export type BoardStateEntry = z.infer<typeof BoardStateEntrySchema>;
export type CannotFixItem = z.infer<typeof CannotFixItemSchema>;
export type ViolationHistoryEntry = z.infer<typeof ViolationHistoryEntrySchema>;
export type FileTestHistoryEntry = z.infer<typeof FileTestHistoryEntrySchema>;
export type StatusHistoryEntry = z.infer<typeof StatusHistoryEntrySchema>;
export type ProgressHistoryEntry = z.infer<typeof ProgressHistoryEntrySchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type IterationEntry = z.infer<typeof IterationEntrySchema>;
export type BlockedInfo = z.infer<typeof BlockedInfoSchema>;
export type ConcernEntry = z.infer<typeof ConcernEntrySchema>;
export type Board = z.infer<typeof BoardSchema>;
export type Session = z.infer<typeof SessionSchema>;

// ---------------------------------------------------------------------------
// Wave event types (used by wave-events.ts, inject-wave-event.ts, etc.)
// ---------------------------------------------------------------------------

export type WaveEventType =
  | "add_task"
  | "skip_task"
  | "reprioritize"
  | "inject_context"
  | "guidance"
  | "pause";

export type WaveEventResolution = Record<string, unknown>;

export interface WaveEvent {
  id: string;
  type: WaveEventType;
  payload: Record<string, unknown>;
  timestamp: string;
  status: "pending" | "applied" | "rejected";
  applied_at?: string;
  resolution?: WaveEventResolution;
  rejection_reason?: string;
}
