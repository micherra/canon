<script lang="ts">
/**
 * BuildDashboard.svelte
 *
 * Container component for the Canon Build Approval Dashboard interactive view.
 *
 * Renders the full build plan with collapsible sections:
 * brief banner, acceptance criteria, runbook, task DAG, task plans,
 * design decisions, and optional research notes.
 *
 * Follows the same pattern as PlanningBrief.svelte:
 * useDataLoader + bridge.init/loadData + $derived reactive aliases.
 *
 * Canon principles:
 *   - compose-from-small-to-large: pure composition; no leaf rendering logic
 *   - props-are-the-component-contract: no props — all state internal
 *   - minimize-client-side-state: only annotations[] and per-card isOpen are client-side
 *   - simplicity-first: reuses 6 existing components; 4 new components match their patterns
 */

import { useDataLoader } from "./lib/useDataLoader.svelte";
import { bridge } from "./stores/bridge";
import type { BuildDashboardData } from "./stores/build-dashboard-types";
import type { Annotation, Decision } from "./stores/bridge-types";

import EmptyState from "./components/EmptyState.svelte";
import Badge from "./components/Badge.svelte";
import SectionHeader from "./components/SectionHeader.svelte";
import FilterableTable from "./components/FilterableTable.svelte";
import RunbookTimeline from "./components/RunbookTimeline.svelte";
import ActionBar from "./components/ActionBar.svelte";
import DagGraph from "./components/DagGraph.svelte";
import TaskPlanCard from "./components/TaskPlanCard.svelte";
import DecisionCard from "./components/DecisionCard.svelte";

// ── Data loading ──────────────────────────────────────────────────────────

const loader = useDataLoader(async () => {
  await bridge.init();
  const result = await bridge.loadData<BuildDashboardData>();
  if (!result) throw new Error("No build dashboard data received");
  return result;
});

let status = $derived(loader.status);
let data = $derived(loader.data);
let errorMsg = $derived(loader.errorMsg);

// ── Annotation state ──────────────────────────────────────────────────────

let annotations = $state<Annotation[]>([]);

/**
 * Accumulate an annotation for a specific section+index.
 * Replaces an existing annotation for the same slot, or adds a new one.
 */
function handleAnnotate(annotation: Annotation) {
  const idx = annotations.findIndex(
    (a) => a.section === annotation.section && a.itemIndex === annotation.itemIndex
  );
  if (idx >= 0) {
    annotations = annotations.map((a, i) => (i === idx ? annotation : a));
  } else {
    annotations = [...annotations, annotation];
  }
}

// ── Decision handlers ─────────────────────────────────────────────────────

async function handleApprove() {
  const decision: Decision = { action: "approve", annotations };
  await bridge.submitDecision(decision);
}

async function handleRequestChanges(feedback: string) {
  const decision: Decision = { action: "request_changes", annotations, feedback };
  await bridge.submitDecision(decision);
}

// ── Derived: outcome banner ───────────────────────────────────────────────

let outcomeColor = $derived(
  data?.brief.outcome === "GREENLIGHT"
    ? "var(--success, #34d399)"
    : data?.brief.outcome === "CAUTION"
      ? "var(--warning, #fbbf24)"
      : "var(--danger, #ff6b6b)"
);

let outcomeLabel = $derived(
  data?.brief.outcome === "GREENLIGHT"
    ? "Greenlight"
    : data?.brief.outcome === "CAUTION"
      ? "Caution"
      : "Stop"
);

// ── Derived: acceptance criteria columns ──────────────────────────────────

const criteriaColumns = [
  { key: "index", label: "#" },
  { key: "text", label: "Criterion", filterable: true },
  { key: "type", label: "Type", filterable: true },
];

let criteriaRows = $derived(
  (data?.acceptance_criteria ?? []).map((ac) => ({
    index: String(ac.index + 1),
    text: ac.text,
    type: ac.type,
  }))
);
</script>

<div class="build-dashboard">
  {#if status === "loading"}
    <EmptyState message="Loading build plan..." />

  {:else if status === "error"}
    <EmptyState message={errorMsg} isError />

  {:else if data}
    <div class="dashboard-content">

      <!-- ── Brief banner ────────────────────────────────────────────────── -->
      <div class="brief-banner" style:--outcome-color={outcomeColor}>
        <div class="brief-left">
          <span class="outcome-label" style:color={outcomeColor}>{outcomeLabel}</span>
          <span class="brief-title">{data.brief.title}</span>
        </div>
        <div class="brief-badges">
          <Badge text="Effort: {data.brief.effort}" color="var(--text-muted, #636a80)" bg="var(--bg-card, rgba(255,255,255,0.06))" />
          <Badge text="Value: {data.brief.value}" color="var(--accent, #6c8cff)" bg="var(--accent-soft, rgba(108,140,255,0.12))" />
        </div>
      </div>

      <!-- ── Acceptance Criteria ────────────────────────────────────────── -->
      {#if data.acceptance_criteria.length > 0}
        <SectionHeader title="Acceptance Criteria" subtitle="{data.acceptance_criteria.length} criteria">
          <FilterableTable columns={criteriaColumns} rows={criteriaRows} />
        </SectionHeader>
      {/if}

      <!-- ── Runbook ───────────────────────────────────────────────────── -->
      {#if data.runbook_steps.length > 0}
        <SectionHeader title="Runbook" subtitle="{data.runbook_steps.length} steps">
          <RunbookTimeline steps={data.runbook_steps} />
        </SectionHeader>
      {/if}

      <!-- ── Task DAG ──────────────────────────────────────────────────── -->
      {#if data.dag.nodes.length > 0}
        <SectionHeader title="Task DAG" subtitle="{data.dag.nodes.length} tasks, {data.dag.edges.length} edges">
          <DagGraph nodes={data.dag.nodes} edges={data.dag.edges} />
        </SectionHeader>
      {/if}

      <!-- ── Task Plans ────────────────────────────────────────────────── -->
      {#if data.task_plans.length > 0}
        <SectionHeader title="Task Plans" subtitle="{data.task_plans.length} tasks" defaultOpen={false}>
          <div class="cards-list">
            {#each data.task_plans as plan (plan.task_id)}
              <TaskPlanCard {plan} />
            {/each}
          </div>
        </SectionHeader>
      {/if}

      <!-- ── Design Decisions ──────────────────────────────────────────── -->
      {#if data.design_decisions.length > 0}
        <SectionHeader title="Design Decisions" subtitle="{data.design_decisions.length} decisions" defaultOpen={false}>
          <div class="cards-list">
            {#each data.design_decisions as decision (decision.decision_id)}
              <DecisionCard {decision} />
            {/each}
          </div>
        </SectionHeader>
      {/if}

      <!-- ── Research Notes (optional) ─────────────────────────────────── -->
      {#if data.research_notes}
        <SectionHeader title="Research Notes" defaultOpen={false}>
          <pre class="research-notes">{data.research_notes}</pre>
        </SectionHeader>
      {/if}

      <!-- Spacer so content isn't hidden behind the fixed action bar -->
      <div class="action-bar-spacer"></div>
    </div>

    <!-- ── Fixed action bar ──────────────────────────────────────────── -->
    <ActionBar
      annotationCount={annotations.length}
      onApprove={handleApprove}
      onRequestChanges={handleRequestChanges}
    />

  {:else}
    <EmptyState message="No build dashboard data available." />
  {/if}
</div>

<style>
  .build-dashboard {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .dashboard-content {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  /* ── Brief banner ───────────────────────────────────────────────────── */

  .brief-banner {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    background: var(--bg-card, rgba(255, 255, 255, 0.06));
    border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    border-left: 4px solid var(--outcome-color, #6c8cff);
    border-radius: var(--radius-sm, 8px);
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .brief-left {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .outcome-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .brief-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
    line-height: 1.3;
  }

  .brief-badges {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  /* ── Cards lists ────────────────────────────────────────────────────── */

  .cards-list {
    display: flex;
    flex-direction: column;
  }

  /* ── Research notes ─────────────────────────────────────────────────── */

  .research-notes {
    font-size: 12px;
    color: var(--text, #b4b8c8);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    margin: 0;
  }

  /* ── Action bar spacer ──────────────────────────────────────────────── */

  .action-bar-spacer {
    height: 64px;
    flex-shrink: 0;
  }
</style>
