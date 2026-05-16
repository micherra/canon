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
    border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    border-radius: var(--radius, 12px);
    overflow: hidden;
    margin-bottom: 12px;
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0, 0, 0, 0.3));
    transition: box-shadow 0.2s;
  }

  .section:hover {
    box-shadow: var(--shadow, 0 4px 16px rgba(0, 0, 0, 0.4));
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 14px 18px;
    background: linear-gradient(
      135deg,
      var(--bg-card, rgba(255, 255, 255, 0.06)) 0%,
      var(--bg-surface, rgba(255, 255, 255, 0.03)) 100%
    );
    border: none;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    color: var(--text-bright, #e8eaf0);
    transition: background 0.15s;
  }

  .section-header:hover {
    background: var(--bg-card, rgba(255, 255, 255, 0.07));
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
    letter-spacing: 0.01em;
  }

  .section-subtitle {
    font-size: 12px;
    color: var(--text-muted, #636a80);
  }

  .chevron {
    font-size: 18px;
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
    padding: 16px 18px;
    border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  }
</style>
