<script lang="ts">
/**
 * ActionBar.svelte
 *
 * Bottom-fixed action bar for the planning brief approval workflow.
 * Provides Approve and Request Changes buttons. Request Changes reveals
 * a feedback textarea before calling onRequestChanges.
 *
 * Canon principles:
 *   - compose-from-small-to-large: atom component; composed into PlanningBrief
 *   - props-are-the-component-contract: onApprove / onRequestChanges / annotationCount via props
 *   - functions-do-one-thing: handles decision UI only; no data loading
 */

interface ActionBarProps {
  /** Called when the user clicks Approve. */
  onApprove: () => void;
  /** Called when the user submits the request-changes form with their feedback text. */
  onRequestChanges: (feedback: string) => void;
  /** Number of annotations added so far. Displayed as an indicator. */
  annotationCount: number;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { onApprove, onRequestChanges, annotationCount }: ActionBarProps = $props();

let showFeedback = $state(false);
let feedback = $state("");

function handleApprove() {
  onApprove();
}

function startRequestChanges() {
  showFeedback = true;
}

function cancelFeedback() {
  showFeedback = false;
  feedback = "";
}

function submitFeedback() {
  onRequestChanges(feedback);
  showFeedback = false;
  feedback = "";
}
</script>

<div class="action-bar">
  {#if showFeedback}
    <!-- Expanded feedback form -->
    <div class="feedback-form">
      <textarea
        class="feedback-textarea"
        placeholder="Describe what needs to change..."
        bind:value={feedback}
        rows={3}
        autofocus
      ></textarea>
      <div class="feedback-actions">
        <button class="btn-cancel" onclick={cancelFeedback}>Cancel</button>
        <button
          class="btn-request-changes btn-request-changes--submit"
          onclick={submitFeedback}
          disabled={!feedback.trim()}
        >
          Submit Request
        </button>
      </div>
    </div>
  {:else}
    <!-- Collapsed bar -->
    <div class="bar-row">
      {#if annotationCount > 0}
        <span class="annotation-count">
          {annotationCount} annotation{annotationCount === 1 ? "" : "s"}
        </span>
      {/if}
      <div class="bar-actions">
        <button class="btn-request-changes" onclick={startRequestChanges}>
          Request Changes
        </button>
        <button class="btn-approve" onclick={handleApprove}>
          Approve
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .action-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--bg, #0c0f1a);
    border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    z-index: 50;
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.4);
  }

  .bar-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 10px 16px;
  }

  .annotation-count {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    margin-right: auto;
  }

  .bar-actions {
    display: flex;
    gap: 8px;
  }

  .btn-approve,
  .btn-request-changes {
    font-size: 12px;
    font-weight: 600;
    padding: 6px 16px;
    border-radius: 6px;
    border: 1px solid;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, opacity 0.15s;
  }

  .btn-approve {
    background: var(--success, #34d399);
    border-color: var(--success, #34d399);
    color: #0c0f1a;
  }

  .btn-approve:hover {
    background: #2dbd8a;
    border-color: #2dbd8a;
  }

  .btn-request-changes {
    background: transparent;
    border-color: var(--danger, #ff6b6b);
    color: var(--danger, #ff6b6b);
  }

  .btn-request-changes:hover {
    background: rgba(255, 107, 107, 0.1);
  }

  .btn-request-changes--submit {
    background: rgba(255, 107, 107, 0.12);
  }

  .btn-request-changes--submit:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Feedback form */

  .feedback-form {
    padding: 10px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .feedback-textarea {
    width: 100%;
    background: var(--bg-surface, rgba(255, 255, 255, 0.03));
    border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
    border-radius: 6px;
    color: var(--text, #b4b8c8);
    font-family: inherit;
    font-size: 12px;
    padding: 8px 10px;
    resize: vertical;
    outline: none;
    line-height: 1.5;
  }

  .feedback-textarea:focus {
    border-color: var(--accent, #6c8cff);
  }

  .feedback-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .btn-cancel {
    font-size: 12px;
    padding: 5px 14px;
    border-radius: 5px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
    background: transparent;
    color: var(--text-muted, #636a80);
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s;
  }

  .btn-cancel:hover {
    background: var(--bg-card, rgba(255, 255, 255, 0.06));
  }
</style>
