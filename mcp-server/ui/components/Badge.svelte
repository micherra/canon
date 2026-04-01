<script lang="ts">
/**
 * Badge.svelte
 *
 * A flexible inline badge/pill. Colour is driven by CSS custom properties
 * so callers can inject any palette without class proliferation.
 * The `rounded` prop switches between a pill shape (border-radius: 10px)
 * and the default small-radius rectangle (border-radius: 3px).
 *
 * Canon principles:
 *   - compose-from-small-to-large: atom component, replaces inline badge spans
 *   - props-are-the-component-contract: no bridge access, no global state
 */

interface BadgeProps {
  text: string;
  color?: string;
  bg?: string;
  rounded?: boolean;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { text, color, bg, rounded = false }: BadgeProps = $props();
</script>

<span
  class="badge"
  class:rounded
  style:--badge-color={color}
  style:--badge-bg={bg}
>
  {text}
</span>

<style>
  .badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
    white-space: nowrap;
    letter-spacing: 0.03em;
    background: var(--badge-bg, var(--bg-card, rgba(255,255,255,0.06)));
    color: var(--badge-color, var(--text-muted, #636a80));
  }

  .badge.rounded {
    border-radius: 10px;
    padding: 1px 6px;
  }
</style>
