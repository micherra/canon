/**
 * build-dashboard-types.ts
 *
 * TypeScript type definitions for the Build Approval Dashboard data payload.
 * This is the single source of truth for the structure of data delivered
 * to the BuildDashboard Svelte view via BridgeAdapter.loadData<BuildDashboardData>().
 *
 * Reuses RunbookStep from planning-brief-types.ts to avoid duplication.
 */

import type { RunbookStep } from "./planning-brief-types.ts";

/** Summary fields extracted from the planning brief. */
export type BriefSummary = {
  /** The build request title or description. */
  title: string;
  /** Planner's overall outcome recommendation. */
  outcome: "GREENLIGHT" | "CAUTION" | "STOP";
  /** Estimated effort (e.g., "medium", "3–5 days"). */
  effort: string;
  /** Value assessment (e.g., "high — unblocks HITL synchronous flow"). */
  value: string;
};

/**
 * Acceptance criterion from the planning brief.
 * Uses a simplified type compared to PlanningBriefData — no checked state needed
 * since this is a read-only display.
 */
export type DashboardCriterion = {
  /** Zero-based index of this criterion within the acceptance criteria list. */
  index: number;
  /** The criterion text. */
  text: string;
  /** Verification type: automatically testable or requires manual inspection. */
  type: "mechanical" | "manual";
};

/** A node in the task DAG. */
export type DagNode = {
  /** Unique identifier matching the task plan ID. */
  id: string;
  /** Wave number this task belongs to. */
  wave: number;
  /** Files this task touches. */
  files: string[];
  /** IDs of tasks this task depends on (must complete before this one starts). */
  depends_on: string[];
};

/** An edge in the task DAG (derived from depends_on). */
export type DagEdge = {
  /** Source node ID (the dependency — must complete first). */
  source: string;
  /** Target node ID (the dependent — runs after source). */
  target: string;
};

/** A task plan entry for the collapsible task plans section. */
export type TaskPlanEntry = {
  /** Unique task identifier (e.g., "implement-01"). */
  task_id: string;
  /** Wave number this task belongs to. */
  wave: number;
  /** Human-readable title for this task. */
  title: string;
  /** Raw markdown body of the task plan. */
  body: string;
  /** Files this task creates or modifies. */
  files: string[];
  /** Canon principle IDs this task must comply with. */
  principles: string[];
};

/** A design decision entry for the collapsible decisions section. */
export type DesignDecisionEntry = {
  /** Unique decision identifier (e.g., "dag-layout-01"). */
  decision_id: string;
  /** Short title for this decision. */
  title: string;
  /** Decision status (e.g., "resolved", "open"). */
  status: string;
  /** Raw markdown body of the decision. */
  body: string;
};

/**
 * Complete data payload for the build approval dashboard.
 *
 * Delivered to the BuildDashboard view via BridgeAdapter.loadData<BuildDashboardData>().
 * Assembled by the orchestrator at the present_artifact call site, composing data
 * from workspace artifacts (planning brief, runbook, task plans, design decisions, DAG).
 */
export type BuildDashboardData = {
  /** Brief summary from the planning brief. */
  brief: BriefSummary;
  /** Acceptance criteria for this build. */
  acceptance_criteria: DashboardCriterion[];
  /** Runbook steps in execution order. */
  runbook_steps: RunbookStep[];
  /** Task DAG: nodes and directed edges. */
  dag: {
    nodes: DagNode[];
    edges: DagEdge[];
  };
  /** Task plan entries for the collapsible task plans section. */
  task_plans: TaskPlanEntry[];
  /** Design decision entries for the collapsible decisions section. */
  design_decisions: DesignDecisionEntry[];
  /** Raw research notes markdown (optional — rendered as collapsible section). */
  research_notes?: string;
};
