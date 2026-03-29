<script lang="ts">
  /**
   * ViolationCard.svelte
   *
   * A card showing a single principle violation for a file. Renders:
   *   - File path with filename portion bold
   *   - Severity pill using SEVERITY_COLORS from constants.ts
   *   - Principle ID in bold
   *   - Description text (fallback to "Principle violation" if absent)
   *   - Click handler calling onPrompt with a contextual explanation prompt
   *
   * Canon principles:
   *   - compose-from-small-to-large: atom component, composed into the violations section
   *   - props-are-the-component-contract: no bridge access, no global state
   */

  import FilePath from "./FilePath.svelte";
  import { getSeverityColor } from "../lib/utils";

  interface ViolationCardProps {
    filePath: string;
    principleId: string;
    severity: "rule" | "strong-opinion" | "convention";
    description?: string;
    onPrompt: (text: string) => void;
  }

  let { filePath, principleId, severity, description, onPrompt }: ViolationCardProps = $props();

  /** Color for the severity pill */
  let severityColor = $derived(getSeverityColor(severity));

  /** Human-readable severity label */
  let severityLabel = $derived(
    severity === "rule" ? "Rule"
    : severity === "strong-opinion" ? "Opinion"
    : "Convention"
  );

  /** Fallback description */
  let displayDescription = $derived(description ?? "Principle violation");

  function handleClick() {
    onPrompt(`Explain the ${principleId} violation in ${filePath} and how to fix it`);
  }
</script>

<button class="violation-card btn-reset" onclick={handleClick} title={filePath}>
  <!-- File path: directory prefix muted, filename bold -->
  <div class="card-header">
    <FilePath path={filePath} />

    <!-- Severity pill -->
    <span
      class="severity-pill"
      style="background: {severityColor}22; color: {severityColor}; border-color: {severityColor}44;"
    >
      {severityLabel}
    </span>
  </div>

  <!-- Principle and description -->
  <div class="card-body">
    <span class="principle-id">{principleId}</span>
    <span class="description">{displayDescription}</span>
  </div>
</button>

<style>
  .violation-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    background: var(--bg-card, rgba(255,255,255,0.04));
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    transition: background 0.12s;
  }

  .violation-card:hover {
    background: var(--bg-card-hover, rgba(255,255,255,0.09));
  }

  /* ── Card header: file path + severity pill ─────────────────────────── */

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: space-between;
  }

  .severity-pill {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    border: 1px solid transparent;
    font-weight: 600;
    flex-shrink: 0;
    white-space: nowrap;
    letter-spacing: 0.03em;
  }

  /* ── Card body: principle ID + description ──────────────────────────── */

  .card-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 0;
  }

  .principle-id {
    font-size: 12px;
    font-weight: 700;
    color: var(--text, #b4b8c8);
    font-family: monospace;
  }

  .description {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    line-height: 1.4;
  }
</style>
