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

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { filePath, relationship, riskAnnotation, onPrompt }: DepRowProps = $props();

function _handleClick() {
  onPrompt(`What breaks if ${filePath} regresses? Show me the dependents`);
}
</script>

<button class="dep-row btn-reset" onclick={handleClick} title={filePath}>
  <!-- File path: directory prefix muted, filename bold -->
  <FilePath path={filePath} />

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
    padding: 5px 12px;
    transition: background 0.12s;
    border-radius: 0;
    min-height: 28px;
  }

  .dep-row:hover {
    background: var(--bg-card-hover, rgba(255,255,255,0.09));
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
