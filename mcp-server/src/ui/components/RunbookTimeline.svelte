<script lang="ts">
/**
 * RunbookTimeline.svelte
 *
 * Visual vertical timeline of runbook steps.
 * Each step shows agent badge, dispatch type, and expected artifacts.
 *
 * Canon principles:
 *   - compose-from-small-to-large: composes Badge; no annotation concerns
 *   - props-are-the-component-contract: RunbookStep[] is the only coupling
 *   - functions-do-one-thing: renders timeline steps; no state mutations
 */

import type { RunbookStep } from "../stores/planning-brief-types.ts";
import Badge from "./Badge.svelte";

interface RunbookTimelineProps {
  steps: RunbookStep[];
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { steps }: RunbookTimelineProps = $props();

/** Map agent name to a consistent colour. */
function agentColor(agent: string): { color: string; bg: string } {
  switch (agent) {
    case "engineer":
      return { color: "#6c8cff", bg: "rgba(108,140,255,0.12)" };
    case "reviewer":
      return { color: "#34d399", bg: "rgba(52,211,153,0.12)" };
    case "tester":
      return { color: "#fbbf24", bg: "rgba(251,191,36,0.12)" };
    case "architect":
      return { color: "#a78bfa", bg: "rgba(167,139,250,0.12)" };
    case "planner":
      return { color: "#60a5fa", bg: "rgba(96,165,250,0.12)" };
    case "security":
      return { color: "#ff6b6b", bg: "rgba(255,107,107,0.12)" };
    case "scribe":
      return { color: "#94a3b8", bg: "rgba(148,163,184,0.12)" };
    case "shipper":
      return { color: "#34d399", bg: "rgba(52,211,153,0.10)" };
    default:
      return { color: "#636a80", bg: "rgba(255,255,255,0.06)" };
  }
}

function dispatchColor(dispatch: string): { color: string; bg: string } {
  return dispatch === "team"
    ? { color: "#fbbf24", bg: "rgba(251,191,36,0.12)" }
    : { color: "#636a80", bg: "rgba(255,255,255,0.06)" };
}
</script>

<div class="timeline">
  {#each steps as step, i (step.id)}
    {@const ac = agentColor(step.agent)}
    {@const dc = dispatchColor(step.dispatch)}
    <div class="timeline-item">
      <!-- Connector line and dot -->
      <div class="timeline-rail">
        <div class="timeline-dot"></div>
        {#if i < steps.length - 1}
          <div class="timeline-line"></div>
        {/if}
      </div>

      <!-- Step content -->
      <div class="timeline-content">
        <div class="step-header">
          <span class="step-id">{step.id}</span>
          <span class="step-name">{step.name}</span>
          <Badge text={step.agent} color={ac.color} bg={ac.bg} />
          <Badge text={step.dispatch} color={dc.color} bg={dc.bg} />
        </div>
        {#if step.artifacts.length > 0}
          <div class="step-artifacts">
            {#each step.artifacts as artifact (artifact)}
              <span class="artifact-pill">{artifact}</span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="no-steps">No runbook steps available.</div>
  {/each}
</div>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .timeline-item {
    display: flex;
    gap: 10px;
    min-height: 40px;
  }

  .timeline-rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    width: 16px;
    padding-top: 4px;
  }

  .timeline-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent, #6c8cff);
    flex-shrink: 0;
  }

  .timeline-line {
    flex: 1;
    width: 1px;
    background: var(--border, rgba(255, 255, 255, 0.08));
    margin-top: 3px;
    min-height: 20px;
  }

  .timeline-content {
    flex: 1;
    padding-bottom: 14px;
    min-width: 0;
  }

  .step-header {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .step-id {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
  }

  .step-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .step-artifacts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }

  .artifact-pill {
    font-size: 10px;
    color: var(--text-muted, #636a80);
    background: var(--bg-surface, rgba(255, 255, 255, 0.03));
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.04));
    border-radius: 3px;
    padding: 1px 5px;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    overflow: hidden;
    max-width: 200px;
    text-overflow: ellipsis;
  }

  .no-steps {
    font-size: 12px;
    color: var(--text-muted, #636a80);
    padding: 8px 0;
  }
</style>
