<script lang="ts">
/**
 * AnnotationPopover.svelte
 *
 * Inline annotation input that appears on click of the pencil icon.
 * Submits a typed Annotation to the parent via onAnnotate callback.
 *
 * Canon principles:
 *   - compose-from-small-to-large: atom component; composed into AssumptionRow / CriterionRow
 *   - props-are-the-component-contract: all state passed via typed props; no global state
 *   - functions-do-one-thing: handles only annotation input and submission
 */

import type { Annotation } from "../stores/bridge-types.ts";

interface AnnotationPopoverProps {
  /** Section identifier (e.g., "assumptions", "criteria"). */
  section: string;
  /** Zero-based index of the item in the section. */
  itemIndex: number;
  /** Called when the user submits an annotation. */
  onAnnotate: (annotation: Annotation) => void;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { section, itemIndex, onAnnotate }: AnnotationPopoverProps = $props();

let isOpen = $state(false);
let text = $state("");

function open() {
  isOpen = true;
}

function cancel() {
  isOpen = false;
  text = "";
}

function submit() {
  if (!text.trim()) return;
  onAnnotate({
    section,
    itemIndex,
    text: text.trim(),
    timestamp: new Date().toISOString(),
  });
  isOpen = false;
  text = "";
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") cancel();
}
</script>

<div class="popover-container">
  <button class="pencil-btn" onclick={open} title="Add annotation" aria-label="Add annotation">
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M8.5 1.5L10.5 3.5L3.5 10.5H1.5V8.5L8.5 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>

  {#if isOpen}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="popover" role="dialog" aria-label="Add annotation" onkeydown={handleKeydown}>
      <textarea
        class="popover-textarea"
        placeholder="Add annotation..."
        bind:value={text}
        rows={3}
        autofocus
      ></textarea>
      <div class="popover-actions">
        <button class="btn-cancel" onclick={cancel}>Cancel</button>
        <button class="btn-submit" onclick={submit} disabled={!text.trim()}>Save</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .popover-container {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }

  .pencil-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: none;
    background: transparent;
    color: var(--text-muted, #636a80);
    cursor: pointer;
    border-radius: 3px;
    padding: 0;
    transition: color 0.15s, background 0.15s;
  }

  .pencil-btn:hover {
    color: var(--accent, #6c8cff);
    background: var(--accent-soft, rgba(108, 140, 255, 0.12));
  }

  .popover {
    position: absolute;
    top: 24px;
    left: 0;
    z-index: 100;
    background: var(--bg, #0c0f1a);
    border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
    border-radius: var(--radius-sm, 8px);
    padding: 10px;
    width: 240px;
    box-shadow: var(--shadow-lg, 0 4px 24px rgba(0, 0, 0, 0.4));
  }

  .popover-textarea {
    width: 100%;
    background: var(--bg-surface, rgba(255, 255, 255, 0.03));
    border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    border-radius: 4px;
    color: var(--text, #b4b8c8);
    font-family: inherit;
    font-size: 12px;
    padding: 6px 8px;
    resize: none;
    outline: none;
    line-height: 1.5;
  }

  .popover-textarea:focus {
    border-color: var(--accent, #6c8cff);
  }

  .popover-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    justify-content: flex-end;
  }

  .btn-cancel,
  .btn-submit {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s;
  }

  .btn-cancel {
    background: transparent;
    border-color: var(--border, rgba(255, 255, 255, 0.12));
    color: var(--text-muted, #636a80);
  }

  .btn-cancel:hover {
    background: var(--bg-card, rgba(255, 255, 255, 0.06));
  }

  .btn-submit {
    background: var(--accent-soft, rgba(108, 140, 255, 0.12));
    border-color: var(--accent, #6c8cff);
    color: var(--accent, #6c8cff);
  }

  .btn-submit:hover:not(:disabled) {
    background: var(--accent-glow, rgba(108, 140, 255, 0.25));
  }

  .btn-submit:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
