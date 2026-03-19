<script lang="ts">
  let visible = $state(false);

  import { onMount } from "svelte";
  onMount(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "?") visible = !visible;
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  });
</script>

<div class="help-overlay" class:visible>
  <div><kbd>/</kbd>Search files</div>
  <div><kbd>Esc</kbd>Clear selection</div>
  <div><kbd>?</kbd>Toggle this help</div>
</div>

<style>
  .help-overlay {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: #14182af0; border: 1px solid rgba(255,255,255,0.1);
    border-radius: var(--radius); padding: 16px 24px;
    font-size: 12px; z-index: 200; box-shadow: var(--shadow-lg);
    display: none;
  }
  .help-overlay.visible { display: block; }
  kbd {
    background: var(--bg-card); padding: 2px 6px; border-radius: 3px;
    font-family: inherit; font-size: 11px; font-weight: 600; color: var(--text-bright);
    border: 1px solid var(--border); margin-right: 8px;
  }
  .help-overlay div { padding: 3px 0; }
</style>
