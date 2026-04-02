<script lang="ts">
/**
 * ViolationsByPrinciple.svelte
 *
 * Groups violations by principle_id and displays each group with a severity
 * badge and file count. Expanding shows individual file paths within the group.
 * Pure presentation — no data fetching, no store access.
 *
 * Canon principles:
 *   - functions-do-one-thing: renders violations-by-principle panel only
 *   - compose-from-small-to-large: standalone leaf; composed by PrReview.svelte
 */

interface Violation {
  principle_id: string;
  severity: string;
  file_path?: string;
  message?: string;
}

interface PrincipleGroup {
  principleId: string;
  severity: string;
  files: string[];
}

interface ViolationsByPrincipleProps {
  violations: Violation[];
  onPrompt?: (text: string) => void;
}

// biome-ignore lint/correctness/noUnusedVariables: used in Svelte template
let { violations, onPrompt }: ViolationsByPrincipleProps = $props();

function promoteWorstSeverity(existing: PrincipleGroup, incoming: string): void {
  if (incoming === "rule" && existing.severity !== "rule") {
    existing.severity = "rule";
  } else if (incoming === "strong-opinion" && existing.severity === "convention") {
    existing.severity = "strong-opinion";
  }
}

/** Group violations by principle_id; keep worst severity per principle */
const _groups = $derived.by(() => {
  const map = new Map<string, PrincipleGroup>();

  for (const v of violations) {
    const existing = map.get(v.principle_id);
    if (!existing) {
      map.set(v.principle_id, {
        principleId: v.principle_id,
        severity: v.severity,
        files: v.file_path ? [v.file_path] : [],
      });
    } else {
      promoteWorstSeverity(existing, v.severity);
      if (v.file_path && !existing.files.includes(v.file_path)) {
        existing.files.push(v.file_path);
      }
    }
  }

  return Array.from(map.values());
});

/** Track which groups are expanded (by principle_id) */
let expanded = $state<Set<string>>(new Set());

function _toggle(principleId: string): void {
  if (expanded.has(principleId)) {
    expanded.delete(principleId);
  } else {
    expanded.add(principleId);
  }
  // Reassign to trigger reactivity
  expanded = new Set(expanded);
}

function _severityLabel(severity: string): string {
  if (severity === "rule") return "rule";
  if (severity === "strong-opinion") return "opinion";
  return "convention";
}
</script>

<section class="violations-by-principle">
  <h2 class="section-title">Violations by Principle</h2>

  {#if groups.length === 0}
    <p class="empty">No violations found.</p>
  {:else}
    <ul class="group-list">
      {#each groups as group (group.principleId)}
        {@const color = getSeverityColor(group.severity)}
        {@const isExpanded = expanded.has(group.principleId)}

        <li class="group-item">
          <button
            class="group-header btn-reset"
            onclick={() => toggle(group.principleId)}
            aria-expanded={isExpanded}
          >
            <span
              class="severity-badge"
              style="background: {color}22; color: {color}; border-color: {color}44;"
            >
              {severityLabel(group.severity)}
            </span>
            <span class="principle-id">{group.principleId}</span>
            <span class="file-count">{group.files.length} {group.files.length === 1 ? "file" : "files"}</span>
            <span class="chevron" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
          </button>

          {#if isExpanded && group.files.length > 0}
            <ul class="file-list">
              {#each group.files as file (file)}
                <li class="file-path">
                  {#if onPrompt}
                    <button
                      class="file-btn btn-reset"
                      onclick={() => onPrompt(`Explain the ${group.principleId} violation in ${file} and how to fix it`)}
                    >{file}</button>
                  {:else}
                    {file}
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .violations-by-principle {
    padding: 12px 16px;
  }

  .section-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--text, #e0e0e0);
    margin: 0 0 10px 0;
    letter-spacing: 0.02em;
  }

  .empty {
    font-size: 12px;
    color: var(--text-muted, #888);
    margin: 0;
    padding: 8px 0;
  }

  .group-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .group-item {
    border-radius: 6px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.07));
    overflow: hidden;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    width: 100%;
    background: var(--bg-card, rgba(255, 255, 255, 0.04));
    transition: background 0.1s;
    cursor: pointer;
  }

  .group-header:hover {
    background: var(--bg-hover, rgba(255, 255, 255, 0.08));
  }

  .severity-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid transparent;
    white-space: nowrap;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .principle-id {
    font-size: 12px;
    font-weight: 600;
    font-family: var(--font-mono, monospace);
    color: var(--text, #e0e0e0);
    flex: 1;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-count {
    font-size: 11px;
    color: var(--text-muted, #888);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .chevron {
    font-size: 10px;
    color: var(--text-muted, #888);
    flex-shrink: 0;
    width: 10px;
    text-align: center;
  }

  .file-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--border, rgba(255, 255, 255, 0.07));
  }

  .file-path {
    font-size: 11px;
    font-family: var(--font-mono, monospace);
    color: var(--text-muted, #888);
    padding: 5px 12px 5px 28px;
    border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.04));
    word-break: break-all;
  }

  .file-btn {
    width: 100%;
    text-align: left;
    font-size: 11px;
    font-family: var(--font-mono, monospace);
    color: var(--text-muted, #888);
    cursor: pointer;
    padding: 0;
    word-break: break-all;
    transition: color 0.1s;
  }

  .file-btn:hover {
    color: var(--accent, #6c8cff);
  }

  .file-path:last-child {
    border-bottom: none;
  }
</style>
