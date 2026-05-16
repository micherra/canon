/**
 * generate-review-html.ts
 *
 * Generates a self-contained HTML snapshot of a PR review.
 *
 * Canon principles:
 *   - functions-do-one-thing: generateReviewHtml does exactly one thing —
 *     transforms UnifiedPrOutput into an HTML string. Each section helper
 *     does one thing: renders its section.
 *   - validate-at-trust-boundaries: escapeHtml is the trust boundary — all
 *     user-provided data passes through it before HTML embedding.
 *   - compose-from-small-to-large: the main function composes section helpers
 *     into the full page; each helper mirrors a Svelte component.
 */

import type {
  BlastRadiusFileEntry,
  PrRecommendation,
  Subsystem,
  UnifiedPrOutput,
} from "./show-pr-impact.ts";

// ── Color constants (from constants.ts — hardcoded, no import) ───────────────

const VERDICT_COLORS: Record<string, string> = {
  BLOCKING: "#e74c3c",
  CLEAN: "#27ae60",
  WARNING: "#f39c12",
};

const SEVERITY_COLORS: Record<string, string> = {
  convention: "#3498db",
  rule: "#e74c3c",
  "strong-opinion": "#f39c12",
};

// ── Severity ordering for fallback sort ─────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = { convention: 2, rule: 0, "strong-opinion": 1 };

// ── Trust boundary ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pluralize(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function basename(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? file;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function barWidth(value: number, max: number): string {
  if (max === 0) return "0%";
  return `${Math.round((value / max) * 100)}%`;
}

function severityLabel(severity: string): string {
  if (severity === "rule") return "rule";
  if (severity === "strong-opinion") return "opinion";
  return "convention";
}

/** Hash-based HSL color for layer names — mirrors getLayerColor from constants.ts */
function layerColor(layer: string): string {
  let hash = 0;
  for (let i = 0; i < layer.length; i++) {
    hash = (hash * 31 + layer.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 62%, 56%)`;
}

// ── Inline CSS ────────────────────────────────────────────────────────────────

function buildStyles(): string {
  return `<style>
/* ── Design tokens (from base.css) ─────────────────────────────────────── */
:root {
  --bg: #0c0f1a;
  --bg-surface: rgba(255, 255, 255, 0.03);
  --bg-card: rgba(255, 255, 255, 0.06);
  --bg-card-hover: rgba(255, 255, 255, 0.09);
  --text: #b4b8c8;
  --text-muted: #636a80;
  --text-bright: #e8eaf0;
  --accent: #6c8cff;
  --accent-soft: rgba(108, 140, 255, 0.12);
  --accent-glow: rgba(108, 140, 255, 0.25);
  --border: rgba(255, 255, 255, 0.06);
  --border-subtle: rgba(255, 255, 255, 0.04);
  --danger: #ff6b6b;
  --warning: #fbbf24;
  --success: #34d399;
  --info: #60a5fa;
  --radius: 12px;
  --radius-lg: 16px;
  --radius-sm: 8px;
  --shadow: 0 1px 3px rgba(0, 0, 0, 0.3), 0 4px 12px rgba(0, 0, 0, 0.2);
  --shadow-lg: 0 4px 24px rgba(0, 0, 0, 0.4);
}

/* ── Reset ───────────────────────────────────────────────────────────────── */
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ── Verdict Banner ──────────────────────────────────────────────────────── */
.verdict-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  font-size: 13px;
}
.verdict-badge {
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.06em;
  padding: 3px 9px;
  border-radius: 4px;
  white-space: nowrap;
  color: #fff;
  flex-shrink: 0;
}
.verdict-headline {
  color: var(--text-bright, #e8eaf0);
  flex: 1;
  line-height: 1.4;
}

/* ── Stats Row ───────────────────────────────────────────────────────────── */
.stats-row {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
}
.stat-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  background: var(--bg-card);
  border-radius: 6px;
  border: 1px solid var(--border);
  min-width: 0;
}
.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-bright, #e8eaf0);
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-value--danger { color: var(--danger, #ff6b6b); }
.stat-value--muted { color: var(--text-muted, #636a80); }
.stat-value--file {
  font-size: 14px;
  font-family: monospace;
  padding-top: 5px;
}
.stat-label {
  font-size: 11px;
  color: var(--text-muted, #636a80);
}

/* ── Dashboard Grid ──────────────────────────────────────────────────────── */
.dashboard-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 8px 12px 16px;
}
.grid-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  min-width: 0;
}
.grid-card--stack {
  display: flex;
  flex-direction: column;
}

/* ── Section titles ──────────────────────────────────────────────────────── */
.section-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-bright, #e8eaf0);
  margin: 0 0 10px 0;
  letter-spacing: 0.02em;
}
.section-title--upper {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-muted, #636a80);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 12px;
}

/* ── Fix Before Merge ────────────────────────────────────────────────────── */
.fix-before-merge {
  padding: 12px 16px;
}
.violation-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.violation-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-card);
  border-radius: 6px;
  border: 1px solid var(--border);
}
.item-number {
  font-size: 11px;
  font-weight: 700;
  min-width: 16px;
  flex-shrink: 0;
  padding-top: 1px;
}
.item-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.file-path-text {
  font-size: 11px;
  font-family: monospace;
  color: var(--text-bright, #e8eaf0);
  word-break: break-all;
}
.badge-message-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.principle-badge {
  font-size: 9px;
  font-weight: 600;
  white-space: nowrap;
  letter-spacing: 0.02em;
  opacity: 0.85;
}
.item-message {
  font-size: 12px;
  color: var(--text-muted, #636a80);
  line-height: 1.4;
}
.overflow-note {
  font-size: 11px;
  color: var(--text-muted, #636a80);
  margin: 6px 0 0;
  text-align: center;
}
.empty-note {
  font-size: 12px;
  color: var(--text-muted, #636a80);
  padding: 8px 0;
}

/* ── Violations by Principle ─────────────────────────────────────────────── */
.violations-by-principle {
  padding: 12px 16px;
}
.group-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.group-item {
  border-radius: 6px;
  border: 1px solid var(--border);
  overflow: hidden;
}
.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-card);
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
  font-family: monospace;
  color: var(--text-bright, #e8eaf0);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-count-text {
  font-size: 11px;
  color: var(--text-muted, #636a80);
  white-space: nowrap;
  flex-shrink: 0;
}
.file-list {
  list-style: none;
  border-top: 1px solid var(--border);
}
.file-list-item {
  font-size: 11px;
  font-family: monospace;
  color: var(--text-muted, #636a80);
  padding: 5px 12px 5px 28px;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.04));
  word-break: break-all;
}

/* ── Compliance Score ────────────────────────────────────────────────────── */
.compliance-score {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.bar-label {
  width: 80px;
  flex-shrink: 0;
  color: var(--text-bright, #e8eaf0);
}
.bar-count {
  width: 36px;
  flex-shrink: 0;
  color: var(--text-muted, #636a80);
  font-size: 11px;
  text-align: right;
}
.bar-track {
  flex: 1;
  height: 8px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 4px;
}
.honored-section {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.honored-label {
  font-size: 11px;
  color: var(--text-muted, #636a80);
  font-weight: 600;
}
.honored-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.honored-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 10px;
  background: rgba(52, 211, 153, 0.18);
  color: var(--success, #34d399);
  border: 1px solid rgba(52, 211, 153, 0.35);
  white-space: nowrap;
  letter-spacing: 0.02em;
}

/* ── Blast Radius Chart ──────────────────────────────────────────────────── */
.blast-radius-chart {
  padding: 12px 16px;
}
.chart-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chart-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.file-name {
  width: 140px;
  flex-shrink: 0;
  color: var(--text-bright, #e8eaf0);
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dep-count {
  width: 28px;
  flex-shrink: 0;
  color: var(--text-muted, #636a80);
  text-align: right;
  font-size: 10px;
}

/* ── Layer Chart ─────────────────────────────────────────────────────────── */
.layer-chart {
  padding: 12px 16px;
}
.layer-name {
  width: 100px;
  flex-shrink: 0;
  color: var(--text-bright, #e8eaf0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

/* ── Subsystems Panel ────────────────────────────────────────────────────── */
.subsystems-panel {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.subsystem-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.subsystem-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.directory-text {
  flex: 1;
  color: var(--text-bright, #e8eaf0);
  font-family: monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.label-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.label-new {
  background: rgba(52, 211, 153, 0.18);
  color: var(--success, #34d399);
  border: 1px solid rgba(52, 211, 153, 0.35);
}
.label-removed {
  background: rgba(255, 107, 107, 0.18);
  color: var(--danger, #ff6b6b);
  border: 1px solid rgba(255, 107, 107, 0.35);
}
.subsystem-file-count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-muted, #636a80);
  white-space: nowrap;
}
</style>`;
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderVerdictBanner(data: UnifiedPrOutput): string {
  const review = data.review!;
  const verdict = review.verdict;
  const accentColor = VERDICT_COLORS[verdict] ?? "#888888";

  const fileCount = review.files.length;
  const layerCount = data.prep.layers.length;
  const violationCount = review.violations.length;
  const ruleViolationCount = review.violations.filter((v) => v.severity === "rule").length;

  const filePart =
    fileCount === 0
      ? "No files changed"
      : `${fileCount} ${pluralize(fileCount, "file")} across ${layerCount} ${pluralize(layerCount, "layer")}`;

  let headline: string;
  if (ruleViolationCount === 0 && violationCount === 0) {
    headline = `${filePart} — no violations. Ready to merge.`;
  } else if (ruleViolationCount === 0 && violationCount > 0) {
    headline = `${filePart} — ${violationCount} ${pluralize(violationCount, "violation")}. No blocking issues, but ${violationCount} ${pluralize(violationCount, "violation")} need${violationCount === 1 ? "s" : ""} addressing.`;
  } else {
    const fixPart = `${ruleViolationCount} ${pluralize(ruleViolationCount, "violation")} to fix before merge`;
    headline = `${filePart} — ${fixPart}.`;
  }

  const bgColor = `${accentColor}26`; // 15% opacity approx
  return `<div class="verdict-banner" style="background: ${bgColor}; border-bottom: 1px solid ${accentColor};">
  <span class="verdict-badge" style="background: ${accentColor};">${verdict}</span>
  <span class="verdict-headline">${headline}</span>
</div>`;
}

function renderStatsRow(data: UnifiedPrOutput): string {
  const review = data.review!;
  const filesChanged = review.files.length;
  const violationCount = review.violations.length;
  const ruleCount = review.violations.filter((v) => v.severity === "rule").length;
  const highestBlastRadius =
    data.blast_radius_by_file.length > 0 ? data.blast_radius_by_file[0] : null;

  const violationClass = violationCount > 0 ? " stat-value--danger" : "";
  const ruleClass = ruleCount > 0 ? " stat-value--danger" : "";

  let blastCard: string;
  if (highestBlastRadius) {
    const name = escapeHtml(basename(highestBlastRadius.file));
    const fullPath = escapeHtml(highestBlastRadius.file);
    blastCard = `<span class="stat-value stat-value--file" title="${fullPath}">${name}</span>
    <span class="stat-label">highest blast radius (${highestBlastRadius.dep_count} deps)</span>`;
  } else {
    blastCard = `<span class="stat-value stat-value--muted">None</span>
    <span class="stat-label">highest blast radius</span>`;
  }

  return `<div class="stats-row">
  <div class="stat-card">
    <span class="stat-value">${filesChanged}</span>
    <span class="stat-label">files changed</span>
  </div>
  <div class="stat-card">
    <span class="stat-value${violationClass}">${violationCount}</span>
    <span class="stat-label">violations</span>
  </div>
  <div class="stat-card">
    <span class="stat-value${ruleClass}">${ruleCount}</span>
    <span class="stat-label">rule-level</span>
  </div>
  <div class="stat-card">
    ${blastCard}
  </div>
</div>`;
}

type FixItem =
  | { type: "recommendation"; rec: PrRecommendation }
  | {
      type: "violation";
      v: { file_path?: string; principle_id: string; severity: string; message?: string };
    };

function renderFixItem(item: FixItem, i: number): string {
  let color: string;
  let fileHtml = "";
  let badgeHtml: string;
  let messageHtml = "";

  if (item.type === "recommendation") {
    color = item.rec.source === "principle" ? SEVERITY_COLORS.rule : "#6c8cff";
    if (item.rec.file_path) {
      fileHtml = `<span class="file-path-text">${escapeHtml(item.rec.file_path)}</span>`;
    }
    badgeHtml = `<span class="principle-badge" style="color: ${color};">${escapeHtml(item.rec.title)}</span>`;
    messageHtml = `<span class="item-message">${escapeHtml(item.rec.message)}</span>`;
  } else {
    color = SEVERITY_COLORS[item.v.severity] ?? "#888888";
    if (item.v.file_path) {
      fileHtml = `<span class="file-path-text">${escapeHtml(item.v.file_path)}</span>`;
    }
    badgeHtml = `<span class="principle-badge" style="color: ${color};">${escapeHtml(item.v.principle_id)}</span>`;
    if (item.v.message) {
      messageHtml = `<span class="item-message">${escapeHtml(item.v.message)}</span>`;
    }
  }

  return `<li class="violation-item">
      <span class="item-number" style="color: ${color};">${i + 1}</span>
      <div class="item-body">
        ${fileHtml}
        <div class="badge-message-row">
          ${badgeHtml}
          ${messageHtml}
        </div>
      </div>
    </li>`;
}

function resolveFixItems(data: UnifiedPrOutput): { items: FixItem[]; totalCount: number } {
  const review = data.review!;
  const recommendations = data.recommendations;
  if (recommendations && recommendations.length > 0) {
    return {
      items: recommendations.slice(0, 5).map((rec) => ({ rec, type: "recommendation" as const })),
      totalCount: recommendations.length,
    };
  }
  const sorted = [...review.violations].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3),
  );
  return {
    items: sorted.slice(0, 5).map((v) => ({ type: "violation" as const, v })),
    totalCount: review.violations.length,
  };
}

function renderFixBeforeMerge(data: UnifiedPrOutput): string {
  const { items, totalCount } = resolveFixItems(data);

  let listHtml: string;
  if (items.length === 0) {
    listHtml = `<p class="empty-note">No violations — looking good.</p>`;
  } else {
    const itemsHtml = items.map(renderFixItem).join("\n");
    const overflowHtml =
      totalCount > 5
        ? `<p class="overflow-note">Showing top 5 of ${totalCount} suggestions</p>`
        : "";
    listHtml = `<ol class="violation-list">
${itemsHtml}
</ol>${overflowHtml}`;
  }

  return `<section class="fix-before-merge">
  <h2 class="section-title">Fix Before Merge</h2>
  ${listHtml}
</section>`;
}

type PrincipleGroup = { principleId: string; severity: string; files: string[] };

/** Update the severity of an existing group to the worst observed value. */
function worstenSeverity(group: PrincipleGroup, incomingSeverity: string): void {
  if (incomingSeverity === "rule" && group.severity !== "rule") {
    group.severity = "rule";
  } else if (incomingSeverity === "strong-opinion" && group.severity === "convention") {
    group.severity = "strong-opinion";
  }
}

/** Add a file path to a group's files list if not already present. */
function addFileToGroup(group: PrincipleGroup, filePath: string | undefined): void {
  if (filePath && !group.files.includes(filePath)) {
    group.files.push(filePath);
  }
}

function groupViolationsByPrinciple(
  violations: Array<{ principle_id: string; severity: string; file_path?: string }>,
): PrincipleGroup[] {
  const map = new Map<string, PrincipleGroup>();
  for (const v of violations) {
    const existing = map.get(v.principle_id);
    if (!existing) {
      map.set(v.principle_id, {
        files: v.file_path ? [v.file_path] : [],
        principleId: v.principle_id,
        severity: v.severity,
      });
    } else {
      worstenSeverity(existing, v.severity);
      addFileToGroup(existing, v.file_path);
    }
  }
  return Array.from(map.values());
}

function renderPrincipleGroup(group: PrincipleGroup): string {
  const color = SEVERITY_COLORS[group.severity] ?? "#888888";
  const badgeBg = `${color}22`;
  const badgeBorder = `${color}44`;
  const fileCountText = `${group.files.length} ${group.files.length === 1 ? "file" : "files"}`;
  const filesHtml =
    group.files.length > 0
      ? `<ul class="file-list">
${group.files.map((f) => `    <li class="file-list-item">${escapeHtml(f)}</li>`).join("\n")}
  </ul>`
      : "";

  return `<li class="group-item">
    <div class="group-header">
      <span class="severity-badge" style="background: ${badgeBg}; color: ${color}; border-color: ${badgeBorder};">${severityLabel(group.severity)}</span>
      <span class="principle-id">${escapeHtml(group.principleId)}</span>
      <span class="file-count-text">${fileCountText}</span>
    </div>
    ${filesHtml}
  </li>`;
}

function renderViolationsByPrinciple(
  violations: Array<{
    principle_id: string;
    severity: string;
    file_path?: string;
    message?: string;
  }>,
): string {
  if (violations.length === 0) {
    return `<section class="violations-by-principle">
  <h2 class="section-title">Violations by Principle</h2>
  <p class="empty-note">No violations found.</p>
</section>`;
  }

  const groups = groupViolationsByPrinciple(violations);
  const groupsHtml = groups.map(renderPrincipleGroup).join("\n");

  return `<section class="violations-by-principle">
  <h2 class="section-title">Violations by Principle</h2>
  <ul class="group-list">
${groupsHtml}
  </ul>
</section>`;
}

function renderComplianceScore(
  score: {
    rules: { passed: number; total: number };
    opinions: { passed: number; total: number };
    conventions: { passed: number; total: number };
  },
  honored: string[],
): string {
  const hasData = score.rules.total > 0 || score.opinions.total > 0 || score.conventions.total > 0;

  if (!hasData) {
    return `<div class="compliance-score">
  <div class="section-title--upper">Compliance Score</div>
  <div class="empty-note">No compliance data</div>
</div>`;
  }

  function computeBarColor(passed: number, total: number, baseColor: string): string {
    return passed === total ? "#34d399" : baseColor;
  }

  const rulesWidth = barWidth(score.rules.passed, score.rules.total);
  const rulesColor = computeBarColor(score.rules.passed, score.rules.total, SEVERITY_COLORS.rule);
  const opinionsWidth = barWidth(score.opinions.passed, score.opinions.total);
  const opinionsColor = computeBarColor(
    score.opinions.passed,
    score.opinions.total,
    SEVERITY_COLORS["strong-opinion"],
  );
  const conventionsWidth = barWidth(score.conventions.passed, score.conventions.total);
  const conventionsColor = computeBarColor(
    score.conventions.passed,
    score.conventions.total,
    SEVERITY_COLORS.convention,
  );

  const honoredHtml =
    honored.length > 0
      ? `<div class="honored-section">
    <span class="honored-label">Honored Principles</span>
    <div class="honored-badges">
      ${honored.map((p) => `<span class="honored-badge">&#10003; ${escapeHtml(p)}</span>`).join("\n      ")}
    </div>
  </div>`
      : "";

  return `<div class="compliance-score">
  <div class="section-title--upper">Compliance Score</div>
  <div class="bars">
    <div class="bar-row">
      <span class="bar-label">Rules</span>
      <span class="bar-count">${score.rules.passed}/${score.rules.total}</span>
      <div class="bar-track"><div class="bar-fill" style="width: ${rulesWidth}; background: ${rulesColor};"></div></div>
    </div>
    <div class="bar-row">
      <span class="bar-label">Opinions</span>
      <span class="bar-count">${score.opinions.passed}/${score.opinions.total}</span>
      <div class="bar-track"><div class="bar-fill" style="width: ${opinionsWidth}; background: ${opinionsColor};"></div></div>
    </div>
    <div class="bar-row">
      <span class="bar-label">Conventions</span>
      <span class="bar-count">${score.conventions.passed}/${score.conventions.total}</span>
      <div class="bar-track"><div class="bar-fill" style="width: ${conventionsWidth}; background: ${conventionsColor};"></div></div>
    </div>
  </div>
  ${honoredHtml}
</div>`;
}

function renderBlastRadiusChart(entries: BlastRadiusFileEntry[]): string {
  if (entries.length === 0) {
    return `<div class="blast-radius-chart">
  <div class="section-title--upper">Highest Blast Radius (Watch These)</div>
  <div class="empty-note">No blast radius data</div>
</div>`;
  }

  const maxDepCount = Math.max(...entries.map((e) => e.dep_count));
  const rowsHtml = entries
    .map((entry) => {
      const width = barWidth(entry.dep_count, maxDepCount);
      const name = escapeHtml(truncate(basename(entry.file), 25));
      const fullPath = escapeHtml(entry.file);
      return `<div class="chart-row" title="${fullPath}">
      <span class="file-name">${name}</span>
      <div class="bar-track"><div class="bar-fill" style="width: ${width}; background: var(--accent, #6c8cff);"></div></div>
      <span class="dep-count">${entry.dep_count}</span>
    </div>`;
    })
    .join("\n");

  return `<div class="blast-radius-chart">
  <div class="section-title--upper">Highest Blast Radius (Watch These)</div>
  <div class="chart-rows">
${rowsHtml}
  </div>
</div>`;
}

function renderLayerChart(
  layers: Array<{ name: string; file_count: number; color?: string }>,
): string {
  if (!layers || layers.length === 0) {
    return `<div class="layer-chart">
  <div class="section-title--upper">Changes by Layer</div>
  <div class="empty-note">No layer data</div>
</div>`;
  }

  const maxCount = Math.max(...layers.map((l) => l.file_count));
  const rowsHtml = layers
    .map((layer) => {
      const width = barWidth(layer.file_count, maxCount);
      const color = layer.color ?? layerColor(layer.name ?? "unknown");
      const name = escapeHtml(layer.name);
      return `<div class="chart-row">
      <span class="layer-name" title="${name}">${name}</span>
      <div class="bar-track"><div class="bar-fill" style="width: ${width}; background: ${color}; opacity: 0.85;"></div></div>
      <span class="dep-count">${layer.file_count}</span>
    </div>`;
    })
    .join("\n");

  return `<div class="layer-chart">
  <div class="section-title--upper">Changes by Layer</div>
  <div class="chart-rows">
${rowsHtml}
  </div>
</div>`;
}

function renderSubsystemsPanel(subsystems: Subsystem[]): string {
  if (subsystems.length === 0) {
    return `<div class="subsystems-panel">
  <div class="section-title--upper">New Subsystems Added</div>
  <div class="empty-note">No new subsystems detected</div>
</div>`;
  }

  const rowsHtml = subsystems
    .map((sub) => {
      const dir = escapeHtml(sub.directory);
      const labelClass = sub.label === "new" ? "label-new" : "label-removed";
      const fileWord = sub.file_count === 1 ? "file" : "files";
      return `<div class="subsystem-row">
      <span class="directory-text" title="${dir}">${dir}</span>
      <span class="label-badge ${labelClass}">${sub.label}</span>
      <span class="subsystem-file-count">${sub.file_count} ${fileWord}</span>
    </div>`;
    })
    .join("\n");

  return `<div class="subsystems-panel">
  <div class="section-title--upper">New Subsystems Added</div>
  <div class="subsystem-list">
${rowsHtml}
  </div>
</div>`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Transform UnifiedPrOutput into a complete self-contained HTML document.
 *
 * Pure function — no I/O, no side effects.
 * Returns a minimal "no review data" page when data.review is absent.
 */
export function generateReviewHtml(data: UnifiedPrOutput): string {
  if (!data.review) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Review</title>
${buildStyles()}
</head>
<body>
<div style="display: flex; align-items: center; justify-content: center; min-height: 100vh; color: var(--text-muted, #636a80); font-size: 13px;">
  No review data available
</div>
</body>
</html>`;
  }

  const verdictBanner = renderVerdictBanner(data);
  const statsRow = renderStatsRow(data);
  const fixBeforeMerge = renderFixBeforeMerge(data);
  const violationsByPrinciple = renderViolationsByPrinciple(data.review.violations);
  const complianceScore = renderComplianceScore(data.review.score, data.review.honored);
  const blastRadiusChart = renderBlastRadiusChart(data.blast_radius_by_file);
  const layerChart = renderLayerChart(data.prep.layers);
  const subsystemsPanel = renderSubsystemsPanel(data.subsystems);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Review — ${data.review.verdict}</title>
${buildStyles()}
</head>
<body>
${verdictBanner}
${statsRow}
<div class="dashboard-grid">
  <div class="grid-card">
    ${fixBeforeMerge}
  </div>
  <div class="grid-card grid-card--stack">
    ${violationsByPrinciple}
    ${complianceScore}
  </div>
  <div class="grid-card">
    ${blastRadiusChart}
  </div>
  <div class="grid-card grid-card--stack">
    ${layerChart}
    ${subsystemsPanel}
  </div>
</div>
</body>
</html>`;
}
