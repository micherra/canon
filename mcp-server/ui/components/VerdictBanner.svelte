<script lang="ts">
/**
 * VerdictBanner.svelte
 *
 * Full-width colored banner with verdict badge and a descriptive headline
 * summarizing the PR review outcome. Replaces VerdictStrip (dd-01).
 *
 * Canon principles:
 *   - functions-do-one-thing: renders verdict banner only
 *   - compose-from-small-to-large: standalone leaf; composed by PrReview.svelte
 */

import { VERDICT_COLORS } from "../lib/constants";
import { pluralize } from "../lib/utils";

interface VerdictBannerProps {
  verdict: "BLOCKING" | "WARNING" | "CLEAN";
  fileCount: number;
  layerCount: number;
  violationCount: number;
  ruleViolationCount: number;
}

let { verdict, fileCount, layerCount, violationCount, ruleViolationCount }: VerdictBannerProps = $props();

const _accentColor = $derived(VERDICT_COLORS[verdict] ?? "#888888");

const _headline = $derived.by(() => {
  const filePart =
    fileCount === 0
      ? "No files changed"
      : `${fileCount} ${pluralize(fileCount, "file")} across ${layerCount} ${pluralize(layerCount, "layer")}`;

  if (ruleViolationCount === 0 && violationCount === 0) {
    return `${filePart} — no violations. Ready to merge.`;
  }

  const fixPart =
    ruleViolationCount === 0
      ? "No blocking issues"
      : `${ruleViolationCount} ${pluralize(ruleViolationCount, "violation")} to fix before merge`;

  if (ruleViolationCount === 0 && violationCount > 0) {
    return `${filePart} — ${violationCount} ${pluralize(violationCount, "violation")}. No blocking issues, but ${violationCount} ${pluralize(violationCount, "violation")} need${violationCount === 1 ? "s" : ""} addressing.`;
  }

  return `${filePart} — ${fixPart}.`;
});
</script>

<div
  class="verdict-banner"
  data-verdict={verdict}
  style:--accent={accentColor}
>
  <span class="verdict-badge">{verdict}</span>
  <span class="headline">{headline}</span>
</div>

<style>
  .verdict-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border-bottom: 1px solid var(--accent);
    font-size: 13px;
    flex-shrink: 0;
  }

  .verdict-badge {
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.06em;
    padding: 3px 9px;
    border-radius: 4px;
    white-space: nowrap;
    background: var(--accent);
    color: #fff;
    flex-shrink: 0;
  }

  .headline {
    color: var(--text, #e0e0e0);
    flex: 1;
    line-height: 1.4;
  }
</style>
