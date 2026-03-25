<script lang="ts">
  /**
   * DepRow.svelte
   *
   * A single row in the critical dependencies section. Renders:
   *   - File path with filename portion bold (split on last "/")
   *   - Relationship description text
   *   - Optional risk annotation
   *   - Click handler calling onPrompt with a contextual regression impact prompt
   *
   * Canon principles:
   *   - compose-from-small-to-large: atom component, composed into the deps section
   *   - props-are-the-component-contract: no bridge access, no global state
   */

  interface DepRowProps {
    filePath: string;
    relationship: string;
    riskAnnotation?: string;
    onPrompt: (text: string) => void;
  }

  let { filePath, relationship, riskAnnotation, onPrompt }: DepRowProps = $props();

  /** Split on last "/" to get directory prefix and filename */
  let dirPart = $derived(filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/") + 1) : "");
  let fileName = $derived(filePath.includes("/") ? filePath.slice(filePath.lastIndexOf("/") + 1) : filePath);

  function handleClick() {
    onPrompt(`What breaks if ${filePath} regresses? Show me the dependents`);
  }
</script>

<button class="dep-row" onclick={handleClick} title={filePath}>
  <!-- File path: directory prefix muted, filename bold -->
  <span class="file-path">
    {#if dirPart}
      <span class="dir-part">{dirPart}</span>
    {/if}
    <span class="file-name">{fileName}</span>
  </span>

  <!-- Relationship text -->
  <span class="relationship">{relationship}</span>

  <!-- Risk annotation (optional) -->
  {#if riskAnnotation}
    <span class="risk-annotation">{riskAnnotation}</span>
  {/if}
</button>

<style>
  .dep-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 12px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: inherit;
    transition: background 0.12s;
    border-radius: 0;
    min-height: 28px;
  }

  .dep-row:hover {
    background: var(--bg-card-hover, rgba(255,255,255,0.09));
  }

  /* ── File path ─────────────────────────────────────────────────────────── */

  .file-path {
    font-family: monospace;
    font-size: 11px;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .dir-part {
    color: var(--text-muted, #636a80);
  }

  .file-name {
    font-weight: 700;
    color: var(--text-bright, #e8eaf0);
  }

  /* ── Relationship text ─────────────────────────────────────────────────── */

  .relationship {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 180px;
  }

  /* ── Risk annotation ───────────────────────────────────────────────────── */

  .risk-annotation {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(251, 191, 36, 0.12);
    color: var(--warning, #fbbf24);
    flex-shrink: 0;
    white-space: nowrap;
  }
</style>
