<script lang="ts">
  import { graphData, violationCount, cycleCount, orphanCount, summaryProgress } from "../stores/graphData";

  interface Props {
    onStatClick: (type: string) => void;
  }

  let { onStatClick }: Props = $props();

  let healthScore = $derived.by(() => {
    const data = $graphData;
    if (!data) return 0;
    const ov = (data.insights || {}).overview || {};
    const totalFiles = ov.total_files || data.nodes.length;
    return Math.max(0, Math.min(100, Math.round(100 * (1 - ($violationCount + $cycleCount * 5) / Math.max(totalFiles, 1)))));
  });

  function getHealthColor(score: number) {
    if (score > 80) return "var(--success)";
    if (score >= 60) return "var(--warning)";
    return "var(--danger)";
  }

  let hColor = $derived(getHealthColor(healthScore));
</script>

<div class="health-strip">
  <div class="health-score">
    <span class="health-score-num" style="color:{hColor}">{healthScore}</span>
    <span class="health-score-label">health</span>
  </div>
  <div class="health-bar-track">
    <div class="health-bar-fill" style="width:{healthScore}%;background:{hColor}"></div>
  </div>
  <div class="health-stats">
    <button class="health-stat" onclick={() => onStatClick("violations")} title="Principle violations">
      <span class="health-stat-val" style="color:{$violationCount > 0 ? 'var(--danger)' : 'var(--success)'}">{$violationCount}</span>
      <span class="health-stat-label">violations</span>
    </button>
    <button class="health-stat" onclick={() => onStatClick("cycles")} title="Circular dependencies">
      <span class="health-stat-val" style="color:{$cycleCount > 0 ? 'var(--warning)' : 'var(--success)'}">{$cycleCount}</span>
      <span class="health-stat-label">cycles</span>
    </button>
    <button class="health-stat" onclick={() => onStatClick("orphans")} title="Unused files">
      <span class="health-stat-val" style="color:{$orphanCount > 0 ? 'var(--warning)' : 'var(--success)'}">{$orphanCount}</span>
      <span class="health-stat-label">orphans</span>
    </button>
  </div>
</div>

{#if $summaryProgress && $summaryProgress.completed < $summaryProgress.total}
  <div class="summary-progress">
    <div class="summary-progress-bar">
      <div class="summary-progress-fill" style="width:{Math.round(($summaryProgress.completed / $summaryProgress.total) * 100)}%"></div>
    </div>
    <span class="summary-progress-text">Generating summaries {$summaryProgress.completed}/{$summaryProgress.total}</span>
  </div>
{/if}

<style>
  .health-strip {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .health-score { display: flex; align-items: baseline; gap: 4px; white-space: nowrap; }
  .health-score-num { font-size: 22px; font-weight: 800; line-height: 1; }
  .health-score-label { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .health-bar-track { flex: 1; height: 6px; background: var(--bg-card); border-radius: 3px; overflow: hidden; }
  .health-bar-fill { height: 100%; border-radius: 3px; transition: width 0.6s ease; }
  .health-stats { display: flex; gap: 2px; flex-shrink: 0; }
  .health-stat {
    display: flex; align-items: center; gap: 4px;
    cursor: pointer; padding: 3px 8px; border-radius: var(--radius-sm);
    font-size: 11px; font-weight: 600; transition: background 0.15s; white-space: nowrap;
    background: none; border: none; font-family: inherit; color: inherit;
  }
  .health-stat:hover { background: var(--bg-card); }
  .health-stat-val { font-weight: 700; }
  .health-stat-label { color: var(--text-muted); font-weight: 500; }
  .summary-progress {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 16px 6px; border-bottom: 1px solid var(--border);
  }
  .summary-progress-bar { flex: 1; height: 3px; background: var(--bg-card); border-radius: 2px; overflow: hidden; }
  .summary-progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.4s ease; }
  .summary-progress-text { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
</style>
