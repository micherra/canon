<script lang="ts">
  import InsightSection from "./InsightSection.svelte";
  import { graphData, edgeIn, violationCount as violationCountStore, principles } from "../stores/graphData";
  import { LAYER_CENTRALITY, getLayerColor, truncate, getRuleDescription } from "../lib/constants";
  import { computeCascade, basename } from "../lib/graph";
  import { escapeHtml } from "../lib/escapeHtml";
  import { tooltip } from "../lib/tooltip";

  interface Props {
    onFileClick: (fileId: string) => void;
    onHighlightCategory: (type: string) => void;
    hasActiveHighlight: boolean;
    onClearHighlight: () => void;
  }

  let { onFileClick, onHighlightCategory, hasActiveHighlight, onClearHighlight }: Props = $props();

  let data = $derived($graphData);
  let ins = $derived(data?.insights || {});
  let changedNodes = $derived((data?.nodes || []).filter((n) => n.changed));


  // Changed files with priority scoring
  let sortedChanged = $derived.by(() => {
    if (changedNodes.length === 0) return [];
    const eIn = $edgeIn;
    const cascadeCache = new Map<string, number>();
    const priorityCache = new Map<string, number>();
    for (const n of changedNodes) {
      const cascade = computeCascade(n.id, eIn);
      cascadeCache.set(n.id, cascade.reduce((sum, level) => sum + level.size, 0));
      const inDeg = (eIn.get(n.id) || []).length;
      const score = (inDeg * 3) + ((n.violation_count || 0) * 2) + 1 + (LAYER_CENTRALITY[n.layer] || 0);
      priorityCache.set(n.id, Math.round(score * 100) / 100);
    }
    const sorted = [...changedNodes].sort((a, b) => (priorityCache.get(b.id) || 0) - (priorityCache.get(a.id) || 0));
    const topQuartileThreshold = sorted.length >= 4 ? priorityCache.get(sorted[Math.floor(sorted.length / 4)].id)! : Infinity;
    return sorted.map((n) => ({
      ...n,
      deps: (eIn.get(n.id) || []).length,
      totalAffected: cascadeCache.get(n.id) || 0,
      priority: priorityCache.get(n.id) || 0,
      isHighImpact: (priorityCache.get(n.id) || 0) >= topQuartileThreshold && sorted.length >= 4,
    }));
  });

  // Violations — nodes with violation_count > 0, sorted by count
  let violationNodes = $derived.by(() => {
    if (!data?.nodes) return [];
    return data.nodes
      .filter((n: any) => (n.violation_count || 0) > 0)
      .sort((a: any, b: any) => (b.violation_count || 0) - (a.violation_count || 0))
      .slice(0, 10);
  });
  let totalViolations = $derived($violationCountStore);

  let orphans = $derived(ins.orphan_files || []);
  let mostConnected = $derived(ins.most_connected || []);
  let cycles = $derived(ins.circular_dependencies || []);

  function getNodeLayer(id: string): string {
    const node = (data?.nodes || []).find((n) => n.id === id);
    return node?.layer || "unknown";
  }
</script>

<div class="detail-panel">
  <div class="insights-label">Insights</div>

  {#if hasActiveHighlight}
    <button class="clear-highlight-btn" onclick={onClearHighlight}>Clear highlight</button>
  {/if}

  {#if sortedChanged.length > 0}
    <InsightSection title="Changed Files" count={sortedChanged.length} badgeClass="" type="changed" open={true} onHeaderClick={onHighlightCategory}>
      {#each sortedChanged as n}
        <div class="insight-item" style="border-left-color:var(--info)">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="layer-badge" style="background:{getLayerColor(n.layer)}">{n.layer}</span>
            <button class="file-link-btn" onclick={() => onFileClick(n.id)} style="font-size:12px;font-weight:600;flex:1;text-align:left">{basename(n.id)}</button>
            {#if n.isHighImpact}
              <span class="high-impact-badge">HIGH IMPACT</span>
            {/if}
            <span class="priority-badge" title="Review priority score">{n.priority}</span>
          </div>
          {#if n.summary}
            <div style="font-size:10px;color:var(--text-muted);margin:2px 0;line-height:1.4">{truncate(n.summary, 100)}</div>
          {/if}
        </div>
      {/each}
    </InsightSection>
  {/if}

  {#if totalViolations > 0}
    <InsightSection title="Violations" count={totalViolations} badgeClass="danger" type="violations" onHeaderClick={onHighlightCategory}>
      {#each violationNodes as vn}
        <div class="violation-card">
          <div class="violation-card-header">
            <span class="layer-badge" style="background:{getLayerColor(vn.layer)};margin-right:6px">{vn.layer}</span>
            <button class="file-link-btn" onclick={() => onFileClick(vn.id)} style="font-size:12px;font-weight:600">{basename(vn.id)}</button>
            <span class="violation-count-badge" style="margin-left:auto">{vn.violation_count}</span>
          </div>
          <div class="violation-card-body">
            {#if vn.top_violations?.length}
              <div style="display:flex;flex-wrap:wrap;gap:4px">
                {#each vn.top_violations as p}
                  <span class="violation-rule-chip" use:tooltip={getRuleDescription(p, $principles)}>{p}</span>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </InsightSection>
  {/if}

  {#if orphans.length > 0}
    <InsightSection title="Orphan Files" count={orphans.length} badgeClass="warn" type="orphans" onHeaderClick={onHighlightCategory}>
      {#each orphans.slice(0, 10) as f}
        <button class="file-link-btn" onclick={() => onFileClick(f)}>{basename(f)}</button>
      {/each}
    </InsightSection>
  {/if}

  {#if mostConnected.length > 0}
    <InsightSection title="Most Connected" count={mostConnected.length} badgeClass="" type="connected" onHeaderClick={onHighlightCategory}>
      {#each mostConnected.slice(0, 8) as n}
        <button class="file-link-btn" onclick={() => onFileClick(n.path)}>
          {basename(n.path)} <span class="text-muted">in:{n.in_degree} out:{n.out_degree}</span>
        </button>
      {/each}
    </InsightSection>
  {/if}

  {#if cycles.length > 0}
    <InsightSection title="Circular Dependencies" count={cycles.length} badgeClass="warn" type="cycles" onHeaderClick={onHighlightCategory}>
      {#each cycles.slice(0, 6) as c}
        <div class="insight-chain">
          {#each c as f, i}
            <button class="file-link-btn" onclick={() => onFileClick(f)}>{basename(f)}</button>{#if i < c.length - 1} → {/if}
          {/each}
        </div>
      {/each}
    </InsightSection>
  {/if}

  {#if sortedChanged.length === 0 && totalViolations === 0 && orphans.length === 0 && mostConnected.length === 0 && cycles.length === 0}
    <p class="detail-placeholder">No insights available. Click a node to see details.</p>
  {/if}
</div>

<style>
  .detail-panel { padding: 16px 20px; overflow-y: auto; flex: 1; }
  .insights-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; font-weight: 600; margin-bottom: 8px; }
  .detail-placeholder { color: var(--text-muted); font-size: 12px; }
  .file-link-btn {
    display: block; background: none; border: none; padding: 3px 0;
    font-size: 12px; cursor: pointer; color: var(--accent); font-family: inherit; text-align: left;
  }
  .file-link-btn:hover { text-decoration: underline; }
  .insight-chain { padding: 4px 0; font-size: 11px; color: var(--text); }
  .insight-chain .file-link-btn { display: inline; padding: 0; font-size: 11px; }
  .insight-item {
    padding: 8px 10px; margin-bottom: 6px;
    background: var(--bg-card); border-radius: var(--radius-sm);
    border: 1px solid var(--border); border-left: 3px solid var(--danger);
  }
  .insight-item .file-link-btn { padding: 0; }
  .violation-card {
    margin-bottom: 6px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-left: 3px solid var(--danger);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .violation-card-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px;
  }
  .violation-card-header .file-link-btn { padding: 0; }
  .violation-rule-chip {
    font-size: 11px; font-weight: 600; color: var(--danger);
    cursor: default;
  }
  .violation-count-badge {
    font-size: 10px; font-weight: 700; color: var(--danger);
    background: rgba(231, 76, 60, 0.12);
    padding: 1px 7px; border-radius: 10px;
  }
  .violation-card-body {
    padding: 2px 10px 8px;
  }
  .layer-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; color: white; font-weight: 600; }
  .text-muted { color: var(--text-muted); }
  .high-impact-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: var(--warning); color: #000; font-weight: 600; }
  .priority-badge { font-size: 9px; padding: 1px 4px; border-radius: 3px; background: var(--bg-surface); color: var(--text-muted); font-weight: 600; }
  .clear-highlight-btn {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent);
    padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 500;
    cursor: pointer; font-family: inherit; margin: 8px 0; transition: all 0.15s;
  }
  .clear-highlight-btn:hover { background: var(--accent); color: white; }
</style>
