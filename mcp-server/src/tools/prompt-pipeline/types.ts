/**
 * Shared types for the prompt assembly pipeline.
 *
 * Each stage is a pure function: (ctx: PromptContext) => PromptContext | Promise<PromptContext>.
 * Stages communicate via PromptContext — immutable input fields, accumulated mutable fields.
 */

import type { FileCluster } from "../../orchestration/diff-cluster.ts";
import type { Board, ResolvedFlow, StateDefinition } from "../../orchestration/flow-schema.ts";

/** A task item passed to wave/parallel-per states — either a name or a structured plan. */
export type TaskItem = string | Record<string, string | number | boolean | string[]>;

export type SpawnPromptEntry = {
  agent: string;
  prompt: string;
  role?: string;
  item?: TaskItem;
  template_paths: string[];
  isolation?: "worktree";
  worktree_path?: string;
};

export type SpawnPromptResult = {
  prompts: SpawnPromptEntry[];
  state_type: string;
  skip_reason?: string;
  warnings?: string[];
  clusters?: FileCluster[];
  timeout_ms?: number;
  fanned_out?: boolean;
};

/**
 * Input to the prompt assembly pipeline.
 * Carried unchanged through all stages.
 */
export type SpawnPromptInput = {
  workspace: string;
  state_id: string;
  flow: ResolvedFlow;
  variables: Record<string, string>;
  items?: TaskItem[];
  role?: string;
  project_dir?: string;
  wave?: number;
  peer_count?: number;
  /**
   * Completed consultation outputs to inject into the wave briefing.
   * When provided alongside `wave`, assembleWaveBriefing is called and the
   * result is appended to each wave/parallel-per prompt entry.
   * Note: no longer requires pre-escaping — stage 6 handles escaping internally.
   */
  consultation_outputs?: Record<string, { section?: string; summary: string }>;
  /**
   * Pre-read board — if provided, skips the internal readBoard call.
   * Use this when the caller has already read the board (e.g., enterAndPrepareState)
   * to avoid a redundant round-trip.
   */
  _board?: Board;
};

/**
 * Context object passed between pipeline stages.
 * Each stage returns a new PromptContext (or a mutated copy).
 */
export type PromptContext = {
  // Input (immutable after construction)
  input: SpawnPromptInput;
  state: StateDefinition;
  rawInstruction: string;
  board?: Board;

  // Accumulated state (each stage returns new object)
  mergedVariables: Record<string, string>;
  basePrompt: string;
  prompts: SpawnPromptEntry[];
  warnings: string[];
  clusters?: FileCluster[];
  timeout_ms?: number;
  skip_reason?: string;
  fanned_out?: boolean;

  // Cache prefix (read from store in stage 4)
  cachePrefix?: string;
};

/**
 * A single pipeline stage function.
 * Takes a PromptContext and returns a (possibly async) PromptContext.
 * Stages must not mutate the input context — return a new object.
 */
export type PromptStage = (ctx: PromptContext) => PromptContext | Promise<PromptContext>;
