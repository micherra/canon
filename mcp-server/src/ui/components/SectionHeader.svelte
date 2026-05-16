<script lang="ts">
/**
 * SectionHeader.svelte
 *
 * Collapsible section header with expand/collapse toggle.
 * Wraps slotted content with a chevron-toggled visibility gate.
 *
 * Canon principles:
 *   - compose-from-small-to-large: atom component composed into PlanningBrief sections
 *   - props-are-the-component-contract: all behaviour configured via typed props
 *   - functions-do-one-thing: handles only collapsing; no data concerns
 */

import { type Snippet } from "svelte";

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children?: Snippet;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { title, subtitle, defaultOpen = true, children }: SectionHeaderProps = $props();

let isOpen = $state(defaultOpen);

function toggle() {
  isOpen = !isOpen;
}
</script>

<div class="section">
  <button class="section-header" onclick={toggle} aria-expanded={isOpen}>
    <div class="header-left">
      <span class="section-title">{title}</span>
      {#if subtitle}
        <span class="section-subtitle">{subtitle}</span>
      {/if}
    </div>
    <span class="chevron" class:open={isOpen}>&#8250;</span>
  </button>
  {#if isOpen && children}
    <div class="section-body">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .section {
    border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    border-radius: var(--radius-sm, 8px);
    overflow: hidden;
    margin-bottom: 8px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-surface, rgba(255, 255, 255, 0.03));
    border: none;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    color: var(--text-bright, #e8eaf0);
    transition: background 0.15s;
  }

  .section-header:hover {
    background: var(--bg-card, rgba(255, 255, 255, 0.06));
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .section-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
  }

  .section-subtitle {
    font-size: 11px;
    color: var(--text-muted, #636a80);
  }

  .chevron {
    font-size: 16px;
    color: var(--text-muted, #636a80);
    transition: transform 0.2s;
    transform: rotate(90deg);
    display: inline-block;
    line-height: 1;
    flex-shrink: 0;
  }

  .chevron.open {
    transform: rotate(-90deg);
  }

  .section-body {
    padding: 12px;
    border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  }
</style>
