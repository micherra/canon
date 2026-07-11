/**
 * Public surface of the `learning` feature — the shared actionability
 * classifier plus the `reconcile_learnings` MCP tool (ADR-0048).
 *
 * Barrel export so callers (the `app/register-learning.ts` registration and
 * any future command/loop consumer) import from one path rather than reaching
 * into individual files.
 */

export {
  ACTIONABLE_TYPES,
  type Actionability,
  type ClassificationResult,
  classifyProposal,
  INFORMATIONAL_TYPES,
} from "./actionability.ts";
export {
  type ArchivedItem,
  type DirEntry,
  defaultFsSeam,
  defaultGitSeam,
  type FlaggedSet,
  FRESHNESS_DAYS,
  type ReconciledItem,
  type ReconcileFsSeam,
  type ReconcileGitSeam,
  type ReconcileLearningsInput,
  type ReconcileLearningsOutput,
  reconcileLearnings,
  type SkippedItem,
} from "./reconcile-learnings.ts";
