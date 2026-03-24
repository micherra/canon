<script lang="ts">
  import type { GraphNode, EntityInfo } from "../stores/graphData";

  interface Props {
    node: GraphNode;
    onFileClick: (fileId: string) => void;
  }

  let { node, onFileClick }: Props = $props();

  // Kind display config
  const KIND_COLORS: Record<string, string> = {
    function: "#4A90D9",
    method: "#4A90D9",
    class: "#9B59B6",
    interface: "#27ae60",
    type: "#1abc9c",
    enum: "#e67e22",
    const: "#7f8c8d",
    variable: "#7f8c8d",
  };

  const KIND_ICONS: Record<string, string> = {
    function: "ƒ",
    method: "ƒ",
    class: "C",
    interface: "I",
    type: "T",
    enum: "E",
    const: "K",
    variable: "V",
  };

  function kindColor(kind: string): string {
    return KIND_COLORS[kind.toLowerCase()] || "#7f8c8d";
  }

  function kindIcon(kind: string): string {
    return KIND_ICONS[kind.toLowerCase()] || kind.slice(0, 1).toUpperCase();
  }

  // Group entities by kind
  let groupedEntities = $derived.by(() => {
    const entities = node.entities;
    if (!entities || entities.length === 0) return new Map<string, EntityInfo[]>();
    const map = new Map<string, EntityInfo[]>();
    for (const e of entities) {
      const key = e.kind.toLowerCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  });

  let hasEntities = $derived((node.entities?.length ?? 0) > 0);

  let entityCount = $derived(node.entity_count ?? node.entities?.length ?? 0);
  let exportCount = $derived(node.export_count ?? node.entities?.filter(e => e.is_exported).length ?? 0);
  let deadCodeCount = $derived(node.dead_code_count ?? 0);

  function handleLineClick(line?: number) {
    if (line !== undefined) {
      // Signal file click — parent will handle navigation
      onFileClick(node.id);
    }
  }

  // Sort groups: functions first, then classes, interfaces, types, then rest
  const KIND_ORDER = ["function", "method", "class", "interface", "type", "enum", "const", "variable"];
  let sortedGroups = $derived.by(() => {
    const entries = [...groupedEntities.entries()];
    return entries.sort(([a], [b]) => {
      const ai = KIND_ORDER.indexOf(a);
      const bi = KIND_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  });
</script>

<div class="entity-panel">
  <div class="entity-stats">
    {#if entityCount > 0}
      <span class="stat-badge stat-total" title="Total entities">{entityCount} entities</span>
    {/if}
    {#if exportCount > 0}
      <span class="stat-badge stat-export" title="Exported symbols">{exportCount} exported</span>
    {/if}
    {#if deadCodeCount > 0}
      <span class="stat-badge stat-dead" title="Dead code symbols">{deadCodeCount} dead</span>
    {/if}
  </div>

  {#if !hasEntities}
    <div class="empty-state">
      <span class="text-muted">No entity data available</span>
    </div>
  {:else}
    <div class="entity-groups">
      {#each sortedGroups as [kind, entities]}
        <div class="entity-group">
          <div class="group-header">
            <span class="kind-icon" style="background:{kindColor(kind)}">{kindIcon(kind)}</span>
            <span class="group-label">{kind}</span>
            <span class="group-count">{entities.length}</span>
          </div>
          <div class="entity-list">
            {#each entities as entity}
              <div
                class="entity-row"
                class:dead-code={entity.is_exported === false && deadCodeCount > 0}
                role="button"
                tabindex="0"
                onclick={() => handleLineClick(entity.line_start)}
                onkeydown={(e) => e.key === "Enter" && handleLineClick(entity.line_start)}
              >
                <span class="entity-name" title={entity.name}>{entity.name}</span>
                <div class="entity-meta">
                  {#if entity.is_exported}
                    <span class="export-badge" title="Exported">exp</span>
                  {/if}
                  {#if entity.line_start !== undefined}
                    <span class="line-ref">:{entity.line_start}</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .entity-panel {
    padding: 10px 0 6px;
  }

  .entity-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
  }

  .stat-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    letter-spacing: 0.3px;
  }

  .stat-total {
    background: rgba(74, 144, 217, 0.15);
    color: #4A90D9;
  }

  .stat-export {
    background: rgba(39, 174, 96, 0.15);
    color: #27ae60;
  }

  .stat-dead {
    background: rgba(231, 76, 60, 0.15);
    color: #e74c3c;
  }

  .empty-state {
    padding: 8px 0;
  }

  .text-muted {
    color: var(--text-muted);
    font-size: 12px;
  }

  .entity-groups {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .entity-group {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid var(--border);
  }

  .kind-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    color: white;
    flex-shrink: 0;
  }

  .group-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    flex: 1;
  }

  .group-count {
    font-size: 10px;
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.06);
    padding: 0 5px;
    border-radius: 8px;
  }

  .entity-list {
    display: flex;
    flex-direction: column;
  }

  .entity-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    cursor: pointer;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    gap: 6px;
  }

  .entity-row:last-child {
    border-bottom: none;
  }

  .entity-row:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .entity-row.dead-code {
    opacity: 0.55;
  }

  .entity-name {
    font-size: 11px;
    color: var(--text);
    font-family: var(--font-mono, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .entity-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .export-badge {
    font-size: 9px;
    font-weight: 700;
    color: #27ae60;
    background: rgba(39, 174, 96, 0.12);
    padding: 1px 4px;
    border-radius: 3px;
    letter-spacing: 0.3px;
  }

  .line-ref {
    font-size: 10px;
    color: var(--text-muted);
    font-family: var(--font-mono, monospace);
  }
</style>
