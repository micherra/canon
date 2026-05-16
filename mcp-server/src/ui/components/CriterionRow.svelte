<script lang="ts">
/**
 * CriterionRow.svelte
 *
 * Renders a single acceptance criterion with a checkbox status indicator
 * and an annotation affordance.
 *
 * Canon principles:
 *   - compose-from-small-to-large: composes AnnotationPopover
 *   - props-are-the-component-contract: all data and callbacks via typed props
 *   - functions-do-one-thing: renders one criterion row; annotation logic in AnnotationPopover
 */

import type { AcceptanceCriterion } from "../stores/planning-brief-types.ts";
import type { Annotation } from "../stores/bridge-types.ts";
import AnnotationPopover from "./AnnotationPopover.svelte";

interface CriterionRowProps {
  criterion: AcceptanceCriterion;
  annotation?: Annotation;
  onAnnotate: (annotation: Annotation) => void;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { criterion, annotation, onAnnotate }: CriterionRowProps = $props();
</script>

<div class="criterion-row">
  <span class="criterion-check" class:checked={criterion.checked} aria-label={criterion.checked ? "Checked" : "Unchecked"}>
    {#if criterion.checked}
      &#10003;
    {:else}
      &#9711;
    {/if}
  </span>
  <span class="criterion-text" class:checked={criterion.checked}>{criterion.text}</span>
  <div class="annotation-area">
    <AnnotationPopover
      section="criteria"
      itemIndex={criterion.index}
      {onAnnotate}
    />
  </div>
  {#if annotation}
    <div class="annotation-preview" title={annotation.text}>
      <span class="annotation-icon" aria-hidden="true">&#9998;</span>
      <span class="annotation-text">{annotation.text}</span>
    </div>
  {/if}
</div>

<style>
  .criterion-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.04));
    flex-wrap: wrap;
  }

  .criterion-row:last-child {
    border-bottom: none;
  }

  .criterion-check {
    font-size: 13px;
    flex-shrink: 0;
    padding-top: 1px;
    color: var(--text-muted, #636a80);
    width: 16px;
    text-align: center;
  }

  .criterion-check.checked {
    color: var(--success, #34d399);
  }

  .criterion-text {
    flex: 1;
    font-size: 12px;
    color: var(--text, #b4b8c8);
    line-height: 1.5;
    min-width: 0;
  }

  .criterion-text.checked {
    color: var(--text-muted, #636a80);
    text-decoration: line-through;
    text-decoration-color: var(--text-muted, #636a80);
  }

  .annotation-area {
    flex-shrink: 0;
    padding-top: 1px;
  }

  .annotation-preview {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    width: 100%;
    margin-top: 4px;
    padding: 4px 8px;
    background: var(--accent-soft, rgba(108, 140, 255, 0.08));
    border-radius: 3px;
    border-left: 2px solid var(--accent, #6c8cff);
  }

  .annotation-icon {
    font-size: 10px;
    color: var(--accent, #6c8cff);
    flex-shrink: 0;
    margin-top: 1px;
  }

  .annotation-text {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    line-height: 1.4;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
</style>
