<script lang="ts">
  import ImpactCascade from "./ImpactCascade.svelte";
  import {getLayerColor, getRuleDescription, SEVERITY_COLORS} from "../lib/constants";
  import {basename, computeCascade, getNodeLayer} from "../lib/graph";
  import type {GraphNode} from "../stores/graphData";
  import {edgeIn, edgeOut, graphData, layerMap} from "../stores/graphData";
  import {activePrReview, prReviewFiles} from "../stores/filters";

  interface Props {
    node: GraphNode;
    onBackToOverview: () => void;
    onFileClick: (fileId: string) => void;
    onHighlightCascade: (nodeId: string) => void;
  }

  let { node, onBackToOverview, onFileClick, onHighlightCascade }: Props = $props();

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

  // Layer violations for this node
  let nodeViolations = $derived.by(() => {
    const lv = $graphData?.insights?.layer_violations || [];
    return lv.filter((v: any) => v.source === node.id);
  });

  // Top violations from hotspot data for this node
  let hotspotViolations = $derived.by(() => {
    const hotspots = $graphData?.hotspots || [];
    const match = hotspots.find((h: any) => h.path === node.id);
    return match?.top_violations || [];
  });

  // Group all violations by rule for the card-per-rule layout
  interface ViolationGroup {
    rule: string;
    count: number;
    files: Array<{ sourceLayer: string; targetLayer: string; target: string }>;
  }
  let violationGroups = $derived.by((): ViolationGroup[] => {
    const groups = new Map<string, ViolationGroup>();

    // Layer violations → imports-across-layers
    if (nodeViolations.length > 0) {
      groups.set("imports-across-layers", {
        rule: "imports-across-layers",
        count: nodeViolations.length,
        files: nodeViolations.map((v: any) => ({
          sourceLayer: node.layer,
          targetLayer: v.target_layer,
          target: v.target,
        })),
      });
    }

    // Hotspot violations (principle-based)
    for (const rule of hotspotViolations) {
      if (!groups.has(rule)) {
        groups.set(rule, { rule, count: 1, files: [] });
      }
    }

    return [...groups.values()];
  });

  let totalViolationCount = $derived(
    (node.violation_count || 0) + nodeViolations.length
  );

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
      {#each violationGroups as group}
        <div class="violation-card">
          <div class="violation-card-header">
            <span class="violation-rule-chip" title={getRuleDescription(group.rule)}>{group.rule}</span>
            <span class="violation-count-badge">{group.count}</span>
          </div>
          {#if group.files.length > 0}
            <div class="violation-card-body">
              {#each group.files as f}
                <div class="violation-row">
                  <span class="layer-badge" style="background:{getLayerColor(f.sourceLayer)}">{f.sourceLayer}</span>
                  <span class="violation-arrow">→</span>
                  <span class="layer-badge" style="background:{getLayerColor(f.targetLayer)}">{f.targetLayer}</span>
                  <button class="file-link-btn" onclick={() => onFileClick(f.target)}>{basename(f.target)}</button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
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
    {#if node.summary}
      <div class="file-summary">{node.summary}</div>
    {:else}
      <span class="text-muted">Run <code>/canon:dashboard</code> to generate</span>
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
    padding: 6px 10px;
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
  .violation-card-body {
    padding: 2px 10px 8px;
  }
  .violation-row { margin: 4px 0; display: flex; align-items: center; gap: 4px; font-size: 11px; }
  .violation-arrow { color: var(--text-muted); font-size: 10px; }
  .layer-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; color: white; font-weight: 600; }
  .file-link-btn {
    background: none; border: none; padding: 0; cursor: pointer;
    text-decoration: underline; color: var(--accent); font-family: inherit; font-size: inherit;
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
