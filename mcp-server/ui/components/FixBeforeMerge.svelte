<script lang="ts">
  /**
   * FixBeforeMerge.svelte
   *
   * Shows up to 5 prioritized suggestions. When recommendations are provided,
   * displays them. Falls back to sorted violations (rule > strong-opinion >
   * convention, limited to 5) when recommendations is empty or undefined.
   * Pure presentation — no data fetching, no store access.
   *
   * Canon principles:
   *   - functions-do-one-thing: renders prioritized suggestion list only
   *   - compose-from-small-to-large: standalone leaf; composed by PrReview.svelte
   */

  import { getSeverityColor } from "../lib/utils";

  interface Violation {
    file_path?: string;
    principle_id: string;
    severity: string;
    message?: string;
  }

  interface Recommendation {
    file_path?: string;
    title: string;
    message: string;
    source: "principle" | "holistic";
  }

  interface FixBeforeMergeProps {
    violations: Violation[];
    recommendations?: Recommendation[];
    onPrompt?: (text: string) => void;
  }

  let { violations, recommendations, onPrompt }: FixBeforeMergeProps = $props();

  // Color for holistic recommendations
  const HOLISTIC_COLOR = "#6c8cff";

  const SEVERITY_ORDER: Record<string, number> = { rule: 0, "strong-opinion": 1, convention: 2 };

  // Normalize: if recommendations provided and non-empty, use them.
  // Otherwise fall back to sorted violations.
  const items = $derived((): Array<{ type: "recommendation"; rec: Recommendation } | { type: "violation"; v: Violation }> => {
    if (recommendations && recommendations.length > 0) {
      return recommendations.slice(0, 5).map((rec) => ({ type: "recommendation" as const, rec }));
    }
    const sorted = [...violations]
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
      .slice(0, 5);
    return sorted.map((v) => ({ type: "violation" as const, v }));
  });

  const totalCount = $derived(
    recommendations && recommendations.length > 0 ? recommendations.length : violations.length
  );

  function getRecommendationColor(source: "principle" | "holistic"): string {
    return source === "principle" ? getSeverityColor("rule") : HOLISTIC_COLOR;
  }

  function getPromptText(item: { type: "recommendation"; rec: Recommendation } | { type: "violation"; v: Violation }): string {
    if (item.type === "recommendation") {
      return `Explain this recommendation: ${item.rec.title}${item.rec.file_path ? ` in ${item.rec.file_path}` : ""} and how to address it`;
    }
    return `Explain the ${item.v.principle_id} violation in ${item.v.file_path ?? "this file"} and how to fix it`;
  }
</script>

<section class="fix-before-merge">
  <h2 class="section-title">Fix Before Merge</h2>

  {#if items().length === 0}
    <p class="empty">No violations — looking good.</p>
  {:else}
    <ol class="violation-list">
      {#each items() as item, i (i)}
        {@const color = item.type === "recommendation"
          ? getRecommendationColor(item.rec.source)
          : getSeverityColor(item.v.severity)}
        <li class="violation-item">
          {#if onPrompt}
            <button
              class="violation-btn btn-reset"
              onclick={() => onPrompt(getPromptText(item))}
            >
              <span class="item-number" style="color: {color}">{i + 1}</span>
              <div class="item-body">
                {#if item.type === "recommendation"}
                  {#if item.rec.file_path}
                    <span class="file-path">{item.rec.file_path}</span>
                  {/if}
                  <div class="badge-message-row">
                    <span class="principle-badge" style="color: {color};">{item.rec.title}</span>
                    <span class="message">{item.rec.message}</span>
                  </div>
                {:else}
                  {#if item.v.file_path}
                    <span class="file-path">{item.v.file_path}</span>
                  {/if}
                  <div class="badge-message-row">
                    <span class="principle-badge" style="color: {color};">{item.v.principle_id}</span>
                    {#if item.v.message}
                      <span class="message">{item.v.message}</span>
                    {/if}
                  </div>
                {/if}
              </div>
            </button>
          {:else}
            <span class="item-number" style="color: {color}">{i + 1}</span>
            <div class="item-body">
              {#if item.type === "recommendation"}
                {#if item.rec.file_path}
                  <span class="file-path">{item.rec.file_path}</span>
                {/if}
                <div class="badge-message-row">
                  <span class="principle-badge" style="color: {color};">{item.rec.title}</span>
                  <span class="message">{item.rec.message}</span>
                </div>
              {:else}
                {#if item.v.file_path}
                  <span class="file-path">{item.v.file_path}</span>
                {/if}
                <div class="badge-message-row">
                  <span class="principle-badge" style="color: {color};">{item.v.principle_id}</span>
                  {#if item.v.message}
                    <span class="message">{item.v.message}</span>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
    {#if totalCount > 5}
      <p class="overflow-note">Showing top 5 of {totalCount} suggestions</p>
    {/if}
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

  .violation-btn {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 0;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
    transition: background 0.1s;
  }

  .violation-btn:hover {
    background: var(--bg-hover, rgba(255, 255, 255, 0.08));
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
    flex-direction: column;
    gap: 4px;
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

  .badge-message-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }

  .principle-badge {
    font-size: 9px;
    font-weight: 600;
    white-space: nowrap;
    letter-spacing: 0.02em;
    opacity: 0.85;
  }

  .message {
    font-size: 12px;
    color: var(--text-muted, #888);
    line-height: 1.4;
  }

  .overflow-note {
    font-size: 11px;
    color: var(--text-muted, #888);
    margin: 6px 0 0;
    text-align: center;
  }
</style>
