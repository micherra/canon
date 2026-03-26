<script lang="ts">
  /**
   * FixBeforeMerge.svelte
   *
   * Numbered list of rule-level violations that must be addressed before merge.
   * Filters the incoming violations array to severity === "rule" only.
   * Pure presentation — no data fetching, no store access.
   *
   * Canon principles:
   *   - functions-do-one-thing: renders rule-violation list only
   *   - compose-from-small-to-large: standalone leaf; composed by PrReview.svelte
   */

  import { getSeverityColor } from "../lib/utils";

  interface Violation {
    file_path?: string;
    principle_id: string;
    severity: string;
    message?: string;
  }

  interface FixBeforeMergeProps {
    violations: Violation[];
  }

  let { violations }: FixBeforeMergeProps = $props();

  const ruleViolations = $derived(violations.filter((v) => v.severity === "rule"));

  const badgeColor = getSeverityColor("rule");
</script>

<section class="fix-before-merge">
  <h2 class="section-title">Fix Before Merge</h2>

  {#if ruleViolations.length === 0}
    <p class="empty">No blocking violations — safe to merge.</p>
  {:else}
    <ol class="violation-list">
      {#each ruleViolations as violation, i (i)}
        <li class="violation-item">
          <span class="item-number">{i + 1}</span>
          <div class="item-body">
            {#if violation.file_path}
              <span class="file-path">{violation.file_path}</span>
            {/if}
            <span
              class="principle-badge"
              style="background: {badgeColor}22; color: {badgeColor}; border-color: {badgeColor}44;"
            >
              {violation.principle_id}
            </span>
            {#if violation.message}
              <span class="message">{violation.message}</span>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .fix-before-merge {
    padding: 12px 16px;
  }

  .section-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--text, #e0e0e0);
    margin: 0 0 10px 0;
    letter-spacing: 0.02em;
  }

  .empty {
    font-size: 12px;
    color: var(--text-muted, #888);
    margin: 0;
    padding: 8px 0;
  }

  .violation-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .violation-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    background: var(--bg-card, rgba(255, 255, 255, 0.04));
    border-radius: 6px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.07));
  }

  .item-number {
    font-size: 11px;
    font-weight: 700;
    color: var(--danger, #e74c3c);
    min-width: 16px;
    flex-shrink: 0;
    padding-top: 1px;
  }

  .item-body {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .file-path {
    font-size: 11px;
    font-family: var(--font-mono, monospace);
    color: var(--text, #e0e0e0);
    word-break: break-all;
    flex-basis: 100%;
  }

  .principle-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid transparent;
    white-space: nowrap;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .message {
    font-size: 12px;
    color: var(--text-muted, #888);
    flex: 1;
    min-width: 0;
    line-height: 1.4;
  }
</style>
