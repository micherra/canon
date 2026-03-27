<script lang="ts">
  /**
   * PrBlastRadiusSection.svelte
   *
   * Displays the blast radius (affected files by depth) for a single file
   * in the PR detail panel. Pure presentation — no data fetching.
   *
   * Canon principles:
   *   - compose-from-small-to-large: extracted from PrDetailPanel for single responsibility
   *   - props-are-the-component-contract: all data via props, no bridge access
   */

  import { basename } from "../lib/graph";

  interface BlastRadiusEntry {
    entity_name: string;
    entity_kind: string;
    file_path: string;
    depth: number;
  }

  interface PrBlastRadiusSectionProps {
    entries: BlastRadiusEntry[];
    onFileClick: (fileId: string) => void;
  }

  let { entries, onFileClick }: PrBlastRadiusSectionProps = $props();

  const maxShown = 10;

  /** Blast radius entries grouped by depth */
  let byDepth = $derived.by(() => {
    const map = new Map<number, BlastRadiusEntry[]>();
    for (const entry of entries) {
      if (!map.has(entry.depth)) map.set(entry.depth, []);
      map.get(entry.depth)!.push(entry);
    }
    return [...map.entries()].sort(([a], [b]) => a - b);
  });
</script>

<div class="blast-radius-list">
  {#each byDepth as [depth, depthEntries]}
    <div class="depth-group">
      <div class="depth-indicator">
        <span class="depth-num">{depth}</span>
        <span class="depth-line"></span>
      </div>
      <div class="depth-files">
        {#each depthEntries.slice(0, maxShown) as entry}
          <button
            class="file-link"
            onclick={() => onFileClick(entry.file_path)}
            title={entry.file_path}
          >
            {basename(entry.file_path)}
          </button>
        {/each}
        {#if depthEntries.length > maxShown}
          <span class="more-indicator">+{depthEntries.length - maxShown} more</span>
        {/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .blast-radius-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .depth-group {
    display: flex;
    gap: 8px;
    min-height: 24px;
  }

  .depth-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 18px;
    flex-shrink: 0;
  }

  .depth-num {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--bg-card);
    border: 1px solid var(--border);
    font-size: 9px;
    font-weight: 700;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .depth-line {
    flex: 1;
    width: 1px;
    background: var(--border);
    margin: 2px 0;
  }

  .depth-files {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: flex-start;
    padding: 2px 0;
  }

  .file-link {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    padding: 1px 0;
    cursor: pointer;
    color: var(--accent);
    font-family: inherit;
    font-size: 11px;
    text-align: left;
  }

  .file-link:hover {
    text-decoration: underline;
  }

  .more-indicator {
    font-size: 10px;
    color: var(--text-muted);
  }
</style>
