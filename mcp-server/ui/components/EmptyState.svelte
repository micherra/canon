<script lang="ts">
  /**
   * EmptyState.svelte
   *
   * A simple empty/error state display. Renders a centred message using
   * the global `.empty-state` class defined in base.css. The optional
   * `isError` prop adds the `.error` modifier class for danger colouring.
   *
   * Canon principles:
   *   - compose-from-small-to-large: atom component, composed into any view
   *   - props-are-the-component-contract: no bridge access, no global state
   */

  interface EmptyStateProps {
    message: string;
    isError?: boolean;
  }

  let { message, isError = false }: EmptyStateProps = $props();
</script>

<div class="empty-state" class:error={isError}>{message}</div>
