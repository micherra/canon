<script lang="ts">
  /**
   * ComplianceScore.svelte
   *
   * Renders compliance scores as horizontal progress bars with honored principle badges.
   * Pure presentation — receives all data via props, no data fetching.
   *
   * Canon principles:
   *   - functions-do-one-thing: renders compliance score section only
   *   - compose-from-small-to-large: used as a leaf panel by PrReview.svelte
   */

  import { SEVERITY_COLORS } from "../lib/constants";

  interface ScoreGroup {
    passed: number;
    total: number;
  }

  interface ComplianceScoreProps {
    score: {
      rules: ScoreGroup;
      opinions: ScoreGroup;
      conventions: ScoreGroup;
    };
    honoredPrinciples: string[];
  }

  let { score, honoredPrinciples }: ComplianceScoreProps = $props();

  const hasData = $derived(
    score.rules.total > 0 || score.opinions.total > 0 || score.conventions.total > 0,
  );

  function barWidth(passed: number, total: number): string {
    if (total === 0) return "0%";
    return `${Math.round((passed / total) * 100)}%`;
  }

  function barColor(passed: number, total: number, baseColor: string): string {
    return passed === total ? "var(--success, #52b052)" : baseColor;
  }
</script>

<div class="compliance-score">
  <div class="section-title">Compliance Score</div>

  {#if !hasData}
    <div class="empty">No compliance data</div>
  {:else}
    <div class="bars">
      <!-- Rules bar -->
      <div class="bar-row">
        <span class="bar-label">Rules</span>
        <span class="bar-count">{score.rules.passed}/{score.rules.total}</span>
        <div class="bar-track">
          <div
            class="bar-fill"
            style:width={barWidth(score.rules.passed, score.rules.total)}
            style:background={barColor(score.rules.passed, score.rules.total, SEVERITY_COLORS.rule)}
          ></div>
        </div>
      </div>

      <!-- Opinions bar -->
      <div class="bar-row">
        <span class="bar-label">Opinions</span>
        <span class="bar-count">{score.opinions.passed}/{score.opinions.total}</span>
        <div class="bar-track">
          <div
            class="bar-fill"
            style:width={barWidth(score.opinions.passed, score.opinions.total)}
            style:background={barColor(
              score.opinions.passed,
              score.opinions.total,
              SEVERITY_COLORS["strong-opinion"],
            )}
          ></div>
        </div>
      </div>

      <!-- Conventions bar -->
      <div class="bar-row">
        <span class="bar-label">Conventions</span>
        <span class="bar-count">{score.conventions.passed}/{score.conventions.total}</span>
        <div class="bar-track">
          <div
            class="bar-fill"
            style:width={barWidth(score.conventions.passed, score.conventions.total)}
            style:background={barColor(
              score.conventions.passed,
              score.conventions.total,
              SEVERITY_COLORS.convention,
            )}
          ></div>
        </div>
      </div>
    </div>

    {#if honoredPrinciples.length > 0}
      <div class="honored-section">
        <span class="honored-label">Honored Principles</span>
        <div class="honored-badges">
          {#each honoredPrinciples as principle (principle)}
            <span class="honored-badge">&#10003; {principle}</span>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .compliance-score {
    padding: 12px 16px;
    background: var(--bg-card, rgba(255, 255, 255, 0.04));
    border-radius: 6px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  }

  .section-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted, #888);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 12px;
  }

  .empty {
    font-size: 12px;
    color: var(--text-muted, #888);
    text-align: center;
    padding: 8px 0;
  }

  .bars {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .bar-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .bar-label {
    width: 80px;
    flex-shrink: 0;
    color: var(--text, #e0e0e0);
  }

  .bar-count {
    width: 36px;
    flex-shrink: 0;
    color: var(--text-muted, #888);
    font-size: 11px;
    text-align: right;
  }

  .bar-track {
    flex: 1;
    height: 8px;
    background: var(--bg-alt, rgba(255, 255, 255, 0.08));
    border-radius: 4px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .honored-section {
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .honored-label {
    font-size: 11px;
    color: var(--text-muted, #888);
    font-weight: 600;
  }

  .honored-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .honored-badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--success, #52b052) 18%, transparent);
    color: var(--success, #52b052);
    border: 1px solid color-mix(in srgb, var(--success, #52b052) 35%, transparent);
    white-space: nowrap;
    letter-spacing: 0.02em;
  }
</style>
