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
  "epic_complete",
  "approved",
  "revise",
  "reject",
] as const;

/** Maps agent-reported statuses to transition conditions. */
export const STATUS_ALIASES: Record<string, string> = {
  fixed: "done",
  partial_fix: "done",
  findings: "done",
  done_with_concerns: "done",
  needs_context: "hitl",
  has_questions: "has_questions",
  epic_complete: "epic_complete",
};

// ---------------------------------------------------------------------------
// Flow definition schemas
// ---------------------------------------------------------------------------

export const StateTypeSchema = z.enum(["single", "parallel", "wave", "parallel-per", "terminal"]);

export const StuckWhenSchema = z.enum([
  "same_violations",
  "same_file_test",
  "same_status",
  "no_progress",
  "no_gate_progress", // NEW: detect stuck when gate output and pass state don't change
]);

export const SkipWhenSchema = z.enum([
  "no_contract_changes",
  "no_fix_requested",
  "auto_approved",
  "no_open_questions", // NEW: skip targeted-research when no open questions from pattern-check
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

export const EffectTypeSchema = z.enum(["persist_review", "check_postconditions"]);

export const EffectSchema = z.object({
  type: EffectTypeSchema,
  artifact: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Compete & Debate config schemas
// ---------------------------------------------------------------------------

/** Configuration for competitive state execution — N parallel agents + synthesis. */
export const CompeteConfigObjectSchema = z.object({
  count: z.number().min(2).max(5),
  strategy: z.enum(["synthesize", "select"]).default("synthesize"),
  lenses: z.array(z.string()).optional(),
});

/** Compete field: explicit config, "auto" (orchestrator decides), or absent. */
export const CompeteConfigSchema = z.union([z.literal("auto"), CompeteConfigObjectSchema]);

/** Configuration for pre-flight debate protocol. */
export const DebateConfigSchema = z.object({
  teams: z.number().min(2).max(5).default(3),
  composition: z.array(z.string()),
  min_rounds: z.number().default(2),
  max_rounds: z.number().default(5),
  convergence_check_after: z.number().default(3),
  hitl_checkpoint: z.boolean().default(true),
  continue_to_build: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Quality gate result schemas
// ---------------------------------------------------------------------------

/** Gate result stored on board state (source of truth imported from here, not local interfaces). */
export const GateResultSchema = z.object({
  passed: z.boolean(),
  gate: z.string(),
  command: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().optional(),
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
  output: z.string().optional(),
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

// ---------------------------------------------------------------------------
// Per-type state schemas (discriminated union members)
// ---------------------------------------------------------------------------

/**
 * Fields shared across all state types.
 *
 * Several fields are included here even though they are only semantically meaningful
 * for certain state types. This is intentional: production orchestration code accesses
 * these fields on the union type without exhaustive type narrowing (e.g. reading
 * `stateDef.max_iterations` in board initialization, or `state.cluster_by` before
 * branching on state.type). Zod's discriminated union still enforces the correct
 * discriminant; the shared fields just allow safe reads across all members.
 */
const BaseStateFields = {
  template: z.union([z.string(), z.array(z.string())]).optional(),
  inject_context: z.array(ContextInjectionSchema).optional(),
  skip_when: SkipWhenSchema.optional(),
  timeout: z.string().optional(),
  effects: z.array(EffectSchema).optional(),
  transitions: z.record(z.string(), z.string()).optional(),
  max_iterations: z.coerce.number().optional(),
  stuck_when: StuckWhenSchema.optional(),
  // Cross-type fields needed without narrowing in orchestration code
  agent: z.string().optional(),
  agents: z.array(z.string()).optional(),
  roles: z.array(RoleEntrySchema).optional(),
  compete: CompeteConfigSchema.optional(),
  large_diff_threshold: z.number().optional(),
  cluster_by: z.enum(["directory", "layer"]).optional(),
  gate: z.string().optional(),
  gates: z.array(z.string()).optional(),
  postconditions: z.array(PostconditionAssertionSchema).optional(),
  consultations: ConsultationsMapSchema.optional(),
  inject_messages: z.boolean().optional(),
  // Approval gate fields (ADR-017)
  // Note: approval_gate on a terminal state is semantically nonsensical — terminal states
  // short-circuit in drive-flow before any gate check, so no runtime error occurs.
  approval_gate: z.boolean().optional(),
  max_revisions: z.coerce.number().optional(),
  rejection_target: z.string().optional(),
};

export const SingleStateSchema = z.object({
  ...BaseStateFields,
  type: z.literal("single"),
  role: z.string().optional(),
});

/**
 * Wave execution policy. When `wave_policy` is omitted from a wave state
 * definition, it is `undefined` — no defaults are applied. When an empty
 * object `{}` is provided, Zod applies field-level defaults (isolation:
 * "worktree", merge_strategy: "sequential", on_conflict: "hitl").
 * Consumers should treat `undefined` the same as the default values.
 */
export const WavePolicySchema = z
  .object({
    isolation: z.enum(["worktree", "branch", "none"]).default("worktree"),
    merge_strategy: z.enum(["sequential", "rebase", "squash"]).default("sequential"),
    gate: z.string().optional(),
    on_conflict: z.enum(["hitl", "replan", "retry-single"]).default("hitl"),
    coordination: z.string().optional(),
  })
  .optional();

export const WaveStateSchema = z.object({
  ...BaseStateFields,
  type: z.literal("wave"),
  role: z.string().optional(),
  wave_policy: WavePolicySchema,
});

export const ParallelStateSchema = z.object({
  ...BaseStateFields,
  type: z.literal("parallel"),
});

export const ParallelPerStateSchema = z.object({
  ...BaseStateFields,
  type: z.literal("parallel-per"),
  role: z.string().optional(),
  iterate_on: z.string().optional(), // required semantically but kept optional for backward compat
});

export const TerminalStateSchema = z.object({
  ...BaseStateFields,
  type: z.literal("terminal"),
});

export const StateDefinitionSchema = z.discriminatedUnion("type", [
  SingleStateSchema,
  WaveStateSchema,
  ParallelStateSchema,
  ParallelPerStateSchema,
  TerminalStateSchema,
]);

export const FragmentIncludeSchema = z.object({
  fragment: z.string(),
  with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
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
  debate: DebateConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// Fragment param schemas
// ---------------------------------------------------------------------------

/** Typed param declaration for fragment params (ADR-004). */
export const TypedParamSchema = z.object({
  type: z.enum(["state_id", "string", "number", "boolean"]),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

/**
 * Fragment param value: accepts both old (value | null) and new (typed) formats.
 * Backward compat: null means required param (old marker syntax).
 */
export const FragmentParamValueSchema = z.union([
  TypedParamSchema,
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export type TypedParam = z.infer<typeof TypedParamSchema>;
export type FragmentParamValue = z.infer<typeof FragmentParamValueSchema>;

// ---------------------------------------------------------------------------
// Fragment definition schemas
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fragment state schemas — parallel discriminated union with relaxed numeric fields
// ---------------------------------------------------------------------------

/** Fragment base fields — relaxes numeric and enum fields for param placeholders. */
const FragmentBaseStateFields = {
  template: z.union([z.string(), z.array(z.string())]).optional(),
  inject_context: z.array(ContextInjectionSchema).optional(),
  skip_when: z.string().optional(), // relaxed: accepts enum values OR param placeholders
  timeout: z.string().optional(),
  effects: z.array(EffectSchema).optional(),
  transitions: z.record(z.string(), z.string()).optional(),
  max_iterations: z.union([z.coerce.number(), z.string()]).optional(),
  stuck_when: z.union([StuckWhenSchema, z.string()]).optional(),
  // Cross-type fields (same as BaseStateFields; relaxed numeric variants where applicable)
  agent: z.string().optional(),
  agents: z.array(z.string()).optional(),
  roles: z.array(RoleEntrySchema).optional(),
  compete: CompeteConfigSchema.optional(),
  large_diff_threshold: z.union([z.number(), z.string()]).optional(),
  cluster_by: z.enum(["directory", "layer"]).optional(),
  gate: z.string().optional(),
  gates: z.array(z.string()).optional(),
  postconditions: z.array(PostconditionAssertionSchema).optional(),
  consultations: ConsultationsMapSchema.optional(),
  inject_messages: z.boolean().optional(),
  // Approval gate fields — relaxed for param placeholders (ADR-017)
  approval_gate: z.union([z.boolean(), z.string()]).optional(),
  max_revisions: z.union([z.coerce.number(), z.string()]).optional(),
  rejection_target: z.string().optional(),
};

const FragmentSingleStateSchema = z.object({
  ...FragmentBaseStateFields,
  type: z.literal("single"),
  role: z.string().optional(),
  // large_diff_threshold is in FragmentBaseStateFields with relaxed z.union([z.number(), z.string()])
});

const FragmentWaveStateSchema = z.object({
  ...FragmentBaseStateFields,
  type: z.literal("wave"),
  role: z.string().optional(),
  wave_policy: WavePolicySchema,
});

const FragmentParallelStateSchema = z.object({
  ...FragmentBaseStateFields,
  type: z.literal("parallel"),
});

const FragmentParallelPerStateSchema = z.object({
  ...FragmentBaseStateFields,
  type: z.literal("parallel-per"),
  role: z.string().optional(),
  iterate_on: z.string().optional(),
});

const FragmentTerminalStateSchema = z.object({
  ...FragmentBaseStateFields,
  type: z.literal("terminal"),
});

/** Loose state schema for fragments — allows param placeholders in numeric fields. */
export const FragmentStateDefinitionSchema = z.discriminatedUnion("type", [
  FragmentSingleStateSchema,
  FragmentWaveStateSchema,
  FragmentParallelStateSchema,
  FragmentParallelPerStateSchema,
  FragmentTerminalStateSchema,
]);

export const FragmentDefinitionSchema = z.object({
  fragment: z.string(),
  description: z.string().optional(),
  type: z.literal("consultation").optional(),
  entry: z.string().optional(),
  params: z.record(z.string(), FragmentParamValueSchema).optional(),
  states: z.record(z.string(), FragmentStateDefinitionSchema).optional(),
  // Consultation-specific fields
  agent: z.string().optional(),
  role: z.string().optional(),
  section: z.string().optional(),
  artifact: z.string().optional(),
  timeout: z.string().optional(),
  min_waves: z.number().optional(),
  skip_when: SkipWhenSchema.optional(),
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
  min_waves: z.number().optional(),
  skip_when: SkipWhenSchema.optional(),
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

export const BoardStateStatusSchema = z.enum(["pending", "in_progress", "done", "skipped", "blocked"]);

export const ConsultationResultSchema = z.object({
  status: z.string(),
  summary: z.string().nullable().optional(),
  artifact: z.string().optional(),
});

export const WorktreeEntrySchema = z.object({
  task_id: z.string(),
  worktree_path: z.string(),
  branch: z.string(),
  status: z.enum(["active", "merged", "failed"]).default("active"),
});

export const WaveResultSchema = z.object({
  tasks: z.array(z.string()),
  status: z.string(),
  gate: z.string().optional(),
  gate_output: z.string().optional(),
  worktree_entries: z.array(WorktreeEntrySchema).optional(),
  consultations: z
    .object({
      before: z.record(z.string(), ConsultationResultSchema).optional(),
      between: z.record(z.string(), ConsultationResultSchema).optional(),
      after: z.record(z.string(), ConsultationResultSchema).optional(),
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
  // ADR-003a agent performance metrics
  tool_calls: z.number().optional(),
  orientation_calls: z.number().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  cache_write_tokens: z.number().optional(),
  turns: z.number().optional(),
});

/** Focused schema for agent-reported performance metrics (ADR-003a input validation). */
export const AgentMetricsSchema = z.object({
  tool_calls: z.number().optional(),
  orientation_calls: z.number().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  cache_write_tokens: z.number().optional(),
  duration_ms: z.number().optional(),
  turns: z.number().optional(),
});
export type AgentMetrics = z.infer<typeof AgentMetricsSchema>;

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
  parallel_results: z
    .array(
      z.object({
        item: z.string(),
        status: z.string(),
        artifacts: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  compete_results: z
    .array(
      z.object({
        lens: z.string().optional(),
        status: z.string(),
        artifacts: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  synthesized: z.boolean().optional(),
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
  worktree_path: z.string().optional(),
  worktree_branch: z.string().optional(),
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
export type SingleState = z.infer<typeof SingleStateSchema>;
export type WaveState = z.infer<typeof WaveStateSchema>;
export type WavePolicy = z.infer<typeof WavePolicySchema>;
export type ParallelState = z.infer<typeof ParallelStateSchema>;
export type ParallelPerState = z.infer<typeof ParallelPerStateSchema>;
export type TerminalState = z.infer<typeof TerminalStateSchema>;
export type FragmentInclude = z.infer<typeof FragmentIncludeSchema>;
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;
export type FragmentDefinition = z.infer<typeof FragmentDefinitionSchema>;
export type ConsultationFragment = z.infer<typeof ConsultationFragmentSchema>;
export type ResolvedFlow = z.infer<typeof ResolvedFlowSchema>;
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
export type CompeteConfigObject = z.infer<typeof CompeteConfigObjectSchema>;
export type CompeteConfig = z.infer<typeof CompeteConfigSchema>;
export type DebateConfig = z.infer<typeof DebateConfigSchema>;

// ---------------------------------------------------------------------------
// Transcript types (ADR-015)
// ---------------------------------------------------------------------------

export const TranscriptEntrySchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool_use", "tool_result"]),
  timestamp: z.string(),
  content: z.string(),
  tool_name: z.string().optional(),
  tokens: z.number().optional(),
  cumulative_tokens: z.number().optional(),
  turn_number: z.number(),
});

export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

// ---------------------------------------------------------------------------
// Wave event types (used by wave-events.ts, inject-wave-event.ts, etc.)
// ---------------------------------------------------------------------------

export type WaveEventType = "add_task" | "skip_task" | "reprioritize" | "inject_context" | "guidance" | "pause";

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
