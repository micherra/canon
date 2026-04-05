/**
 * Zod schemas and TypeScript types for Canon flow definitions, board state,
 * and orchestration data structures.
 */

import { z } from "zod";

// Status keywords and aliases

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
  approve: "approved",
  done_with_concerns: "done",
  epic_complete: "epic_complete",
  findings: "done",
  fixed: "done",
  has_questions: "has_questions",
  needs_context: "hitl",
  partial_fix: "done",
};

// Flow definition schemas

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
  as: z.string(),
  from: z.string(),
  prompt: z.string().optional(),
  section: z.string().optional(),
});

export const ConsultationsMapSchema = z.object({
  after: z.array(z.string()).optional(),
  before: z.array(z.string()).optional(),
  between: z.array(z.string()).optional(),
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
  artifact: z.string().optional(),
  type: EffectTypeSchema,
});

// Required artifact contract schemas (ADR-010)

/** A required artifact declaration on a state definition. */
export const RequiredArtifactSchema = z.object({
  name: z
    .string()
    .regex(
      /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/,
      "name must be a safe base filename without path separators",
    ),
  type: z.string(), // expected _type value in the .meta.json sidecar
});

export type RequiredArtifact = z.infer<typeof RequiredArtifactSchema>;

// Compete & Debate config schemas

/** Configuration for competitive state execution — N parallel agents + synthesis. */
export const CompeteConfigObjectSchema = z.object({
  count: z.number().min(2).max(5),
  lenses: z.array(z.string()).optional(),
  strategy: z.enum(["synthesize", "select"]).default("synthesize"),
});

/** Compete field: explicit config, "auto" (orchestrator decides), or absent. */
export const CompeteConfigSchema = z.union([z.literal("auto"), CompeteConfigObjectSchema]);

/** Configuration for pre-flight debate protocol. */
export const DebateConfigSchema = z.object({
  composition: z.array(z.string()),
  continue_to_build: z.boolean().default(true),
  convergence_check_after: z.number().default(3),
  hitl_checkpoint: z.boolean().default(true),
  max_rounds: z.number().default(5),
  min_rounds: z.number().default(2),
  teams: z.number().min(2).max(5).default(3),
});

// Quality gate result schemas

/** Gate result stored on board state (source of truth imported from here, not local interfaces). */
export const GateResultSchema = z.object({
  command: z.string().optional(),
  exitCode: z.number().optional(),
  gate: z.string(),
  output: z.string().optional(),
  passed: z.boolean(),
});

/** Discovered gate command reported by agents (e.g. tester, reviewer). */
export const DiscoveredGateSchema = z.object({
  command: z.string(),
  source: z.string(), // agent that discovered it, e.g. "tester", "reviewer"
});

/** Postcondition assertion declaration (for flow YAML or agent-discovered). */
export const PostconditionAssertionSchema = z.object({
  command: z.string().optional(),
  pattern: z.string().optional(),
  target: z.string().optional(),
  type: z.enum(["file_exists", "file_changed", "pattern_match", "no_pattern", "bash_check"]),
});

/** Postcondition evaluation result. */
export const PostconditionResultSchema = z.object({
  name: z.string(),
  output: z.string().optional(),
  passed: z.boolean(),
  type: z.string(),
});

/** Violation severity counts. */
export const ViolationSeveritiesSchema = z.object({
  blocking: z.number(),
  warning: z.number(),
});

/** Test result counts. */
export const TestResultsSchema = z.object({
  failed: z.number(),
  passed: z.number(),
  skipped: z.number(),
});

// Per-type state schemas (discriminated union members)

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
  // Cross-type fields needed without narrowing in orchestration code
  agent: z.string().optional(),
  agents: z.array(z.string()).optional(),
  // Approval gate fields (ADR-017)
  // Note: approval_gate on a terminal state is semantically nonsensical — terminal states
  // short-circuit in drive-flow before any gate check, so no runtime error occurs.
  approval_gate: z.boolean().optional(),
  cluster_by: z.enum(["directory", "layer"]).optional(),
  compete: CompeteConfigSchema.optional(),
  consultations: ConsultationsMapSchema.optional(),
  effects: z.array(EffectSchema).optional(),
  gate: z.string().optional(),
  gates: z.array(z.string()).optional(),
  inject_context: z.array(ContextInjectionSchema).optional(),
  inject_messages: z.boolean().optional(),
  large_diff_threshold: z.number().optional(),
  max_iterations: z.coerce.number().optional(),
  max_revisions: z.coerce.number().optional(),
  postconditions: z.array(PostconditionAssertionSchema).optional(),
  rejection_target: z.string().optional(),
  required_artifacts: z.array(RequiredArtifactSchema).optional(),
  roles: z.array(RoleEntrySchema).optional(),
  skip_when: SkipWhenSchema.optional(),
  stuck_when: StuckWhenSchema.optional(),
  template: z.union([z.string(), z.array(z.string())]).optional(),
  timeout: z.string().optional(),
  transitions: z.record(z.string(), z.string()).optional(),
};

export const SingleStateSchema = z.object({
  ...BaseStateFields,
  role: z.string().optional(),
  type: z.literal("single"),
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
    coordination: z.string().optional(),
    gate: z.string().optional(),
    isolation: z.enum(["worktree", "branch", "none"]).default("worktree"),
    merge_strategy: z.enum(["sequential", "rebase", "squash"]).default("sequential"),
    on_conflict: z.enum(["hitl", "replan", "retry-single"]).default("hitl"),
  })
  .optional();

export const WaveStateSchema = z.object({
  ...BaseStateFields,
  role: z.string().optional(),
  type: z.literal("wave"),
  wave_policy: WavePolicySchema,
});

export const ParallelStateSchema = z.object({
  ...BaseStateFields,
  type: z.literal("parallel"),
});

export const ParallelPerStateSchema = z.object({
  ...BaseStateFields,
  iterate_on: z.string().optional(), // required semantically but kept optional for backward compat
  role: z.string().optional(),
  type: z.literal("parallel-per"),
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
  as: z.string().optional(),
  fragment: z.string(),
  overrides: z
    .record(
      z.string(),
      z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
    )
    .optional(),
  with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const FlowDefinitionSchema = z.object({
  debate: DebateConfigSchema.optional(),
  description: z.string(),
  entry: z.string().optional(),
  gates: z.record(z.string(), z.string()).optional(),
  includes: z.array(FragmentIncludeSchema).optional(),
  name: z.string(),
  progress: z.string().optional(),
  review_threshold: z.enum(["blocking", "warning"]).optional(),
  states: z.record(z.string(), StateDefinitionSchema).optional(),
  tier: z.enum(["small", "medium", "large"]).optional(),
});

// Fragment param schemas

/** Typed param declaration for fragment params (ADR-004). */
export const TypedParamSchema = z.object({
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  type: z.enum(["state_id", "string", "number", "boolean"]),
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

// Fragment definition schemas

// Fragment state schemas — parallel discriminated union with relaxed numeric fields

/** Fragment base fields — relaxes numeric and enum fields for param placeholders. */
const FragmentBaseStateFields = {
  // Cross-type fields (same as BaseStateFields; relaxed numeric variants where applicable)
  agent: z.string().optional(),
  agents: z.array(z.string()).optional(),
  // Approval gate fields — relaxed for param placeholders (ADR-017)
  approval_gate: z.union([z.boolean(), z.string()]).optional(),
  cluster_by: z.enum(["directory", "layer"]).optional(),
  compete: CompeteConfigSchema.optional(),
  consultations: ConsultationsMapSchema.optional(),
  effects: z.array(EffectSchema).optional(),
  gate: z.string().optional(),
  gates: z.array(z.string()).optional(),
  inject_context: z.array(ContextInjectionSchema).optional(),
  inject_messages: z.boolean().optional(),
  large_diff_threshold: z.union([z.number(), z.string()]).optional(),
  max_iterations: z.union([z.coerce.number(), z.string()]).optional(),
  max_revisions: z.union([z.coerce.number(), z.string()]).optional(),
  postconditions: z.array(PostconditionAssertionSchema).optional(),
  rejection_target: z.string().optional(),
  required_artifacts: z.array(RequiredArtifactSchema).optional(),
  roles: z.array(RoleEntrySchema).optional(),
  skip_when: z.string().optional(), // relaxed: accepts enum values OR param placeholders
  stuck_when: z.union([StuckWhenSchema, z.string()]).optional(),
  template: z.union([z.string(), z.array(z.string())]).optional(),
  timeout: z.string().optional(),
  transitions: z.record(z.string(), z.string()).optional(),
};

const FragmentSingleStateSchema = z.object({
  ...FragmentBaseStateFields,
  role: z.string().optional(),
  type: z.literal("single"),
  // large_diff_threshold is in FragmentBaseStateFields with relaxed z.union([z.number(), z.string()])
});

const FragmentWaveStateSchema = z.object({
  ...FragmentBaseStateFields,
  role: z.string().optional(),
  type: z.literal("wave"),
  wave_policy: WavePolicySchema,
});

const FragmentParallelStateSchema = z.object({
  ...FragmentBaseStateFields,
  type: z.literal("parallel"),
});

const FragmentParallelPerStateSchema = z.object({
  ...FragmentBaseStateFields,
  iterate_on: z.string().optional(),
  role: z.string().optional(),
  type: z.literal("parallel-per"),
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
  // Consultation-specific fields
  agent: z.string().optional(),
  artifact: z.string().optional(),
  description: z.string().optional(),
  entry: z.string().optional(),
  fragment: z.string(),
  min_waves: z.number().optional(),
  params: z.record(z.string(), FragmentParamValueSchema).optional(),
  role: z.string().optional(),
  section: z.string().optional(),
  skip_when: SkipWhenSchema.optional(),
  states: z.record(z.string(), FragmentStateDefinitionSchema).optional(),
  timeout: z.string().optional(),
  type: z.literal("consultation").optional(),
});

// Resolved flow (after fragment resolution)

export const ConsultationFragmentSchema = z.object({
  agent: z.string(),
  artifact: z.string().optional(),
  description: z.string().optional(),
  fragment: z.string(),
  min_waves: z.number().optional(),
  role: z.string(),
  section: z.string().optional(),
  skip_when: SkipWhenSchema.optional(),
  spawn_instruction: z.string().optional(),
  timeout: z.string().optional(),
});

export const ResolvedFlowSchema = FlowDefinitionSchema.extend({
  consultations: z.record(z.string(), ConsultationFragmentSchema).optional(),
  entry: z.string(), // guaranteed after resolution
  spawn_instructions: z.record(z.string(), z.string()),
  states: z.record(z.string(), StateDefinitionSchema), // required after resolution
});

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
  gate_results: z.array(GateResultSchema).optional(),
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

// Transcript types (ADR-015)

export const TranscriptEntrySchema = z.object({
  content: z.string(),
  cumulative_tokens: z.number().optional(),
  role: z.enum(["system", "user", "assistant", "tool_use", "tool_result"]),
  timestamp: z.string(),
  tokens: z.number().optional(),
  tool_name: z.string().optional(),
  turn_number: z.number(),
});

export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

// Wave event types (used by wave-events.ts, inject-wave-event.ts, etc.)

export type WaveEventType =
  | "add_task"
  | "skip_task"
  | "reprioritize"
  | "inject_context"
  | "guidance"
  | "pause";

export type WaveEventResolution = Record<string, unknown>;

export type WaveEvent = {
  id: string;
  type: WaveEventType;
  payload: Record<string, unknown>;
  timestamp: string;
  status: "pending" | "applied" | "rejected";
  applied_at?: string;
  resolution?: WaveEventResolution;
  rejection_reason?: string;
};
