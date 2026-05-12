<script lang="ts">
/**
 * AssumptionRow.svelte
 *
 * Renders a single planner assumption with an annotation affordance.
 * Shows existing annotation preview inline when present.
 *
 * Canon principles:
 *   - compose-from-small-to-large: composes AnnotationPopover; no direct DOM concerns
 *   - props-are-the-component-contract: all data and callbacks via typed props
 *   - functions-do-one-thing: renders one assumption row; annotation logic in AnnotationPopover
 */

import type { Assumption } from "../stores/planning-brief-types.ts";
import type { Annotation } from "../stores/bridge-types.ts";
import AnnotationPopover from "./AnnotationPopover.svelte";

interface AssumptionRowProps {
  assumption: Assumption;
  annotation?: Annotation;
  onAnnotate: (annotation: Annotation) => void;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { assumption, annotation, onAnnotate }: AssumptionRowProps = $props();
</script>

<div class="assumption-row">
  <span class="assumption-index">{assumption.index + 1}.</span>
  <span class="assumption-text">{assumption.text}</span>
  <div class="annotation-area">
    <AnnotationPopover
      section="assumptions"
      itemIndex={assumption.index}
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
  .assumption-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.04));
    flex-wrap: wrap;
  }

  .assumption-row:last-child {
    border-bottom: none;
  }

  .assumption-index {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    flex-shrink: 0;
    padding-top: 2px;
    min-width: 18px;
  }

  .assumption-text {
    flex: 1;
    font-size: 12px;
    color: var(--text, #b4b8c8);
    line-height: 1.5;
    min-width: 0;
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
