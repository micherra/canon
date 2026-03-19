<script lang="ts">
  import { getLayerColor } from "../lib/constants";
  import { basename, getNodeLayer } from "../lib/graph";

  interface Props {
    cascade: Set<string>[];
    totalAffected: number;
    isChanged: boolean;
    affectedLayers: Map<string, number>;
    layerMap: Map<string, string>;
    onFileClick: (fileId: string) => void;
    onHighlightCascade: () => void;
  }

  let { cascade, totalAffected, isChanged, affectedLayers, layerMap, onFileClick, onHighlightCascade }: Props = $props();

  let riskLevel = $derived(totalAffected > 10 ? "high" : totalAffected > 4 ? "medium" : "low");
  let riskColor = $derived(riskLevel === "high" ? "var(--danger)" : riskLevel === "medium" ? "var(--warning)" : "var(--success)");
  let riskLabel = $derived(riskLevel === "high" ? "High impact" : riskLevel === "medium" ? "Medium impact" : "Low impact");
  let maxShown = $derived(isChanged ? 6 : 4);
</script>

{#if totalAffected > 0}
  <div class="detail-field impact-section">
    <span class="field-label">{isChanged ? "Change Impact" : "Dependents Cascade"}</span>
    {#if isChanged}
      <div class="impact-summary">
        <span class="impact-badge" style="background:{riskColor}">{riskLabel}</span>
        <span class="text-muted" style="font-size:11px">{totalAffected} file{totalAffected !== 1 ? "s" : ""} could be affected</span>
      </div>
      <div class="impact-layers">
        {#each [...affectedLayers.entries()] as [layer, count]}
          <span class="impact-layer-chip">
            <span class="chip-dot" style="background:{getLayerColor(layer)}"></span>
            {layer} <span class="text-muted">({count})</span>
          </span>
        {/each}
      </div>
    {:else}
      <span class="text-muted" style="font-size:11px">{totalAffected} file{totalAffected !== 1 ? "s" : ""} depend on this across {cascade.length} level{cascade.length !== 1 ? "s" : ""}</span>
    {/if}
    <div class="impact-cascade">
      {#each cascade as level, i}
        <div class="cascade-level">
          <div class="cascade-depth">
            <span class="cascade-depth-num">{i + 1}</span>
            <span class="cascade-depth-line"></span>
          </div>
          <div class="cascade-files">
            {#each [...level].slice(0, maxShown) as f}
              <button class="cascade-file file-link-btn" onclick={() => onFileClick(f)}>
                <span class="chip-dot" style="background:{getLayerColor(getNodeLayer(f, layerMap))}"></span>
                {basename(f)}
              </button>
            {/each}
            {#if level.size > maxShown}
              <span class="text-muted" style="font-size:10px">+{level.size - maxShown} more</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
    {#if isChanged}
      <button class="btn-ghost impact-highlight-btn" onclick={onHighlightCascade} style="margin-top:8px;font-size:11px;padding:4px 12px">
        Highlight cascade in graph
      </button>
    {/if}
  </div>
{/if}

<style>
  .detail-field { margin: 10px 0; }
  .field-label { display: block; font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 3px; font-weight: 600; }
  .impact-section { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }
  .impact-summary { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .impact-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; color: white; text-transform: uppercase; letter-spacing: 0.5px; }
  .impact-layers { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
  .impact-layer-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500;
    background: var(--bg-card); border: 1px solid var(--border);
  }
  .impact-cascade { margin-top: 8px; }
  .cascade-level { display: flex; gap: 10px; margin-bottom: 2px; min-height: 28px; }
  .cascade-depth { display: flex; flex-direction: column; align-items: center; width: 20px; flex-shrink: 0; }
  .cascade-depth-num {
    width: 18px; height: 18px; border-radius: 50%;
    background: var(--bg-card); border: 1px solid var(--border);
    font-size: 10px; font-weight: 700; color: var(--text-muted);
    display: flex; align-items: center; justify-content: center;
  }
  .cascade-depth-line { flex: 1; width: 1px; background: var(--border); margin: 2px 0; }
  .cascade-files { display: flex; flex-wrap: wrap; gap: 4px; align-items: flex-start; padding: 2px 0; }
  .cascade-file { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; padding: 1px 0; }
  .file-link-btn {
    display: inline-flex; align-items: center; gap: 3px;
    background: none; border: none; padding: 1px 0; cursor: pointer;
    color: var(--accent); font-family: inherit; font-size: 11px;
  }
  .file-link-btn:hover { text-decoration: underline; }
  .chip-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .text-muted { color: var(--text-muted); }
  .btn-ghost {
    background: transparent; color: var(--text-muted); border: 1px solid var(--border);
    border-radius: var(--radius-sm); cursor: pointer; font-family: inherit; font-weight: 500;
    transition: all 0.15s ease; width: 100%; text-align: center;
  }
  .btn-ghost:hover { background: var(--bg-card); color: var(--text); border-color: rgba(255,255,255,0.12); }
</style>
