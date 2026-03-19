<script lang="ts">
  let { text = "", visible = false, x = 0, y = 0 }: {
    text: string;
    visible: boolean;
    x: number;
    y: number;
  } = $props();
</script>

{#if visible && text}
  <div class="tooltip" style="left:{x}px;top:{y}px">
    {text}
  </div>
{/if}

<style>
  .tooltip {
    position: fixed;
    z-index: 1000;
    pointer-events: none;
    background: #14182aee;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 11px;
    line-height: 1.5;
    max-width: 300px;
    color: var(--text);
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    white-space: pre-line;
  }
</style>
