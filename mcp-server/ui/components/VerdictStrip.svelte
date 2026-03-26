<script lang="ts">
  /**
   * VerdictStrip.svelte
   *
   * A fixed-height horizontal banner showing the PR review verdict with key stats.
   * Pure presentation — receives all data via props, no data fetching.
   *
   * Canon principles:
   *   - functions-do-one-thing: renders verdict banner only
   *   - compose-from-small-to-large: used as an atom by PrReview.svelte
   */

  interface VerdictStripProps {
    verdict: "BLOCKING" | "WARNING" | "CLEAN";
    fileCount: number;
    blastRadiusTotal: number;
    violationCount: number;
    score: {
      rules: { passed: number; total: number };
      opinions: { passed: number; total: number };
      conventions: { passed: number; total: number };
    };
  }

  let { verdict, fileCount, blastRadiusTotal, violationCount, score }: VerdictStripProps = $props();

  const verdictClass = $derived(
    verdict === "BLOCKING" ? "verdict-blocking"
    : verdict === "WARNING" ? "verdict-warning"
    : "verdict-clean"
  );
</script>

<div class="verdict-strip {verdictClass}" data-verdict={verdict}>
  <div class="verdict-badge">{verdict}</div>
  <div class="headline">
    {fileCount} {fileCount === 1 ? "file" : "files"} changed
    &nbsp;&bull;&nbsp;
    blast radius {blastRadiusTotal}
    &nbsp;&bull;&nbsp;
    {violationCount} {violationCount === 1 ? "violation" : "violations"}
  </div>
  <div class="score-pills">
    <span class="pill" class:pill-pass={score.rules.passed === score.rules.total}>
      Rules: {score.rules.passed}/{score.rules.total}
    </span>
    <span class="pill" class:pill-pass={score.opinions.passed === score.opinions.total}>
      Opinions: {score.opinions.passed}/{score.opinions.total}
    </span>
    <span class="pill" class:pill-pass={score.conventions.passed === score.conventions.total}>
      Conventions: {score.conventions.passed}/{score.conventions.total}
    </span>
  </div>
</div>

<style>
  .verdict-strip {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    height: 48px;
    flex-shrink: 0;
    font-size: 13px;
    border-bottom: 1px solid var(--border, #333);
  }

  /* Verdict color themes — low-opacity bg with solid accent text */
  .verdict-blocking {
    background: color-mix(in srgb, var(--danger, #e05252) 15%, transparent);
    border-bottom-color: var(--danger, #e05252);
  }
  .verdict-warning {
    background: color-mix(in srgb, var(--warning, #e0a752) 15%, transparent);
    border-bottom-color: var(--warning, #e0a752);
  }
  .verdict-clean {
    background: color-mix(in srgb, var(--success, #52b052) 15%, transparent);
    border-bottom-color: var(--success, #52b052);
  }

  .verdict-badge {
    font-weight: 700;
    font-size: 12px;
    letter-spacing: 0.05em;
    padding: 2px 8px;
    border-radius: 4px;
    white-space: nowrap;
  }

  .verdict-blocking .verdict-badge {
    background: var(--danger, #e05252);
    color: #fff;
  }
  .verdict-warning .verdict-badge {
    background: var(--warning, #e0a752);
    color: #000;
  }
  .verdict-clean .verdict-badge {
    background: var(--success, #52b052);
    color: #fff;
  }

  .headline {
    color: var(--text, #e0e0e0);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .score-pills {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .pill {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 10px;
    background: var(--bg-alt, #2a2a2a);
    color: var(--text-muted, #888);
    white-space: nowrap;
  }

  .pill-pass {
    color: var(--success, #52b052);
  }
</style>
