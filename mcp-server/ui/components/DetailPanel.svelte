<script lang="ts">
  import ImpactCascade from "./ImpactCascade.svelte";
  import Sparkline from "./Sparkline.svelte";
  import {getLayerColor, getRuleDescription, SEVERITY_COLORS} from "../lib/constants";
  import {basename, computeCascade, getNodeLayer} from "../lib/graph";
  import type {GraphNode} from "../stores/graphData";
  import {edgeIn, edgeOut, graphData, layerMap, principles} from "../stores/graphData";
  import {activePrReview, prReviewFiles} from "../stores/filters";
  import {tooltip} from "../lib/tooltip";
  import {bridge} from "../stores/bridge";

  interface Props {
    node: GraphNode;
    onBackToOverview: () => void;
    onFileClick: (fileId: string) => void;
    onHighlightCascade: (nodeId: string) => void;
  }

  let { node, onBackToOverview, onFileClick, onHighlightCascade }: Props = $props();

  // Lazy-load summary if not already on the node
  let lazySummary = $state<string | null>(null);
  $effect(() => {
    lazySummary = null;
    if (!node.summary) {
      bridge.request("getSummary", { fileId: node.id })
        .then((res: any) => { if (res?.summary) lazySummary = res.summary; })
        .catch(() => {});
    }
  });
  let displaySummary = $derived(node.summary || lazySummary);

  let imports = $derived($edgeOut.get(node.id) || []);
  let importedBy = $derived($edgeIn.get(node.id) || []);

  let cascade = $derived(computeCascade(node.id, $edgeIn));
  let totalAffected = $derived(cascade.reduce((sum, level) => sum + level.size, 0));

  let affectedLayers = $derived.by(() => {
    const map = new Map<string, number>();
    for (const level of cascade) {
      for (const f of level) {
        const layer = getNodeLayer(f, $layerMap);
        map.set(layer, (map.get(layer) || 0) + 1);
      }
    }
    return map;
  });

  // Compliance trend sparkline — fetch for first violated principle
  let trendData = $state<number[]>([]);
  let trendPrinciple = $state<string>("");
  $effect(() => {
    trendData = [];
    trendPrinciple = "";
    const rules = node.top_violations || [];
    if (rules.length === 0) return;
    const principleId = rules[0];
    trendPrinciple = principleId;
    bridge.request("getComplianceTrend", { principleId })
      .then((res: any) => {
        if (res?.trend && Array.isArray(res.trend) && res.trend.length >= 2) {
          trendData = res.trend.map((t: any) => t.pass_rate as number);
        }
      })
      .catch(() => {});
  });

  // Violations — unified from node data (MCP folds layer + principle violations together)
  let totalViolationCount = $derived(node.violation_count || 0);
  let violationRules = $derived(node.top_violations || []);

  // PR review violations for this file
  let prFileViolations = $derived.by(() => {
    const review = $activePrReview;
    const files = $prReviewFiles;
    if (!review || !files || !files.has(node.id)) return [];
    return (review.violations || []).filter((v: any) => v.file === node.id);
  });

  let hasPrReview = $derived($prReviewFiles !== null && $prReviewFiles.has(node.id));
</script>

<div class="detail-panel">
  <button class="insight-back" onclick={onBackToOverview}>← Overview</button>
  <h3>{node.id}</h3>
  <div class="detail-field">
    <span class="field-label">Layer</span>
    <span class="layer-dot" style="background:{getLayerColor(node.layer)}"></span> {node.layer}
  </div>
  <div class="detail-field">
    <span class="field-label">Dependencies</span>
    <span>Imports {imports.length} files, imported by {importedBy.length}</span>
  </div>
  {#if imports.length > 0}
    <div class="detail-field">
      <span class="field-label">Imports</span>
      <div>{#each imports as f}<span class="tag">{basename(f)}</span>{/each}</div>
    </div>
  {/if}
  {#if importedBy.length > 0}
    <div class="detail-field">
      <span class="field-label">Imported By</span>
      <div>{#each importedBy as f}<span class="tag">{basename(f)}</span>{/each}</div>
    </div>
  {/if}

  <ImpactCascade
    {cascade}
    {totalAffected}
    isChanged={!!node.changed}
    {affectedLayers}
    layerMap={$layerMap}
    {onFileClick}
    onHighlightCascade={() => onHighlightCascade(node.id)}
  />

  <div class="detail-field">
    <span class="field-label">Violations</span>
    {#if totalViolationCount === 0}
      <span class="text-muted">None</span>
    {:else}
      <div class="violation-card">
        <div class="violation-card-header">
          {#if violationRules.length > 0}
            {#each violationRules as rule}
              <span class="violation-rule-chip" use:tooltip={getRuleDescription(rule, $principles)}>{rule}</span>
            {/each}
          {/if}
          <span class="violation-count-badge">{totalViolationCount}</span>
        </div>
        {#if trendData.length >= 2}
          <div class="violation-trend">
            <span class="trend-label">Compliance trend ({trendPrinciple})</span>
            <Sparkline values={trendData} color="#4A90D9" label="Weekly pass rate" />
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="detail-field">
    <span class="field-label">Changed</span>
    {#if node.changed}
      <span class="text-info">Yes</span>
    {:else}
      <span class="text-muted">No</span>
    {/if}
  </div>

  <div class="detail-field">
    <span class="field-label">Summary</span>
    {#if displaySummary}
      <div class="file-summary">{displaySummary}</div>
    {:else}
      <span class="text-muted">No summary available</span>
    {/if}
  </div>

  {#if hasPrReview}
    <div class="pr-section">
      <span class="field-label">PR Review Violations</span>
      {#if prFileViolations.length > 0}
        {#each prFileViolations as v}
          <div class="violation-item">
            <span class="severity-badge" style="background:{SEVERITY_COLORS[v.severity] || '#7f8c8d'}">{v.severity}</span>
            <strong>{v.principle_id}</strong>
            {#if v.detail}<p>{v.detail}</p>{/if}
            {#if v.suggestion}<p class="suggestion">Fix: {v.suggestion}</p>{/if}
          </div>
        {/each}
      {:else}
        <span style="color:var(--success)">No violations</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .detail-panel { padding: 16px 20px; overflow-y: auto; flex: 1; transition: opacity 0.2s ease; }
  .detail-panel h3 { font-size: 13px; font-weight: 600; color: var(--text-bright); letter-spacing: -0.1px; }
  .detail-field { margin: 10px 0; }
  .field-label { display: block; font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px; font-weight: 600; }
  .layer-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .tag { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 500; background: var(--bg-card); color: var(--text-muted); margin: 1px 3px 1px 0; }
  .violation-card {
    margin-top: 6px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-left: 3px solid var(--danger);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .violation-card-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px; gap: 6px; flex-wrap: wrap;
  }
  .violation-rule-chip {
    font-size: 11px; font-weight: 600; color: var(--danger);
    cursor: default;
  }
  .violation-count-badge {
    font-size: 10px; font-weight: 700; color: var(--danger);
    background: rgba(231, 76, 60, 0.12);
    padding: 1px 7px; border-radius: 10px;
  }
  .violation-trend {
    padding: 6px 10px 8px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .trend-label {
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .insight-back {
    background: none; border: none; padding: 0;
    font-size: 11px; color: var(--accent); cursor: pointer; margin-bottom: 8px;
    display: inline-flex; align-items: center; gap: 4px; font-family: inherit;
  }
  .insight-back:hover { text-decoration: underline; }

  .text-info { color: var(--info); }
  .text-muted { color: var(--text-muted); }
  .file-summary { font-size: 12px; line-height: 1.6; color: var(--text); }
  .pr-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
  .pr-section .field-label { margin-bottom: 6px; }
  .violation-item {
    background: var(--bg-card); border-radius: var(--radius-sm);
    padding: 10px 14px; margin-bottom: 6px;
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    border: 1px solid var(--border);
  }
  .violation-item p { width: 100%; font-size: 13px; color: var(--text-muted); }
  .severity-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; color: white; text-transform: uppercase; letter-spacing: 1px; }
  .suggestion { color: var(--info) !important; }
</style>
