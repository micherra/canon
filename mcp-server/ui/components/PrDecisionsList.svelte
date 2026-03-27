<script lang="ts">
  /**
   * PrDecisionsList.svelte
   *
   * Displays a list of prior deviation decisions relevant to a file's violations
   * in the PR detail panel. Pure presentation — no data fetching.
   *
   * Canon principles:
   *   - compose-from-small-to-large: extracted from PrDetailPanel for single responsibility
   *   - props-are-the-component-contract: all data via props, no bridge access
   */

  interface Decision {
    principle_id: string;
    file_path: string;
    justification: string;
    category?: string;
  }

  interface PrDecisionsListProps {
    decisions: Decision[];
  }

  let { decisions }: PrDecisionsListProps = $props();
</script>

{#if decisions.length === 0}
  <div class="empty-section">No prior deviation decisions for these principles</div>
{:else}
  {#each decisions as decision}
    <div class="decision-card">
      <div class="decision-card-top">
        <span class="principle-id">{decision.principle_id}</span>
        {#if decision.category}
          <span class="category-badge">{decision.category}</span>
        {/if}
      </div>
      <p class="decision-justification">{decision.justification}</p>
    </div>
  {/each}
{/if}

<style>
  .empty-section {
    font-size: 12px;
    color: var(--text-muted);
    padding: 4px 0;
  }

  .decision-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    padding: 10px 12px;
    margin-bottom: 6px;
  }

  .decision-card-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }

  .principle-id {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-bright);
    word-break: break-all;
  }

  .category-badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--bg-card);
    border: 1px solid var(--border);
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  .decision-justification {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }
</style>
