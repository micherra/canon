<script lang="ts">
/**
 * SubsystemsPanel.svelte
 *
 * Displays new and removed subsystems detected in the PR.
 * Each subsystem entry shows a directory path, a colored label badge
 * ("new" in green, "removed" in red), and a file count.
 * Pure presentation — receives all data via props, no data fetching.
 *
 * Canon principles:
 *   - functions-do-one-thing: renders subsystem labels panel only
 *   - compose-from-small-to-large: used as a leaf panel by PrReview.svelte
 */

interface SubsystemEntry {
  directory: string;
  label: "new" | "removed";
  file_count: number;
}

interface SubsystemsPanelProps {
  subsystems: SubsystemEntry[];
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { subsystems }: SubsystemsPanelProps = $props();
</script>

<div class="subsystems-panel">
  <div class="section-title">New Subsystems Added</div>

  {#if subsystems.length === 0}
    <div class="empty">No new subsystems detected</div>
  {:else}
    <div class="subsystem-list">
      {#each subsystems as subsystem (subsystem.directory)}
        <div class="subsystem-row">
          <span class="directory" title={subsystem.directory}>{subsystem.directory}</span>
          <span
            class="label-badge"
            class:label-new={subsystem.label === "new"}
            class:label-removed={subsystem.label === "removed"}
          >
            {subsystem.label}
          </span>
          <span class="file-count">{subsystem.file_count} {subsystem.file_count === 1 ? "file" : "files"}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .subsystems-panel {
    padding: 12px 16px;
    background: var(--bg-card, rgba(255, 255, 255, 0.04));
    border-radius: 6px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  }

  .section-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted, #888);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 12px;
  }

  .empty {
    font-size: 12px;
    color: var(--text-muted, #888);
    text-align: center;
    padding: 8px 0;
  }

  .subsystem-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .subsystem-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .directory {
    flex: 1;
    color: var(--text, #e0e0e0);
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .label-badge {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .label-new {
    background: color-mix(in srgb, var(--success, #52b052) 18%, transparent);
    color: var(--success, #52b052);
    border: 1px solid color-mix(in srgb, var(--success, #52b052) 35%, transparent);
  }

  .label-removed {
    background: color-mix(in srgb, var(--danger, #e05252) 18%, transparent);
    color: var(--danger, #e05252);
    border: 1px solid color-mix(in srgb, var(--danger, #e05252) 35%, transparent);
  }

  .file-count {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-muted, #888);
    white-space: nowrap;
  }
</style>
