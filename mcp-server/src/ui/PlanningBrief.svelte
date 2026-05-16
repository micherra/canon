<script lang="ts">
/**
 * PlanningBrief.svelte
 *
 * Container component for the Canon planning brief interactive view.
 *
 * Renders the full planning brief with 8 collapsible sections:
 * outcome banner, assumptions, acceptance criteria, requirement coverage,
 * risk findings, runbook, constraints, and optional research notes.
 *
 * Follows the same pattern as PrReview.svelte: useDataLoader +
 * bridge.init/loadData + $derived reactive aliases.
 *
 * Canon principles:
 *   - compose-from-small-to-large: pure composition; no leaf rendering logic
 *   - props-are-the-component-contract: no props — all state internal
 *   - functions-do-one-thing: annotation accumulation is isolated in handleAnnotate
 */

import { useDataLoader } from "./lib/useDataLoader.svelte";
import { bridge } from "./stores/bridge";
import type { PlanningBriefData, RequirementCoverageRow } from "./stores/planning-brief-types";
import type { Annotation, Decision } from "./stores/bridge-types";

import EmptyState from "./components/EmptyState.svelte";
import Badge from "./components/Badge.svelte";
import SectionHeader from "./components/SectionHeader.svelte";
import AssumptionRow from "./components/AssumptionRow.svelte";
import CriterionRow from "./components/CriterionRow.svelte";
import FilterableTable from "./components/FilterableTable.svelte";
import RunbookTimeline from "./components/RunbookTimeline.svelte";
import ActionBar from "./components/ActionBar.svelte";

// ── Data loading ──────────────────────────────────────────────────────────

const loader = useDataLoader(async () => {
  await bridge.init();
  const result = await bridge.loadData<PlanningBriefData>();
  if (!result) throw new Error("No planning brief data received");
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

/**
 * Find the existing annotation for a specific section and item.
 */
function getAnnotation(section: string, itemIndex: number): Annotation | undefined {
  return annotations.find((a) => a.section === section && a.itemIndex === itemIndex);
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
  data?.outcome === "GREENLIGHT"
    ? "var(--success, #34d399)"
    : data?.outcome === "CAUTION"
      ? "var(--warning, #fbbf24)"
      : "var(--danger, #ff6b6b)"
);

let outcomeLabel = $derived(
  data?.outcome === "GREENLIGHT"
    ? "Greenlight"
    : data?.outcome === "CAUTION"
      ? "Caution"
      : "Stop"
);

// ── Derived: requirement coverage map columns ─────────────────────────────

const coverageColumns = [
  { key: "id", label: "ID" },
  { key: "requirement", label: "Requirement", filterable: true },
  { key: "disposition", label: "Disposition", filterable: true },
  { key: "rationale", label: "Rationale", filterable: false },
];

let coverageRows = $derived(
  (data?.requirement_coverage ?? []).map((row: RequirementCoverageRow) => ({
    id: row.id,
    requirement: row.requirement,
    disposition: row.disposition,
    rationale: row.rationale,
  }))
);

// ── Derived: risk severity badge colours ──────────────────────────────────

function riskBadge(severity: string): { color: string; bg: string } {
  switch (severity) {
    case "high":
      return { color: "#ff6b6b", bg: "rgba(255,107,107,0.12)" };
    case "medium":
      return { color: "#fbbf24", bg: "rgba(251,191,36,0.12)" };
    default:
      return { color: "#34d399", bg: "rgba(52,211,153,0.12)" };
  }
}
</script>

<div class="planning-brief">
  {#if status === "loading"}
    <EmptyState message="Loading planning brief..." />

  {:else if status === "error"}
    <EmptyState message={errorMsg} isError />

  {:else if data}
    <div class="brief-content">

      <!-- ── Outcome banner ─────────────────────────────────────────────── -->
      <div class="outcome-banner" style:--outcome-color={outcomeColor}>
        <div class="outcome-left">
          <span class="outcome-label" style:color={outcomeColor}>{outcomeLabel}</span>
          <span class="outcome-title">{data.title}</span>
        </div>
        <div class="outcome-badges">
          <Badge text="Effort: {data.effort}" color="var(--text-muted, #636a80)" bg="var(--bg-card, rgba(255,255,255,0.06))" />
          <Badge text="Value: {data.value}" color="var(--accent, #6c8cff)" bg="var(--accent-soft, rgba(108,140,255,0.12))" />
        </div>
      </div>

      <!-- ── Assumptions ────────────────────────────────────────────────── -->
      {#if data.assumptions.length > 0}
        <SectionHeader title="Assumptions" subtitle="{data.assumptions.length} items">
          <div class="item-list">
            {#each data.assumptions as assumption (assumption.index)}
              <AssumptionRow
                {assumption}
                annotation={getAnnotation("assumptions", assumption.index)}
                onAnnotate={handleAnnotate}
              />
            {/each}
          </div>
        </SectionHeader>
      {/if}

      <!-- ── Acceptance criteria ────────────────────────────────────────── -->
      {#if data.acceptance_criteria.length > 0}
        <SectionHeader title="Acceptance Criteria" subtitle="{data.acceptance_criteria.length} items">
          <div class="item-list">
            {#each data.acceptance_criteria as criterion (criterion.index)}
              <CriterionRow
                {criterion}
                annotation={getAnnotation("criteria", criterion.index)}
                onAnnotate={handleAnnotate}
              />
            {/each}
          </div>
        </SectionHeader>
      {/if}

      <!-- ── Requirement coverage map ───────────────────────────────────── -->
      {#if data.requirement_coverage.length > 0}
        <SectionHeader title="Requirement Coverage" subtitle="{data.requirement_coverage.length} requirements">
          <FilterableTable columns={coverageColumns} rows={coverageRows} />
        </SectionHeader>
      {/if}

      <!-- ── Risk findings ──────────────────────────────────────────────── -->
      {#if data.risk_findings.length > 0}
        <SectionHeader title="Risk Findings" subtitle="{data.risk_findings.length} findings" defaultOpen={false}>
          <div class="risk-list">
            {#each data.risk_findings as risk (risk.id)}
              {@const rb = riskBadge(risk.severity)}
              <div class="risk-card">
                <div class="risk-header">
                  <Badge text={risk.severity} color={rb.color} bg={rb.bg} rounded />
                  <span class="risk-id">{risk.id}</span>
                </div>
                <p class="risk-description">{risk.description}</p>
                <p class="risk-mitigation">
                  <span class="risk-mitigation-label">Mitigation:</span>
                  {risk.mitigation}
                </p>
              </div>
            {/each}
          </div>
        </SectionHeader>
      {/if}

      <!-- ── Runbook ─────────────────────────────────────────────────────── -->
      {#if data.runbook_steps.length > 0}
        <SectionHeader title="Runbook" subtitle="{data.runbook_steps.length} steps">
          <RunbookTimeline steps={data.runbook_steps} />
        </SectionHeader>
      {/if}

      <!-- ── Constraints ────────────────────────────────────────────────── -->
      {#if data.constraints.length > 0}
        <SectionHeader title="Constraints" subtitle="{data.constraints.length} constraints" defaultOpen={false}>
          <ul class="constraints-list">
            {#each data.constraints as constraint, i (i)}
              <li class="constraint-item">{constraint}</li>
            {/each}
          </ul>
        </SectionHeader>
      {/if}

      <!-- ── Research notes (optional) ─────────────────────────────────── -->
      {#if data.research_notes}
        <SectionHeader title="Research Notes" defaultOpen={false}>
          <pre class="research-notes">{data.research_notes}</pre>
        </SectionHeader>
      {/if}

      <!-- Spacer so content isn't hidden behind the fixed action bar -->
      <div class="action-bar-spacer"></div>
    </div>

    <!-- ── Fixed action bar ───────────────────────────────────────────── -->
    <ActionBar
      annotationCount={annotations.length}
      onApprove={handleApprove}
      onRequestChanges={handleRequestChanges}
    />

  {:else}
    <EmptyState message="No planning brief data available." />
  {/if}
</div>

<style>
  .planning-brief {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .brief-content {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  /* ── Outcome banner ──────────────────────────────────────────────────── */

  .outcome-banner {
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
    gap: 10px;
  }

  .outcome-left {
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

  .outcome-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
    line-height: 1.3;
  }

  .outcome-badges {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  /* ── Item lists (assumptions, criteria) ──────────────────────────────── */

  .item-list {
    display: flex;
    flex-direction: column;
  }

  /* ── Risk findings ───────────────────────────────────────────────────── */

  .risk-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .risk-card {
    padding: 10px 12px;
    background: var(--bg-surface, rgba(255, 255, 255, 0.03));
    border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    border-radius: 6px;
  }

  .risk-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  .risk-id {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    font-family: ui-monospace, monospace;
  }

  .risk-description {
    font-size: 12px;
    color: var(--text, #b4b8c8);
    line-height: 1.5;
    margin-bottom: 6px;
  }

  .risk-mitigation {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    line-height: 1.4;
  }

  .risk-mitigation-label {
    font-weight: 600;
    color: var(--text, #b4b8c8);
    margin-right: 4px;
  }

  /* ── Constraints ─────────────────────────────────────────────────────── */

  .constraints-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0;
    margin: 0;
  }

  .constraint-item {
    font-size: 12px;
    color: var(--text, #b4b8c8);
    line-height: 1.5;
    padding-left: 14px;
    position: relative;
  }

  .constraint-item::before {
    content: "•";
    position: absolute;
    left: 0;
    color: var(--text-muted, #636a80);
  }

  /* ── Research notes ──────────────────────────────────────────────────── */

  .research-notes {
    font-size: 12px;
    color: var(--text, #b4b8c8);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    margin: 0;
  }

  /* ── Action bar spacer ───────────────────────────────────────────────── */

  .action-bar-spacer {
    height: 64px;
    flex-shrink: 0;
  }
</style>
