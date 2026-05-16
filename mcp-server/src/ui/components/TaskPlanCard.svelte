<script lang="ts">
/**
 * TaskPlanCard.svelte
 *
 * Collapsible card for a single task plan entry.
 * Collapsed: shows task_id, wave badge, file count, title.
 * Expanded: shows full body as <pre>, files list, principles badges.
 *
 * Canon principles:
 *   - compose-from-small-to-large: atom composed into BuildDashboard task plans section
 *   - props-are-the-component-contract: accepts TaskPlanEntry, no store coupling
 *   - minimize-client-side-state: only isOpen is client-side state
 */

import type { TaskPlanEntry } from "../stores/build-dashboard-types.ts";
import Badge from "./Badge.svelte";

interface TaskPlanCardProps {
  plan: TaskPlanEntry;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { plan }: TaskPlanCardProps = $props();
let isOpen = $state(false);

function toggle() {
  isOpen = !isOpen;
}
</script>

<div class="task-card">
  <!-- Collapsed header: always visible -->
  <button class="card-header" onclick={toggle} aria-expanded={isOpen}>
    <div class="header-left">
      <span class="task-id">{plan.task_id}</span>
      <Badge text="wave {plan.wave}" color="var(--accent, #6c8cff)" bg="var(--accent-soft, rgba(108,140,255,0.12))" />
      <span class="task-title">{plan.title}</span>
    </div>
    <div class="header-right">
      <span class="file-count">{plan.files.length} file{plan.files.length === 1 ? "" : "s"}</span>
      <span class="chevron" class:open={isOpen}>&#8250;</span>
    </div>
  </button>

  <!-- Expanded body: body text, files, principles -->
  {#if isOpen}
    <div class="card-body">
      {#if plan.body}
        <pre class="plan-body">{plan.body}</pre>
      {/if}

      {#if plan.files.length > 0}
        <div class="files-section">
          <span class="section-label">Files</span>
          <ul class="files-list">
            {#each plan.files as file (file)}
              <li class="file-item">{file}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if plan.principles.length > 0}
        <div class="principles-section">
          <span class="section-label">Principles</span>
          <div class="principles-badges">
            {#each plan.principles as principle (principle)}
              <Badge text={principle} color="var(--text-muted, #636a80)" bg="var(--bg-surface, rgba(255,255,255,0.03))" />
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .task-card {
    border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    border-radius: var(--radius-sm, 8px);
    overflow: hidden;
    margin-bottom: 6px;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-surface, rgba(255, 255, 255, 0.03));
    border: none;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    color: var(--text-bright, #e8eaf0);
    transition: background 0.15s;
    gap: 8px;
  }

  .card-header:hover {
    background: var(--bg-card, rgba(255, 255, 255, 0.06));
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }

  .task-id {
    font-size: 11px;
    font-family: ui-monospace, monospace;
    color: var(--text-muted, #636a80);
    flex-shrink: 0;
  }

  .task-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-bright, #e8eaf0);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .file-count {
    font-size: 10px;
    color: var(--text-muted, #636a80);
  }

  .chevron {
    font-size: 16px;
    color: var(--text-muted, #636a80);
    transition: transform 0.2s;
    transform: rotate(90deg);
    display: inline-block;
    line-height: 1;
  }

  .chevron.open {
    transform: rotate(-90deg);
  }

  .card-body {
    padding: 12px;
    border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .plan-body {
    font-size: 11px;
    color: var(--text, #b4b8c8);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    margin: 0;
  }

  .files-section,
  .principles-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted, #636a80);
  }

  .files-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .file-item {
    font-size: 10px;
    font-family: ui-monospace, monospace;
    color: var(--text, #b4b8c8);
    padding-left: 10px;
    position: relative;
  }

  .file-item::before {
    content: "•";
    position: absolute;
    left: 0;
    color: var(--text-muted, #636a80);
  }

  .principles-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
</style>
