<script lang="ts">
  import { getSeverityColor } from "../lib/utils";
  import { basename } from "../lib/graph";

  // ── Types ─────────────────────────────────────────────────────────────────

  interface Violation {
    principle_id: string;
    severity: string;
    message?: string;
  }

  interface BlastRadiusEntry {
    entity_name: string;
    entity_kind: string;
    file_path: string;
    depth: number;
  }

  interface Decision {
    principle_id: string;
    file_path: string;
    justification: string;
    category?: string;
  }

  // ── Props ─────────────────────────────────────────────────────────────────

  interface PrDetailPanelProps {
    file: string;
    violations: Violation[];
    blastRadiusAffected: BlastRadiusEntry[];
    decisions: Decision[];
    onFileClick: (fileId: string) => void;
  }

  let {
    file,
    violations,
    blastRadiusAffected,
    decisions,
    onFileClick,
  }: PrDetailPanelProps = $props();

  // ── Derived state ─────────────────────────────────────────────────────────

  // Max entries to show in blast radius list before "+N more"
  const maxShown = 10;

  /** Decisions filtered to principle IDs that this file has violations for */
  let relevantDecisions = $derived.by(() => {
    const violatedPrinciples = new Set(violations.map((v) => v.principle_id));
    return decisions.filter((d) => violatedPrinciples.has(d.principle_id));
  });

  /** Blast radius entries grouped by depth */
  let byDepth = $derived.by(() => {
    const map = new Map<number, BlastRadiusEntry[]>();
    for (const entry of blastRadiusAffected) {
      if (!map.has(entry.depth)) map.set(entry.depth, []);
      map.get(entry.depth)!.push(entry);
    }
    // Sort by depth ascending
    return [...map.entries()].sort(([a], [b]) => a - b);
  });

  /** True when the file has nothing to show */
  let isEmpty = $derived(
    violations.length === 0 &&
      blastRadiusAffected.length === 0 &&
      decisions.length === 0,
  );

  /** Human-readable filename */
  let fileName = $derived(basename(file));

</script>

<div class="pr-detail-panel">
  <!-- ── File header ─────────────────────────────────────────────────────── -->
  <div class="panel-header">
    <span class="file-name" title={file}>{fileName}</span>
    <div class="header-badges">
      {#if violations.length > 0}
        <span class="badge badge-violations">{violations.length} violation{violations.length !== 1 ? "s" : ""}</span>
      {/if}
      {#if blastRadiusAffected.length > 0}
        <span class="badge badge-blast">{blastRadiusAffected.length} affected</span>
      {/if}
    </div>
  </div>

  <!-- ── Overall empty state ────────────────────────────────────────────── -->
  {#if isEmpty}
    <div class="empty-state">No issues found for this file</div>
  {:else}
    <!-- ── Violations section ──────────────────────────────────────────── -->
    <section class="panel-section">
      <h4 class="section-header">Violations ({violations.length})</h4>
      {#if violations.length === 0}
        <div class="empty-section">No violations</div>
      {:else}
        {#each violations as violation}
          <div class="violation-card">
            <div class="violation-card-top">
              <span
                class="severity-badge"
                style="background:{getSeverityColor(violation.severity)}"
              >{violation.severity}</span>
              <span class="principle-id">{violation.principle_id}</span>
            </div>
            <p class="violation-message">
              {(violation.message ?? "") || "No details available"}
            </p>
          </div>
        {/each}
      {/if}
    </section>

    <!-- ── Blast radius section ────────────────────────────────────────── -->
    {#if blastRadiusAffected.length > 0}
      <section class="panel-section">
        <h4 class="section-header">Blast Radius ({blastRadiusAffected.length} affected)</h4>
        <div class="blast-radius-list">
          {#each byDepth as [depth, entries]}
            <div class="depth-group">
              <div class="depth-indicator">
                <span class="depth-num">{depth}</span>
                <span class="depth-line"></span>
              </div>
              <div class="depth-files">
                {#each entries.slice(0, maxShown) as entry}
                  <button
                    class="file-link"
                    onclick={() => onFileClick(entry.file_path)}
                    title={entry.file_path}
                  >
                    {basename(entry.file_path)}
                  </button>
                {/each}
                {#if entries.length > maxShown}
                  <span class="more-indicator">+{entries.length - maxShown} more</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- ── Decisions section ──────────────────────────────────────────── -->
    <section class="panel-section">
      <h4 class="section-header">Prior Decisions ({relevantDecisions.length})</h4>
      {#if relevantDecisions.length === 0}
        <div class="empty-section">No prior deviation decisions for these principles</div>
      {:else}
        {#each relevantDecisions as decision}
          <div class="decision-card">
            <div class="decision-card-top">
              <span class="principle-id">{decision.principle_id}</span>
              {#if decision.category}
                <span class="category-badge">{decision.category}</span>
              {/if}
            </div>
            <p class="decision-justification">{decision.justification}</p>
          </div>
        {/each}
      {/if}
    </section>
  {/if}
</div>

<style>
  .pr-detail-panel {
    padding: 14px 16px;
    overflow-y: auto;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* ── Header ─────────────────────────────────────────────────────────────── */
  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }

  .file-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-bright);
    word-break: break-all;
    flex: 1;
  }

  .header-badges {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
  }

  .badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  .badge-violations {
    background: rgba(231, 76, 60, 0.15);
    color: var(--danger, #e74c3c);
    border: 1px solid rgba(231, 76, 60, 0.3);
  }

  .badge-blast {
    background: rgba(243, 156, 18, 0.12);
    color: var(--warning, #f39c12);
    border: 1px solid rgba(243, 156, 18, 0.25);
  }

  /* ── Sections ───────────────────────────────────────────────────────────── */
  .panel-section {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .panel-section:first-of-type {
    margin-top: 10px;
    padding-top: 10px;
    border-top: none;
  }

  .section-header {
    margin: 0 0 8px 0;
  }

  .empty-section {
    font-size: 12px;
    color: var(--text-muted);
    padding: 4px 0;
  }

  /* ── Overall empty state ─────────────────────────────────────────────────── */
  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: var(--text-muted);
    padding: 24px 0;
    text-align: center;
  }

  /* ── Violation cards ─────────────────────────────────────────────────────── */
  .violation-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    padding: 10px 12px;
    margin-bottom: 6px;
  }

  .violation-card-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .severity-badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    color: white;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  .principle-id {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-bright);
    word-break: break-all;
  }

  .violation-message {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  /* ── Blast radius ────────────────────────────────────────────────────────── */
  .blast-radius-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .depth-group {
    display: flex;
    gap: 8px;
    min-height: 24px;
  }

  .depth-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 18px;
    flex-shrink: 0;
  }

  .depth-num {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--bg-card);
    border: 1px solid var(--border);
    font-size: 9px;
    font-weight: 700;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .depth-line {
    flex: 1;
    width: 1px;
    background: var(--border);
    margin: 2px 0;
  }

  .depth-files {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: flex-start;
    padding: 2px 0;
  }

  .file-link {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    padding: 1px 0;
    cursor: pointer;
    color: var(--accent);
    font-family: inherit;
    font-size: 11px;
    text-align: left;
  }

  .file-link:hover {
    text-decoration: underline;
  }

  .more-indicator {
    font-size: 10px;
    color: var(--text-muted);
  }

  /* ── Decisions ───────────────────────────────────────────────────────────── */
  .decision-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 4px);
    padding: 10px 12px;
    margin-bottom: 6px;
  }

  .decision-card-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }

  .category-badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    background: var(--bg-card);
    border: 1px solid var(--border);
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  .decision-justification {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }
</style>
