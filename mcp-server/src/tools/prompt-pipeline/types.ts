/**
 * Shared types for the prompt pipeline stages.
 *
 * NOTE: This is a minimal bootstrap for Wave 1 tasks (adr006-02, adr006-03).
 * The canonical version is produced by task adr006-01 and will be merged
 * in Wave 2. Types here must be structurally compatible with that version.
 */

import type { StateDefinition, ResolvedFlow } from "../../orchestration/flow-schema.ts";
import type { FileCluster } from "../../orchestration/diff-cluster.ts";

/** A task item passed to wave/parallel-per states — either a name or a structured plan. */
export type TaskItem = string | Record<string, string | number | boolean | string[]>;

/** A single fanned-out prompt entry to be spawned as an agent. */
export interface SpawnPromptEntry {
  agent: string;
  prompt: string;
  role?: string;
  item?: TaskItem;
  template_paths: string[];
  isolation?: "worktree";
  worktree_path?: string;
}

/** Final result returned from the prompt pipeline. */
export interface SpawnPromptResult {
  prompts: SpawnPromptEntry[];
  state_type: string;
  skip_reason?: string;
  warnings?: string[];
  clusters?: FileCluster[];
  timeout_ms?: number;
  fanned_out?: boolean;
}

/** The context object threaded through all pipeline stages. */
export interface PromptContext {
  // Inputs
  workspace: string;
  state_id: string;
  state: StateDefinition;
  flow: ResolvedFlow;
  variables: Record<string, string>;
  items?: TaskItem[];
  role?: string;
  wave?: number;
  peer_count?: number;
  consultation_outputs?: Record<string, { section?: string; summary: string }>;

  // Mutable pipeline state
  basePrompt: string;
  prompts: SpawnPromptEntry[];
  warnings: string[];
  clusters?: FileCluster[];
  timeout_ms?: number;
  fanned_out?: boolean;
}

/** A pipeline stage: receives a context and returns a (possibly mutated) context. */
export type PromptStage = (ctx: PromptContext) => Promise<PromptContext>;
