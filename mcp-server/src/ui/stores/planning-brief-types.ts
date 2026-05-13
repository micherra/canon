/**
 * planning-brief-types.ts
 *
 * TypeScript interfaces for the planning brief data payload.
 * This is the single source of truth for the structure of data delivered
 * to the PlanningBrief Svelte view via BridgeAdapter.loadData<PlanningBriefData>().
 */

/** Outcome recommendation from the planner. */
export type PlanningBriefOutcome = "GREENLIGHT" | "CAUTION" | "STOP";

/** A single assumption from the planner's analysis. */
export type Assumption = {
  /** Zero-based index of this assumption within the assumptions list. */
  index: number;
  /** The assumption text. */
  text: string;
};

/** A single acceptance criterion for the build. */
export type AcceptanceCriterion = {
  /** Zero-based index of this criterion within the acceptance criteria list. */
  index: number;
  /** The criterion text. */
  text: string;
  /** Whether this criterion is checked/satisfied in the current plan. */
  checked: boolean;
};

/** A row in the requirement coverage map. */
export type RequirementCoverageRow = {
  /** Stable identifier for this requirement (e.g., "req-1"). */
  id: string;
  /** The original requirement text from the user's request. */
  requirement: string;
  /**
   * Coverage disposition:
   * - covered: fully addressed by this runbook
   * - descoped: intentionally excluded (see rationale)
   * - partial: partially addressed; some aspects deferred
   */
  disposition: "covered" | "descoped" | "partial";
  /** Explanation for the disposition, especially for descoped/partial items. */
  rationale: string;
};

/** A risk finding from the planner's analysis. */
export type RiskFinding = {
  /** Stable identifier for this finding (e.g., "risk-1"). */
  id: string;
  /** Description of the risk. */
  description: string;
  /** Severity level of the risk. */
  severity: "high" | "medium" | "low";
  /** Proposed mitigation strategy. */
  mitigation: string;
};

/** A single step in the approved runbook. */
export type RunbookStep = {
  /** Step identifier matching the runbook's step IDs. */
  id: string;
  /** Human-readable name for this step. */
  name: string;
  /** Agent type responsible for executing this step (e.g., "engineer", "reviewer"). */
  agent: string;
  /** How this step is dispatched. */
  dispatch: "subagent" | "team";
  /** Expected artifact paths produced by this step. */
  artifacts: string[];
};

/**
 * Complete planning brief data payload.
 *
 * Delivered to the PlanningBrief view via BridgeAdapter.loadData<PlanningBriefData>().
 * Produced by the Canon planner agent and serialized by the HTTP server into
 * window.__CANON_DATA__ for HTTP transport, or pushed via ontoolresult for MCP App.
 */
export type PlanningBriefData = {
  /** The build request title or description. */
  title: string;
  /** Planner's overall outcome recommendation. */
  outcome: PlanningBriefOutcome;
  /** Estimated effort (e.g., "medium", "3–5 days"). */
  effort: string;
  /** Value assessment (e.g., "high — unblocks HITL synchronous flow"). */
  value: string;
  /** Planner's assumptions about the build context. */
  assumptions: Assumption[];
  /** Acceptance criteria that must be met for the build to be considered done. */
  acceptance_criteria: AcceptanceCriterion[];
  /** Requirement coverage map — every original requirement mapped to a disposition. */
  requirement_coverage: RequirementCoverageRow[];
  /** Risk findings identified by the planner. */
  risk_findings: RiskFinding[];
  /** Runbook steps in execution order. */
  runbook_steps: RunbookStep[];
  /** Hard constraints the build must not violate. */
  constraints: string[];
  /** Raw research notes markdown (optional — rendered as collapsible section). */
  research_notes?: string;
};
