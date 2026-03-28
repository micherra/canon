<script lang="ts">
  import { basename } from "../lib/graph";
  import Badge from "./Badge.svelte";
  import PrViolationList from "./PrViolationList.svelte";
  import PrBlastRadiusSection from "./PrBlastRadiusSection.svelte";

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

  // ── Props ─────────────────────────────────────────────────────────────────

  interface PrDetailPanelProps {
    file: string;
    violations: Violation[];
    blastRadiusAffected: BlastRadiusEntry[];
    onFileClick: (fileId: string) => void;
  }

  let {
    file,
    violations,
    blastRadiusAffected,
    onFileClick,
  }: PrDetailPanelProps = $props();

  // ── Derived state ─────────────────────────────────────────────────────────

  /** True when the file has nothing to show */
  let isEmpty = $derived(
    violations.length === 0 &&
      blastRadiusAffected.length === 0,
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
        <Badge
          text="{violations.length} violation{violations.length !== 1 ? 's' : ''}"
          color="var(--danger, #e74c3c)"
          bg="rgba(231, 76, 60, 0.15)"
          rounded
        />
      {/if}
      {#if blastRadiusAffected.length > 0}
        <Badge
          text="{blastRadiusAffected.length} affected"
          color="var(--warning, #f39c12)"
          bg="rgba(243, 156, 18, 0.12)"
          rounded
        />
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
      <PrViolationList {violations} />
    </section>

    <!-- ── Blast radius section ────────────────────────────────────────── -->
    {#if blastRadiusAffected.length > 0}
      <section class="panel-section">
        <h4 class="section-header">Blast Radius ({blastRadiusAffected.length} affected)</h4>
        <PrBlastRadiusSection entries={blastRadiusAffected} {onFileClick} />
      </section>
    {/if}

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
</style>
