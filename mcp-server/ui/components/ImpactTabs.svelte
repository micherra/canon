<script lang="ts">
  import ImpactRow from "./ImpactRow.svelte";
  import ViolationCard from "./ViolationCard.svelte";
  import DepRow from "./DepRow.svelte";

  // ── Props ────────────────────────────────────────────────────────────────

  interface PriorityFactors {
    in_degree: number;
    violation_count: number;
    is_changed: boolean;
    layer: string;
    layer_centrality: number;
  }

  interface Violation {
    principle_id: string;
    severity: "rule" | "strong-opinion" | "convention";
    message?: string;
  }

  interface ImpactFile {
    path: string;
    priority_score?: number;
    priority_factors?: PriorityFactors;
    bucket: string;
    violations?: Violation[];
  }

  interface BlastRadiusEntry {
    file: string;
    affected: Array<{ path: string; depth: number }>;
  }

  interface ImpactTabsProps {
    files: ImpactFile[];
    blastRadius: BlastRadiusEntry[];
    onPrompt: (text: string) => void;
  }

  let { files, blastRadius, onPrompt }: ImpactTabsProps = $props();

  // ── Tab state ─────────────────────────────────────────────────────────────

  let activeTab = $state<"high-impact" | "violations" | "critical-deps">("high-impact");

  // ── Tab A: High Impact ────────────────────────────────────────────────────

  let highImpactFiles = $derived(
    files
      .filter(f => (f.priority_score ?? 0) >= 15)
      .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
  );

  let maxScore = $derived(
    highImpactFiles.length > 0
      ? Math.max(...highImpactFiles.map(f => f.priority_score ?? 0))
      : 1
  );

  // ── Tab B: Violations ─────────────────────────────────────────────────────

  interface FlatViolation {
    filePath: string;
    inDegree: number;
    violation: Violation;
  }

  const SEVERITY_ORDER: Record<string, number> = {
    "rule": 0,
    "strong-opinion": 1,
    "convention": 2,
  };

  let flatViolations = $derived(
    files
      .flatMap(f =>
        (f.violations ?? []).map((v): FlatViolation => ({
          filePath: f.path,
          inDegree: f.priority_factors?.in_degree ?? 0,
          violation: v,
        }))
      )
      .sort((a, b) => {
        const severityDiff =
          (SEVERITY_ORDER[a.violation.severity] ?? 99) -
          (SEVERITY_ORDER[b.violation.severity] ?? 99);
        if (severityDiff !== 0) return severityDiff;
        return b.inDegree - a.inDegree;
      })
  );

  // ── Tab C: Critical Deps ──────────────────────────────────────────────────

  interface CriticalDep {
    path: string;
    changedFileDependents: string[];
  }

  let changedFilePaths = $derived(new Set(files.map(f => f.path)));

  let criticalDeps = $derived.by((): CriticalDep[] => {
    // Collect all affected paths from blast radius that are NOT in the diff
    const depMap = new Map<string, string[]>();

    for (const entry of blastRadius) {
      for (const affected of entry.affected) {
        if (!changedFilePaths.has(affected.path)) {
          const existing = depMap.get(affected.path) ?? [];
          if (!existing.includes(entry.file)) {
            existing.push(entry.file);
          }
          depMap.set(affected.path, existing);
        }
      }
    }

    return [...depMap.entries()].map(([path, dependents]) => ({
      path,
      changedFileDependents: dependents,
    }));
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function depRelationship(dep: CriticalDep): string {
    const count = dep.changedFileDependents.length;
    if (count === 1) {
      const dependent = dep.changedFileDependents[0];
      const name = dependent.split("/").pop() ?? dependent;
      return `used by ${name}`;
    }
    return `used by ${count} changed files`;
  }

  function depRiskAnnotation(dep: CriticalDep): string | undefined {
    return dep.changedFileDependents.length > 1
      ? `affects ${dep.changedFileDependents.length} changed files`
      : undefined;
  }
</script>

<div class="impact-tabs">
  <!-- ── Tab bar ──────────────────────────────────────────────────────────── -->
  <div class="tab-bar">
    <button
      class="tab-btn"
      class:active={activeTab === "high-impact"}
      onclick={() => (activeTab = "high-impact")}
    >
      High impact
      {#if highImpactFiles.length > 0}
        <span class="tab-count">{highImpactFiles.length}</span>
      {/if}
    </button>
    <button
      class="tab-btn"
      class:active={activeTab === "violations"}
      onclick={() => (activeTab = "violations")}
    >
      Violations
      {#if flatViolations.length > 0}
        <span class="tab-count tab-count-danger">{flatViolations.length}</span>
      {/if}
    </button>
    <button
      class="tab-btn"
      class:active={activeTab === "critical-deps"}
      onclick={() => (activeTab = "critical-deps")}
    >
      Critical deps
      {#if criticalDeps.length > 0}
        <span class="tab-count">{criticalDeps.length}</span>
      {/if}
    </button>
  </div>

  <!-- ── Tab A: High Impact ─────────────────────────────────────────────── -->
  {#if activeTab === "high-impact"}
    <div class="tab-content">
      {#if highImpactFiles.length === 0}
        <div class="empty-state">No high-impact files in this PR</div>
      {:else}
        <div class="file-list">
          {#each highImpactFiles as file (file.path)}
            <ImpactRow
              filePath={file.path}
              priorityScore={file.priority_score ?? 0}
              {maxScore}
              depCount={file.priority_factors?.in_degree ?? 0}
              bucket={file.bucket}
              {onPrompt}
            />
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- ── Tab B: Violations ──────────────────────────────────────────────── -->
  {#if activeTab === "violations"}
    <div class="tab-content">
      {#if flatViolations.length === 0}
        <div class="empty-state">No violations found</div>
      {:else}
        <div class="file-list">
          {#each flatViolations as item (`${item.filePath}:${item.violation.principle_id}`)}
            <ViolationCard
              filePath={item.filePath}
              principleId={item.violation.principle_id}
              severity={item.violation.severity}
              description={item.violation.message}
              {onPrompt}
            />
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- ── Tab C: Critical Deps ───────────────────────────────────────────── -->
  {#if activeTab === "critical-deps"}
    <div class="tab-content">
      {#if criticalDeps.length === 0}
        <div class="empty-state">No critical external dependencies</div>
      {:else}
        <div class="file-list">
          {#each criticalDeps as dep (dep.path)}
            <DepRow
              filePath={dep.path}
              relationship={depRelationship(dep)}
              riskAnnotation={depRiskAnnotation(dep)}
              {onPrompt}
            />
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .impact-tabs {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-height: 0;
  }

  /* ── Tab bar ─────────────────────────────────────────────────────────────── */

  .tab-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 12px 0;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.06));
    flex-shrink: 0;
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted, #636a80);
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s;
    border-radius: 3px 3px 0 0;
    margin-bottom: -1px;
  }

  .tab-btn:hover {
    color: var(--text, #b4b8c8);
    background: var(--bg-card, rgba(255,255,255,0.06));
  }

  .tab-btn.active {
    color: var(--accent, #6c8cff);
    border-bottom-color: var(--accent, #6c8cff);
    font-weight: 600;
  }

  .tab-count {
    font-size: 10px;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--bg-card, rgba(255,255,255,0.06));
    color: var(--text-muted, #636a80);
  }

  .tab-count-danger {
    background: rgba(255, 107, 107, 0.12);
    color: var(--danger, #ff6b6b);
  }

  /* ── Tab content ─────────────────────────────────────────────────────────── */

  .tab-content {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .file-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* ── Empty state ─────────────────────────────────────────────────────────── */

  .empty-state {
    padding: 32px;
    text-align: center;
  }
</style>
