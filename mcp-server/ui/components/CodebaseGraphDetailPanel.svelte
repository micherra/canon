<script lang="ts">
  /**
   * CodebaseGraphDetailPanel.svelte
   *
   * Right-side detail panel shown when a node is selected in CodebaseGraph.
   * Displays node metadata, dependencies (in/out edges), entities, exports,
   * and violations.
   *
   * Canon principles:
   *   - functions-do-one-thing: renders node detail panel only
   *   - compose-from-small-to-large: standalone leaf; composed by CodebaseGraph.svelte
   */

  import Badge from "./Badge.svelte";
  import type { GraphNode } from "../lib/types";

  // ── Props ─────────────────────────────────────────────────────────────────

  interface CodebaseGraphDetailPanelProps {
    selectedNode: GraphNode;
    layerColors: Record<string, string>;
    edgesIn: Map<string, string[]>;
    edgesOut: Map<string, string[]>;
    onClose: () => void;
  }

  let { selectedNode, layerColors, edgesIn, edgesOut, onClose }: CodebaseGraphDetailPanelProps =
    $props();
</script>

<div class="detail-panel">
  <div class="detail-header">
    <div class="node-path">{selectedNode.id}</div>
    <button class="close-btn" onclick={onClose} title="Close panel">×</button>
  </div>

  <div class="node-meta">
    <Badge
      text={selectedNode.layer}
      bg={layerColors[selectedNode.layer] ?? '#6b7394'}
      color="#fff"
    />
    {#if selectedNode.changed}
      <Badge
        text="changed"
        bg="var(--accent-soft, rgba(108,140,255,0.12))"
        color="var(--accent, #6c8cff)"
      />
    {/if}
    {#if selectedNode.kind}
      <Badge
        text={selectedNode.kind}
      />
    {/if}
  </div>

  {#if selectedNode.summary}
    <div class="detail-section">
      <div class="section-label">Summary</div>
      <div class="summary-text">{selectedNode.summary}</div>
    </div>
  {/if}

  <div class="stats-row">
    {#if selectedNode.entity_count != null}
      <div class="stat-item">
        <span class="stat-value">{selectedNode.entity_count}</span>
        <span class="stat-label">entities</span>
      </div>
    {/if}
    {#if selectedNode.export_count != null}
      <div class="stat-item">
        <span class="stat-value">{selectedNode.export_count}</span>
        <span class="stat-label">exports</span>
      </div>
    {/if}
    {#if selectedNode.dead_code_count != null}
      <div class="stat-item">
        <span class="stat-value">{selectedNode.dead_code_count}</span>
        <span class="stat-label">dead</span>
      </div>
    {/if}
    {#if selectedNode.community != null}
      <div class="stat-item">
        <span class="stat-value">#{selectedNode.community}</span>
        <span class="stat-label">community</span>
      </div>
    {/if}
  </div>

  {#if (edgesIn.get(selectedNode.id)?.length ?? 0) > 0 || (edgesOut.get(selectedNode.id)?.length ?? 0) > 0}
    <div class="detail-section">
      <div class="section-label">Dependencies</div>
      {#if (edgesIn.get(selectedNode.id)?.length ?? 0) > 0}
        <div class="dep-group">
          <div class="dep-group-label">imported by ({edgesIn.get(selectedNode.id)!.length})</div>
          {#each edgesIn.get(selectedNode.id)! as dep}
            <div class="dep-item">{dep}</div>
          {/each}
        </div>
      {/if}
      {#if (edgesOut.get(selectedNode.id)?.length ?? 0) > 0}
        <div class="dep-group">
          <div class="dep-group-label">imports ({edgesOut.get(selectedNode.id)!.length})</div>
          {#each edgesOut.get(selectedNode.id)! as dep}
            <div class="dep-item">{dep}</div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if selectedNode.entities?.length}
    <div class="detail-section">
      <div class="section-label">Entities</div>
      {#each selectedNode.entities as entity}
        <div class="entity-item">
          <span class="entity-name">{entity.name}</span>
          <span class="entity-kind">{entity.kind}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if selectedNode.exports?.length}
    <div class="detail-section">
      <div class="section-label">Exports</div>
      {#each selectedNode.exports as exp}
        <div class="export-item">{exp}</div>
      {/each}
    </div>
  {/if}

  {#if selectedNode.violation_count}
    <div class="detail-section">
      <div class="section-label violation-label">{selectedNode.violation_count} violation{selectedNode.violation_count !== 1 ? 's' : ''}</div>
      {#if selectedNode.top_violations?.length}
        <div class="violation-list">
          {#each selectedNode.top_violations as v}
            <div class="violation-item">{v}</div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .detail-panel {
    width: 300px;
    flex-shrink: 0;
    border-left: 1px solid var(--border, rgba(255,255,255,0.06));
    background: var(--bg-surface, rgba(255,255,255,0.03));
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .detail-header {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px 6px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .node-path {
    font-family: monospace;
    font-size: 11px;
    color: var(--text-bright, #e8eaf0);
    flex: 1;
    word-break: break-all;
    line-height: 1.4;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted, #636a80);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
    flex-shrink: 0;
    border-radius: 3px;
    transition: color 0.15s;
  }

  .close-btn:hover {
    color: var(--text-bright, #e8eaf0);
  }

  .node-meta {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    padding: 6px 12px 8px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.04));
  }

  /* ── Stats row ──────────────────────────────────────────────────────────── */

  .stats-row {
    display: flex;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.04));
    flex-wrap: wrap;
  }

  .stat-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
  }

  .stat-value {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-bright, #e8eaf0);
  }

  .stat-label {
    font-size: 9px;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* ── Sections ───────────────────────────────────────────────────────────── */

  .detail-section {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.04));
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 5px;
  }

  .violation-label {
    color: var(--danger, #ff6b6b);
  }

  .summary-text {
    font-size: 11px;
    color: var(--text, #b4b8c8);
    line-height: 1.5;
  }

  /* ── Dependency lists ───────────────────────────────────────────────────── */

  .dep-group {
    margin-bottom: 6px;
  }

  .dep-group:last-child {
    margin-bottom: 0;
  }

  .dep-group-label {
    font-size: 9px;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 3px;
  }

  .dep-item {
    font-family: monospace;
    font-size: 10px;
    color: var(--text, #b4b8c8);
    padding: 1px 0 1px 8px;
    border-left: 2px solid var(--border, rgba(255,255,255,0.1));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.6;
  }

  /* ── Entity list ────────────────────────────────────────────────────────── */

  .entity-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 2px 0;
  }

  .entity-name {
    font-size: 11px;
    color: var(--text-bright, #e8eaf0);
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .entity-kind {
    font-size: 9px;
    color: var(--text-muted, #636a80);
    text-transform: uppercase;
    flex-shrink: 0;
  }

  /* ── Export list ────────────────────────────────────────────────────────── */

  .export-item {
    font-family: monospace;
    font-size: 11px;
    color: var(--text, #b4b8c8);
    padding: 1px 0;
    line-height: 1.5;
  }

  /* ── Violations ─────────────────────────────────────────────────────────── */

  .violation-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .violation-item {
    font-size: 11px;
    color: var(--text-muted, #636a80);
    padding: 2px 6px 2px 8px;
    border-left: 2px solid var(--danger, #ff6b6b);
    line-height: 1.4;
  }
</style>
