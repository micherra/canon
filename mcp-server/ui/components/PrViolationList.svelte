<script lang="ts">
  /**
   * PrViolationList.svelte
   *
   * Displays a list of principle violations for a single file in the PR detail panel.
   * Pure presentation — no data fetching, no store access.
   *
   * Canon principles:
   *   - compose-from-small-to-large: extracted from PrDetailPanel for single responsibility
   *   - props-are-the-component-contract: all data via props, no bridge access
   */

  import { getSeverityColor } from "../lib/utils";

  interface Violation {
    principle_id: string;
    severity: string;
    message?: string;
  }

  interface PrViolationListProps {
    violations: Violation[];
  }

  let { violations }: PrViolationListProps = $props();
</script>

{#if violations.length === 0}
  <div class="empty-section">No violations</div>
{:else}
  {#each violations as violation}
    <div class="violation-card">
      <div class="violation-card-top">
        <span
          class="severity-badge"
          style="background:{getSeverityColor(violation.severity)}"
        >{violation.severity}</span>
        <span class="principle-id">{violation.principle_id}</span>
      </div>
      <p class="violation-message">
        {(violation.message ?? "") || "No details available"}
      </p>
    </div>
  {/each}
{/if}

<style>
  .empty-section {
    font-size: 12px;
    color: var(--text-muted);
    padding: 4px 0;
  }

  .violation-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    padding: 10px 12px;
    margin-bottom: 6px;
  }

  .violation-card-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .severity-badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    color: white;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .principle-id {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-bright);
    word-break: break-all;
  }

  .violation-message {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }
</style>
