<script lang="ts">
/**
 * DecisionCard.svelte
 *
 * Collapsible card for a single design decision entry.
 * Collapsed: shows decision_id, title, status badge.
 * Expanded: shows full body as <pre>.
 *
 * Canon principles:
 *   - compose-from-small-to-large: atom composed into BuildDashboard decisions section
 *   - props-are-the-component-contract: accepts DesignDecisionEntry, no store coupling
 *   - minimize-client-side-state: only isOpen is client-side state
 */

import type { DesignDecisionEntry } from "../stores/build-dashboard-types.ts";
import Badge from "./Badge.svelte";

interface DecisionCardProps {
  decision: DesignDecisionEntry;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { decision }: DecisionCardProps = $props();
let isOpen = $state(false);

function toggle() {
  isOpen = !isOpen;
}

/** Map decision status to a badge color. */
function statusColor(status: string): { color: string; bg: string } {
  switch (status.toLowerCase()) {
    case "resolved":
      return { color: "#34d399", bg: "rgba(52,211,153,0.12)" };
    case "open":
      return { color: "#fbbf24", bg: "rgba(251,191,36,0.12)" };
    case "superseded":
      return { color: "#636a80", bg: "rgba(255,255,255,0.06)" };
    default:
      return { color: "#636a80", bg: "rgba(255,255,255,0.06)" };
  }
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let statusStyle = $derived(statusColor(decision.status));
</script>

<div class="decision-card">
  <!-- Collapsed header: always visible -->
  <button class="card-header" onclick={toggle} aria-expanded={isOpen}>
    <div class="header-left">
      <span class="decision-id">{decision.decision_id}</span>
      <Badge text={decision.status} color={statusStyle.color} bg={statusStyle.bg} rounded />
      <span class="decision-title">{decision.title}</span>
    </div>
    <span class="chevron" class:open={isOpen}>&#8250;</span>
  </button>

  <!-- Expanded body: full decision text -->
  {#if isOpen}
    <div class="card-body">
      {#if decision.body}
        <pre class="decision-body">{decision.body}</pre>
      {:else}
        <span class="no-body">No decision body available.</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .decision-card {
    border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    border-radius: var(--radius, 12px);
    overflow: hidden;
    margin-bottom: 8px;
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0, 0, 0, 0.3));
    transition: box-shadow 0.2s, border-color 0.2s;
  }

  .decision-card:hover {
    border-color: rgba(255, 255, 255, 0.12);
    box-shadow: var(--shadow, 0 4px 16px rgba(0, 0, 0, 0.4));
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 14px 16px;
    background: var(--bg-surface, rgba(255, 255, 255, 0.03));
    border: none;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    color: var(--text-bright, #e8eaf0);
    transition: background 0.15s;
    gap: 12px;
  }

  .card-header:hover {
    background: var(--bg-card, rgba(255, 255, 255, 0.06));
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .decision-id {
    font-size: 11px;
    font-family: ui-monospace, monospace;
    color: var(--text-muted, #636a80);
    flex-shrink: 0;
  }

  .decision-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-bright, #e8eaf0);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chevron {
    font-size: 18px;
    color: var(--text-muted, #636a80);
    transition: transform 0.2s;
    transform: rotate(90deg);
    display: inline-block;
    line-height: 1;
    flex-shrink: 0;
  }

  .chevron.open {
    transform: rotate(-90deg);
  }

  .card-body {
    padding: 16px;
    border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    background: var(--bg-surface, rgba(255, 255, 255, 0.03));
  }

  .decision-body {
    font-size: 13px;
    color: var(--text, #b4b8c8);
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    margin: 0;
  }

  .no-body {
    font-size: 13px;
    color: var(--text-muted, #636a80);
    font-style: italic;
  }
</style>
