<script lang="ts">
/**
 * FilePath.svelte
 *
 * Renders a file path with the directory prefix muted and the filename
 * portion highlighted in bold. Uses `splitFilePath` from utils so the
 * splitting logic is centralised and consistent across the codebase.
 *
 * Canon principles:
 *   - compose-from-small-to-large: atom component, replaces inline splits
 *   - props-are-the-component-contract: no bridge access, no global state
 *   - single-source-of-truth: delegates path splitting to utils.splitFilePath
 */

import { splitFilePath } from "../lib/utils";

interface FilePathProps {
  path: string;
}

let { path }: FilePathProps = $props();

let _parts = $derived(splitFilePath(path));
</script>

<span class="file-path">
  {#if parts.dir}
    <span class="dir-part">{parts.dir}</span>
  {/if}
  <span class="file-name">{parts.name}</span>
</span>

<style>
  .file-path {
    font-family: monospace;
    font-size: 11px;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .dir-part {
    color: var(--text-muted, #636a80);
  }

  .file-name {
    font-weight: 700;
    color: var(--text-bright, #e8eaf0);
  }
</style>
