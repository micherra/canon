<script lang="ts">
/**
 * FilterableTable.svelte
 *
 * Generic filterable table for requirement coverage map and similar tabular data.
 * Column filter inputs appear on click; rows are filtered case-insensitively.
 * Disposition values ("covered", "partial", "descoped") are color-coded via Badge.
 *
 * Canon principles:
 *   - compose-from-small-to-large: composes Badge; columns define the layout contract
 *   - props-are-the-component-contract: columns and rows via typed props; no global state
 *   - functions-do-one-thing: handles filtering and rendering; no annotation concerns
 */

import Badge from "./Badge.svelte";

interface Column {
  key: string;
  label: string;
  filterable?: boolean;
}

interface FilterableTableProps {
  columns: Column[];
  rows: Array<Record<string, string>>;
  onPrompt?: (text: string) => void;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { columns, rows, onPrompt }: FilterableTableProps = $props();

/** Active filter value per column key. */
let filters = $state<Record<string, string>>({});
/** Whether the filter input is visible for each filterable column. */
let filterOpen = $state<Record<string, boolean>>({});

function toggleFilter(key: string) {
  filterOpen[key] = !filterOpen[key];
  if (!filterOpen[key]) {
    filters[key] = "";
  }
}

let filteredRows = $derived(
  rows.filter((row) =>
    columns.every((col) => {
      const filterVal = (filters[col.key] ?? "").trim().toLowerCase();
      if (!filterVal) return true;
      return (row[col.key] ?? "").toLowerCase().includes(filterVal);
    })
  )
);

/** Return Badge props for disposition values. */
function dispositionBadge(value: string): { text: string; color: string; bg: string } {
  switch (value) {
    case "covered":
      return { text: "covered", color: "#34d399", bg: "rgba(52,211,153,0.12)" };
    case "partial":
      return { text: "partial", color: "#fbbf24", bg: "rgba(251,191,36,0.12)" };
    case "descoped":
      return { text: "descoped", color: "#ff6b6b", bg: "rgba(255,107,107,0.12)" };
    default:
      return { text: value, color: "#636a80", bg: "rgba(255,255,255,0.06)" };
  }
}

function isDispositionColumn(col: Column): boolean {
  return col.key === "disposition";
}
</script>

<div class="filterable-table-wrapper">
  <table class="filterable-table">
    <thead>
      <tr>
        {#each columns as col (col.key)}
          <th class="th" class:filterable={col.filterable}>
            <div class="th-inner">
              <span class="th-label">{col.label}</span>
              {#if col.filterable}
                <button
                  class="filter-toggle"
                  onclick={() => toggleFilter(col.key)}
                  aria-label={`Filter ${col.label}`}
                  title={`Filter ${col.label}`}
                >
                  &#9776;
                </button>
              {/if}
            </div>
            {#if col.filterable && filterOpen[col.key]}
              <input
                class="filter-input"
                type="text"
                placeholder="Filter..."
                bind:value={filters[col.key]}
                aria-label={`Filter ${col.label}`}
              />
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each filteredRows as row, i (i)}
        <tr class="tr">
          {#each columns as col (col.key)}
            <td class="td">
              {#if isDispositionColumn(col)}
                {@const badge = dispositionBadge(row[col.key] ?? "")}
                <Badge text={badge.text} color={badge.color} bg={badge.bg} />
              {:else}
                <span class="cell-text">{row[col.key] ?? ""}</span>
              {/if}
            </td>
          {/each}
        </tr>
      {:else}
        <tr>
          <td colspan={columns.length} class="empty-row">No matching rows.</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .filterable-table-wrapper {
    overflow-x: auto;
    width: 100%;
  }

  .filterable-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    table-layout: fixed;
  }

  .th {
    padding: 6px 8px;
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    background: var(--bg-surface, rgba(255, 255, 255, 0.03));
    border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    white-space: nowrap;
    vertical-align: top;
  }

  .th-inner {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .th-label {
    flex: 1;
  }

  .filter-toggle {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-muted, #636a80);
    font-size: 10px;
    padding: 1px 3px;
    border-radius: 2px;
    transition: color 0.15s;
  }

  .filter-toggle:hover {
    color: var(--accent, #6c8cff);
  }

  .filter-input {
    display: block;
    width: 100%;
    margin-top: 4px;
    padding: 3px 6px;
    background: var(--bg, #0c0f1a);
    border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
    border-radius: 3px;
    color: var(--text, #b4b8c8);
    font-family: inherit;
    font-size: 11px;
    outline: none;
  }

  .filter-input:focus {
    border-color: var(--accent, #6c8cff);
  }

  .tr:hover {
    background: var(--bg-card-hover, rgba(255, 255, 255, 0.04));
  }

  .td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.04));
    vertical-align: top;
    color: var(--text, #b4b8c8);
    word-break: break-word;
  }

  .cell-text {
    font-size: 12px;
    line-height: 1.4;
  }

  .empty-row {
    padding: 16px 8px;
    text-align: center;
    color: var(--text-muted, #636a80);
    font-size: 12px;
  }
</style>
