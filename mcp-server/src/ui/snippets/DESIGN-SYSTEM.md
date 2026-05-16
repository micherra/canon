# Canon HTML Artifact Design System

This file is the authoritative design system reference for agents composing HTML artifacts.
Read this file before writing any HTML output. All artifacts must use the tokens, patterns,
and security rules documented here.

---

## Section A: CSS Design Tokens

All artifacts start with these CSS custom properties in a `:root {}` block. Copy this block
verbatim into your `<style>` tag before any component styles.

```css
:root {
  /* ── Backgrounds ─────────────────────────────────────────────── */
  --bg: #0c0f1a;                           /* Page background */
  --bg-surface: rgba(255, 255, 255, 0.03); /* Subtle surface lift (alternating rows, inset areas) */
  --bg-card: rgba(255, 255, 255, 0.06);    /* Card background */
  --bg-card-hover: rgba(255, 255, 255, 0.09); /* Card hover state */

  /* ── Text ────────────────────────────────────────────────────── */
  --text: #b4b8c8;         /* Body text */
  --text-muted: #636a80;   /* Secondary / de-emphasized text */
  --text-bright: #e8eaf0;  /* Headings, labels, emphasized values */

  /* ── Accent ──────────────────────────────────────────────────── */
  --accent: #6c8cff;                       /* Primary accent (links, bars, focus) */
  --accent-soft: rgba(108, 140, 255, 0.12); /* Soft accent fill */
  --accent-glow: rgba(108, 140, 255, 0.25); /* Accent glow/shadow */

  /* ── Borders ─────────────────────────────────────────────────── */
  --border: rgba(255, 255, 255, 0.06);        /* Standard border */
  --border-subtle: rgba(255, 255, 255, 0.04); /* Very subtle dividers */

  /* ── Semantic colors ─────────────────────────────────────────── */
  --danger: #ff6b6b;   /* Errors, rule-level violations, blocking status */
  --warning: #fbbf24;  /* Warnings, strong-opinion violations */
  --success: #34d399;  /* Success states, honored principles, clean verdict */
  --info: #60a5fa;     /* Informational, convention violations */

  /* ── Shape ───────────────────────────────────────────────────── */
  --radius: 12px;      /* Standard border radius */
  --radius-lg: 16px;   /* Large radius (modals, full-page cards) */
  --radius-sm: 8px;    /* Small radius (inner cards, badges) */

  /* ── Shadows ─────────────────────────────────────────────────── */
  --shadow: 0 1px 3px rgba(0, 0, 0, 0.3), 0 4px 12px rgba(0, 0, 0, 0.2);
  --shadow-lg: 0 4px 24px rgba(0, 0, 0, 0.4);
}
```

---

## Section B: Page Boilerplate

Use this HTML shell as the starting point for every artifact. Fill in `{Artifact Title}` and
the component styles.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{Artifact Title}</title>
  <style>
    /* 1. Paste design tokens from Section A */
    /* 2. Reset */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
    /* 3. Component styles here */
  </style>
</head>
<body>
  <div class="container">
    <!-- Content here -->
  </div>
</body>
</html>
```

**Note**: The review dashboard does NOT use `.container`. See Section F for its full-width layout.

---

## Section C: Component Patterns

### Section Card

A card with a titled header and body content area. Use for grouping related information.

```css
.section-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.section-card-header {
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border);
}
.section-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-bright);
  margin: 0;
  letter-spacing: 0.02em;
}
.section-card-body {
  padding: 14px 16px;
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
}
```

```html
<div class="section-card">
  <div class="section-card-header">
    <h2 class="section-title">Section Title</h2>
  </div>
  <div class="section-card-body">
    <!-- body content -->
  </div>
</div>
```

### Collapsible Section

CSS-only disclosure widget using `<details>/<summary>`. No JavaScript required.

```css
.collapsible-section {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.collapsible-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.collapsible-summary::-webkit-details-marker { display: none; }
.collapsible-arrow {
  font-size: 9px;
  color: var(--text-muted);
  transition: transform 0.15s ease;
  display: inline-block;
}
details[open] .collapsible-arrow { transform: rotate(90deg); }
.collapsible-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-bright);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.collapsible-body {
  padding: 10px 14px 14px;
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}
```

```html
<details class="collapsible-section">
  <summary class="collapsible-summary">
    <span class="collapsible-arrow">&#9654;</span>
    <span class="collapsible-title">Section Title</span>
  </summary>
  <div class="collapsible-body">
    <!-- body content -->
  </div>
</details>
```

### Tables

Compact data tables with alternating row backgrounds and a scroll wrapper for narrow viewports.

```css
.table-scroll-wrapper {
  overflow-x: auto;
  border-radius: 8px;
  border: 1px solid var(--border);
}
.requirement-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  background: var(--bg-card);
}
.requirement-table th {
  padding: 8px 12px;
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-bright);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.requirement-table td {
  padding: 7px 12px;
  color: var(--text);
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  line-height: 1.4;
}
.requirement-table tbody tr:last-child td { border-bottom: none; }
.requirement-table tbody tr:nth-child(even) td { background: var(--bg-surface); }
```

### Disposition Badges (for coverage tables)

Color-code requirement/criterion dispositions using these badge classes:

```css
.disposition {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
  letter-spacing: 0.03em;
}
.disposition--covered  { background: rgba(52,211,153,0.15); color: var(--success); border: 1px solid rgba(52,211,153,0.3); }
.disposition--descoped { background: rgba(251,191,36,0.15);  color: var(--warning); border: 1px solid rgba(251,191,36,0.3); }
.disposition--partial  { background: rgba(96,165,250,0.15);  color: var(--info);    border: 1px solid rgba(96,165,250,0.3); }
```

Values: `covered` (success green), `descoped` (warning amber), `partial` (info blue).

### Severity Badges

Color-code principle severity using these badge patterns:

```css
.severity-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid transparent;
  white-space: nowrap;
  letter-spacing: 0.03em;
}
```

Severity color mapping (see Section F for hex constants):
- `rule` → `#e74c3c` (danger red)
- `strong-opinion` → `#f39c12` (warning amber)
- `convention` → `#3498db` (info blue)

Apply as inline styles: `style="background: ${color}22; color: ${color}; border-color: ${color}44;"`

### Stats Row

A flex row of stat cards for summary metrics.

```css
.stats-row { display: flex; gap: 12px; padding: 12px 16px; }
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
  color: var(--text-bright);
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-value--danger { color: var(--danger); }
.stat-value--muted  { color: var(--text-muted); }
.stat-value--file   { font-size: 14px; font-family: monospace; padding-top: 5px; }
.stat-label { font-size: 11px; color: var(--text-muted); }
```

### Section Titles (uppercase variant)

Used for sub-section headers inside dashboard grid cards:

```css
.section-title--upper {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 12px;
}
```

---

## Section D: Snippet Catalog

All 8 snippet files in `mcp-server/src/ui/snippets/`. Each file has a structured docblock
with `@snippet`, `@description`, `@data`, `@tokens`, and `@usage` tags.

| File | Description | Placeholders | Usage |
|------|-------------|--------------|-------|
| `verdict-banner.html` | Full-width colored banner with verdict badge and headline | `{{VERDICT}}`, `{{HEADLINE}}`, `{{ACCENT_COLOR}}` | Top of page; no container wrapper |
| `stats-card.html` | Single stat card with large value and label | `{{VALUE}}`, `{{LABEL}}` | Place multiple in `.stats-row` flex container |
| `bar-chart-row.html` | Horizontal bar chart row: label, bar, value | `{{LABEL}}`, `{{WIDTH_PERCENT}}`, `{{VALUE}}`, `{{BAR_COLOR}}` | Stack in `.chart-rows` flex-column |
| `severity-badge.html` | Inline severity badge with color-coded background | `{{SEVERITY}}`, `{{LABEL}}`, `{{COLOR}}` | Inline inside violation lists or group headers |
| `compliance-bars.html` | Three-row compliance bar chart (rules/opinions/conventions) | `{{RULES_PASSED}}`, `{{RULES_TOTAL}}`, `{{RULES_WIDTH}}`, `{{OPINIONS_PASSED}}`, `{{OPINIONS_TOTAL}}`, `{{OPINIONS_WIDTH}}`, `{{CONVENTIONS_PASSED}}`, `{{CONVENTIONS_TOTAL}}`, `{{CONVENTIONS_WIDTH}}` | Inside compliance score section |
| `collapsible-section.html` | CSS-only `<details>/<summary>` with Canon styling | `{{TITLE}}`, `{{CONTENT}}` | Any collapsible content area |
| `requirement-table.html` | Coverage table with color-coded dispositions | `{{TABLE_ROWS}}` | Planning brief requirement coverage maps |
| `section-card.html` | Card container with titled header and body | `{{TITLE}}`, `{{CONTENT}}` | Generic content grouping |

### Composition Pattern

Agents compose artifacts by:
1. Reading the relevant snippet file(s)
2. Substituting `{{PLACEHOLDER}}` values (all user data through `escapeHtml` first)
3. Extracting HTML markup (strip docblock comment and `<style>` blocks)
4. Extracting CSS styles (extract `<style>` block contents)
5. Building the full page with design tokens + extracted styles + assembled markup

---

## Section E: Security Requirements

### escapeHtml Implementation

Implement this function inline in any code that generates HTML. Use it on EVERY piece of
user-provided data before embedding in HTML output.

```typescript
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

### Rule: All User-Provided Data Must Be Escaped

**All user-provided data (file paths, descriptions, names, messages, principle IDs) MUST pass
through `escapeHtml` before embedding in HTML.**

This includes data from:
- Markdown artifacts (planning briefs, design documents, reviews)
- File paths from git diff output
- Principle IDs and messages from principle violations
- Any text that originates from user input or external systems

**Never embed raw strings directly in HTML template literals.** There are no exceptions.

### Trust Boundary Pattern

The trust boundary is at the point where external data enters the HTML template:

```typescript
// CORRECT: escape at the boundary
const safeFilePath = escapeHtml(violation.file_path ?? "");
const html = `<span class="file-path">${safeFilePath}</span>`;

// WRONG: raw string in template
const html = `<span class="file-path">${violation.file_path}</span>`;
```

---

## Section F: Review Dashboard Patterns

The review dashboard is the most complex artifact. It uses a full-width layout with a
2-column grid. Reviewer agents use this section to compose `generateReviewHtml`-equivalent
output without access to the source TypeScript.

### F.1 Color Constants

```typescript
const VERDICT_COLORS: Record<string, string> = {
  BLOCKING: "#e74c3c",
  CLEAN:    "#27ae60",
  WARNING:  "#f39c12",
};

const SEVERITY_COLORS: Record<string, string> = {
  rule:             "#e74c3c",
  "strong-opinion": "#f39c12",
  convention:       "#3498db",
};

const SEVERITY_ORDER: Record<string, number> = {
  rule:             0,
  "strong-opinion": 1,
  convention:       2,
};
```

### F.2 Page Structure

The review dashboard does **NOT** use a `.container` wrapper. The verdict banner and stats
row span the full viewport width. Below them is the `.dashboard-grid`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PR Review — {VERDICT}</title>
  <style>/* Full CSS from F.6 */</style>
</head>
<body>
  {verdictBanner}
  {statsRow}
  <div class="dashboard-grid">
    <div class="grid-card">
      {fixBeforeMerge}
    </div>
    <div class="grid-card grid-card--stack">
      {violationsByPrinciple}
      {complianceScore}
    </div>
    <div class="grid-card">
      {blastRadiusChart}
    </div>
    <div class="grid-card grid-card--stack">
      {layerChart}
      {subsystemsPanel}
    </div>
  </div>
</body>
</html>
```

### F.3 Verdict Banner

Full-width colored banner. Background is the verdict color at ~15% opacity (`${color}26`).

```html
<div class="verdict-banner" style="background: ${accentColor}26; border-bottom: 1px solid ${accentColor};">
  <span class="verdict-badge" style="background: ${accentColor};">{VERDICT}</span>
  <span class="verdict-headline">{HEADLINE}</span>
</div>
```

**Headline format**: `"{fileCount} files across {layerCount} layers — {violation summary}."`

- Zero violations: `"N files across L layers — no violations. Ready to merge."`
- Advisory only (no rule violations): `"N files — M violations. No blocking issues, but M violations need addressing."`
- Rule violations: `"N files across L layers — R violations to fix before merge."`

### F.4 Stats Row

4 stat cards in a flex `.stats-row`. Use `.stat-value--danger` when the value is non-zero for violations:

```html
<div class="stats-row">
  <div class="stat-card">
    <span class="stat-value">{filesChanged}</span>
    <span class="stat-label">files changed</span>
  </div>
  <div class="stat-card">
    <span class="stat-value{violationDangerClass}">{violationCount}</span>
    <span class="stat-label">violations</span>
  </div>
  <div class="stat-card">
    <span class="stat-value{ruleDangerClass}">{ruleCount}</span>
    <span class="stat-label">rule-level</span>
  </div>
  <div class="stat-card">
    <!-- When blast radius data exists: -->
    <span class="stat-value stat-value--file" title="{fullPath}">{filename}</span>
    <span class="stat-label">highest blast radius ({depCount} deps)</span>
    <!-- When no blast radius data: -->
    <!-- <span class="stat-value stat-value--muted">None</span>
    <span class="stat-label">highest blast radius</span> -->
  </div>
</div>
```

`violationDangerClass` = `" stat-value--danger"` when `violationCount > 0`, else `""`.
`ruleDangerClass` = `" stat-value--danger"` when `ruleCount > 0`, else `""`.

### F.5 Dashboard Grid Layout

`.dashboard-grid` is a 2-column CSS grid:

```css
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
```

Grid layout (row × column):

| | Left | Right |
|---|---|---|
| **Row 1** | "Fix Before Merge" (numbered violation list, top 5) | "Violations by Principle" (grouped) + "Compliance Score" (stacked) |
| **Row 2** | "Highest Blast Radius" bar chart | "Changes by Layer" bar chart + "New Subsystems" panel (stacked) |

### F.6 Fix Before Merge Section

Shows top 5 violations sorted by severity (rule first, then strong-opinion, then convention).
When `recommendations` array is present and non-empty, shows those instead of raw violations.

```html
<section class="fix-before-merge">
  <h2 class="section-title">Fix Before Merge</h2>
  <!-- When violations exist: -->
  <ol class="violation-list">
    <li class="violation-item">
      <span class="item-number" style="color: {severityColor};">{index + 1}</span>
      <div class="item-body">
        <span class="file-path-text">{escapeHtml(filePath)}</span>
        <div class="badge-message-row">
          <span class="principle-badge" style="color: {severityColor};">{escapeHtml(principleId)}</span>
          <span class="item-message">{escapeHtml(message)}</span>
        </div>
      </div>
    </li>
  </ol>
  <!-- When >5 total violations: -->
  <p class="overflow-note">Showing top 5 of {totalCount} suggestions</p>
  <!-- When zero violations: -->
  <!-- <p class="empty-note">No violations — looking good.</p> -->
</section>
```

CSS classes used:
- `.fix-before-merge` — section wrapper with `padding: 12px 16px`
- `.violation-list` — `list-style: none; display: flex; flex-direction: column; gap: 8px`
- `.violation-item` — flex row: number + body; `padding: 10px 12px; background: var(--bg-card); border-radius: 6px`
- `.item-number` — colored by severity, `font-size: 11px; font-weight: 700; min-width: 16px`
- `.item-body` — flex column, `gap: 4px`
- `.file-path-text` — `font-family: monospace; font-size: 11px; color: var(--text-bright)`
- `.badge-message-row` — flex column, `gap: 4px`
- `.principle-badge` — `font-size: 9px; font-weight: 600; letter-spacing: 0.02em`
- `.item-message` — `font-size: 12px; color: var(--text-muted)`
- `.overflow-note` — `font-size: 11px; color: var(--text-muted); text-align: center`
- `.empty-note` — `font-size: 12px; color: var(--text-muted)`

### F.7 Violations by Principle Section

Groups violations by `principle_id`, then renders each group as a list item.

```html
<section class="violations-by-principle">
  <h2 class="section-title">Violations by Principle</h2>
  <!-- When violations exist: -->
  <ul class="group-list">
    <li class="group-item">
      <div class="group-header">
        <span class="severity-badge" style="background: {color}22; color: {color}; border-color: {color}44;">
          {severityLabel}
        </span>
        <span class="principle-id">{escapeHtml(principleId)}</span>
        <span class="file-count-text">{fileCount} files</span>
      </div>
      <ul class="file-list">
        <li class="file-list-item">{escapeHtml(filePath)}</li>
      </ul>
    </li>
  </ul>
  <!-- When no violations: -->
  <!-- <p class="empty-note">No violations found.</p> -->
</section>
```

`severityLabel`: `rule` → `"rule"`, `strong-opinion` → `"opinion"`, `convention` → `"convention"`.

When multiple violations share a `principle_id`, the group severity is set to the worst
observed (`rule` > `strong-opinion` > `convention`). File paths are deduplicated.

CSS classes:
- `.violations-by-principle` — `padding: 12px 16px`
- `.group-list` — `list-style: none; flex-direction: column; gap: 6px`
- `.group-item` — `border-radius: 6px; border: 1px solid var(--border); overflow: hidden`
- `.group-header` — flex row; `padding: 8px 12px; background: var(--bg-card)`
- `.principle-id` — `font-family: monospace; font-size: 12px; font-weight: 600; color: var(--text-bright)`
- `.file-count-text` — `font-size: 11px; color: var(--text-muted); white-space: nowrap`
- `.file-list` — `list-style: none; border-top: 1px solid var(--border)`
- `.file-list-item` — `font-family: monospace; font-size: 11px; color: var(--text-muted); padding: 5px 12px 5px 28px`

### F.8 Compliance Score Section

Three bar rows for rules, opinions, and conventions. Stacked below Violations by Principle.

```html
<div class="compliance-score">
  <div class="section-title--upper">Compliance Score</div>
  <!-- When data exists: -->
  <div class="bars">
    <div class="bar-row">
      <span class="bar-label">Rules</span>
      <span class="bar-count">{passed}/{total}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width: {width}%; background: {color};"></div>
      </div>
    </div>
    <!-- Repeat for Opinions and Conventions -->
  </div>
  <!-- Honored principles badges (when honored list is non-empty): -->
  <div class="honored-section">
    <span class="honored-label">Honored Principles</span>
    <div class="honored-badges">
      <span class="honored-badge">&#10003; {escapeHtml(principleId)}</span>
    </div>
  </div>
  <!-- When no data: -->
  <!-- <div class="empty-note">No compliance data</div> -->
</div>
```

Bar color logic: if `passed === total`, use `#34d399` (success); else use the severity color
(`rule` → `#e74c3c`, `strong-opinion` → `#f39c12`, `convention` → `#3498db`).

Bar width formula: `Math.round((passed / total) * 100) + "%"`. Use `"0%"` when `total === 0`.

CSS classes:
- `.compliance-score` — `padding: 12px 16px; border-top: 1px solid var(--border)`
- `.bars` — `flex-direction: column; gap: 8px`
- `.bar-row` — flex row; `font-size: 12px; gap: 8px`
- `.bar-label` — `width: 80px; flex-shrink: 0; color: var(--text-bright)`
- `.bar-count` — `width: 36px; text-align: right; font-size: 11px; color: var(--text-muted)`
- `.bar-track` — `flex: 1; height: 8px; background: rgba(255,255,255,0.08); border-radius: 4px; overflow: hidden`
- `.bar-fill` — `height: 100%; border-radius: 4px`
- `.honored-section` — `margin-top: 14px; flex-direction: column; gap: 6px`
- `.honored-label` — `font-size: 11px; color: var(--text-muted); font-weight: 600`
- `.honored-badges` — `flex-wrap: wrap; gap: 4px`
- `.honored-badge` — `font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; background: rgba(52,211,153,0.18); color: var(--success); border: 1px solid rgba(52,211,153,0.35)`

### F.9 Blast Radius Chart Section

Bar chart of files sorted by downstream dependency count (highest first).

```html
<div class="blast-radius-chart">
  <div class="section-title--upper">Highest Blast Radius (Watch These)</div>
  <!-- When data exists: -->
  <div class="chart-rows">
    <div class="chart-row" title="{escapeHtml(fullPath)}">
      <span class="file-name">{escapeHtml(truncatedBasename)}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width: {width}%; background: var(--accent, #6c8cff);"></div>
      </div>
      <span class="dep-count">{depCount}</span>
    </div>
  </div>
  <!-- When no data: -->
  <!-- <div class="empty-note">No blast radius data</div> -->
</div>
```

`truncatedBasename`: take the filename (last path segment), truncate to 25 chars with `"..."`.
Bar width formula: `Math.round((depCount / maxDepCount) * 100) + "%"`.

CSS classes:
- `.blast-radius-chart` — `padding: 12px 16px`
- `.chart-rows` — `flex-direction: column; gap: 6px`
- `.chart-row` — flex row; `font-size: 11px; gap: 8px`
- `.file-name` — `width: 140px; flex-shrink: 0; font-family: monospace; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap`
- `.dep-count` — `width: 28px; text-align: right; font-size: 10px; color: var(--text-muted)`

### F.10 Layer Chart Section

Bar chart of layers by file count. Color is derived from layer name via hash-based HSL.

```html
<div class="layer-chart">
  <div class="section-title--upper">Changes by Layer</div>
  <!-- When data exists: -->
  <div class="chart-rows">
    <div class="chart-row">
      <span class="layer-name" title="{escapedName}">{escapedName}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width: {width}%; background: {layerColor}; opacity: 0.85;"></div>
      </div>
      <span class="dep-count">{fileCount}</span>
    </div>
  </div>
  <!-- When no data: -->
  <!-- <div class="empty-note">No layer data</div> -->
</div>
```

CSS classes:
- `.layer-chart` — `padding: 12px 16px`
- `.layer-name` — `width: 100px; flex-shrink: 0; font-size: 11px; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap`

### F.11 Subsystems Panel Section

Stacked below the layer chart. Shows new or removed subsystem directories.

```html
<div class="subsystems-panel">
  <div class="section-title--upper">New Subsystems Added</div>
  <!-- When subsystems exist: -->
  <div class="subsystem-list">
    <div class="subsystem-row">
      <span class="directory-text" title="{escapedDir}">{escapedDir}</span>
      <span class="label-badge {labelClass}">{label}</span>
      <span class="subsystem-file-count">{fileCount} files</span>
    </div>
  </div>
  <!-- When no subsystems: -->
  <!-- <div class="empty-note">No new subsystems detected</div> -->
</div>
```

`labelClass`: `"label-new"` when `label === "new"`, `"label-removed"` when `label === "removed"`.

CSS classes:
- `.subsystems-panel` — `padding: 12px 16px; border-top: 1px solid var(--border)`
- `.subsystem-list` — `flex-direction: column; gap: 8px`
- `.subsystem-row` — flex row; `font-size: 12px; gap: 8px`
- `.directory-text` — `flex: 1; font-family: monospace; font-size: 11px; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap`
- `.label-badge` — `font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.04em`
- `.label-new` — `background: rgba(52,211,153,0.18); color: var(--success); border: 1px solid rgba(52,211,153,0.35)`
- `.label-removed` — `background: rgba(255,107,107,0.18); color: var(--danger); border: 1px solid rgba(255,107,107,0.35)`
- `.subsystem-file-count` — `font-size: 11px; color: var(--text-muted); white-space: nowrap`

### F.12 Helper Patterns

Implement these helpers inline when composing the review HTML:

```typescript
/** Escape all user-provided strings before embedding in HTML. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Pluralize a word based on count. */
function pluralize(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** Get the filename from a path. */
function basename(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? file;
}

/** Truncate text to maxLen characters, appending "..." if cut. */
function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

/** Compute a bar width percentage string. Returns "0%" when max is 0. */
function barWidth(value: number, max: number): string {
  if (max === 0) return "0%";
  return `${Math.round((value / max) * 100)}%`;
}

/** Map severity string to display label. */
function severityLabel(severity: string): string {
  if (severity === "rule") return "rule";
  if (severity === "strong-opinion") return "opinion";
  return "convention";
}

/**
 * Hash-based HSL color for layer names.
 * Mirrors getLayerColor from constants.ts — produces stable colors per layer name.
 */
function layerColor(layer: string): string {
  let hash = 0;
  for (let i = 0; i < layer.length; i++) {
    hash = (hash * 31 + layer.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 62%, 56%)`;
}
```

### F.13 Empty State Handling

When a section has no data, render an `.empty-note` paragraph instead of the content:

| Section | Empty message |
|---------|--------------|
| Fix Before Merge | `"No violations — looking good."` |
| Violations by Principle | `"No violations found."` |
| Compliance Score | `"No compliance data"` |
| Blast Radius Chart | `"No blast radius data"` |
| Layer Chart | `"No layer data"` |
| Subsystems Panel | `"No new subsystems detected"` |

### F.14 Full CSS for Review Dashboard

The complete CSS to include in the `<style>` tag of a review dashboard artifact (copy verbatim):

```css
/* Reset */
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* Verdict Banner */
.verdict-banner { display: flex; align-items: center; gap: 12px; padding: 10px 16px; font-size: 13px; }
.verdict-badge { font-weight: 700; font-size: 11px; letter-spacing: 0.06em; padding: 3px 9px; border-radius: 4px; white-space: nowrap; color: #fff; flex-shrink: 0; }
.verdict-headline { color: var(--text-bright, #e8eaf0); flex: 1; line-height: 1.4; }

/* Stats Row */
.stats-row { display: flex; gap: 12px; padding: 12px 16px; }
.stat-card { flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; background: var(--bg-card); border-radius: 6px; border: 1px solid var(--border); min-width: 0; }
.stat-value { font-size: 24px; font-weight: 700; color: var(--text-bright, #e8eaf0); line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-value--danger { color: var(--danger, #ff6b6b); }
.stat-value--muted { color: var(--text-muted, #636a80); }
.stat-value--file { font-size: 14px; font-family: monospace; padding-top: 5px; }
.stat-label { font-size: 11px; color: var(--text-muted, #636a80); }

/* Dashboard Grid */
.dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px 12px 16px; }
.grid-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; min-width: 0; }
.grid-card--stack { display: flex; flex-direction: column; }

/* Section titles */
.section-title { font-size: 13px; font-weight: 700; color: var(--text-bright, #e8eaf0); margin: 0 0 10px 0; letter-spacing: 0.02em; }
.section-title--upper { font-size: 12px; font-weight: 700; color: var(--text-muted, #636a80); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px; }

/* Fix Before Merge */
.fix-before-merge { padding: 12px 16px; }
.violation-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.violation-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; background: var(--bg-card); border-radius: 6px; border: 1px solid var(--border); }
.item-number { font-size: 11px; font-weight: 700; min-width: 16px; flex-shrink: 0; padding-top: 1px; }
.item-body { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.file-path-text { font-size: 11px; font-family: monospace; color: var(--text-bright, #e8eaf0); word-break: break-all; }
.badge-message-row { display: flex; flex-direction: column; gap: 4px; }
.principle-badge { font-size: 9px; font-weight: 600; white-space: nowrap; letter-spacing: 0.02em; opacity: 0.85; }
.item-message { font-size: 12px; color: var(--text-muted, #636a80); line-height: 1.4; }
.overflow-note { font-size: 11px; color: var(--text-muted, #636a80); margin: 6px 0 0; text-align: center; }
.empty-note { font-size: 12px; color: var(--text-muted, #636a80); padding: 8px 0; }

/* Violations by Principle */
.violations-by-principle { padding: 12px 16px; }
.group-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.group-item { border-radius: 6px; border: 1px solid var(--border); overflow: hidden; }
.group-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-card); }
.severity-badge { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; border: 1px solid transparent; white-space: nowrap; letter-spacing: 0.03em; flex-shrink: 0; }
.principle-id { font-size: 12px; font-weight: 600; font-family: monospace; color: var(--text-bright, #e8eaf0); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-count-text { font-size: 11px; color: var(--text-muted, #636a80); white-space: nowrap; flex-shrink: 0; }
.file-list { list-style: none; border-top: 1px solid var(--border); }
.file-list-item { font-size: 11px; font-family: monospace; color: var(--text-muted, #636a80); padding: 5px 12px 5px 28px; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.04)); word-break: break-all; }

/* Compliance Score */
.compliance-score { padding: 12px 16px; border-top: 1px solid var(--border); }
.bars { display: flex; flex-direction: column; gap: 8px; }
.bar-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.bar-label { width: 80px; flex-shrink: 0; color: var(--text-bright, #e8eaf0); }
.bar-count { width: 36px; flex-shrink: 0; color: var(--text-muted, #636a80); font-size: 11px; text-align: right; }
.bar-track { flex: 1; height: 8px; background: rgba(255, 255, 255, 0.08); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; }
.honored-section { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
.honored-label { font-size: 11px; color: var(--text-muted, #636a80); font-weight: 600; }
.honored-badges { display: flex; flex-wrap: wrap; gap: 4px; }
.honored-badge { display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; background: rgba(52,211,153,0.18); color: var(--success, #34d399); border: 1px solid rgba(52,211,153,0.35); white-space: nowrap; letter-spacing: 0.02em; }

/* Blast Radius Chart */
.blast-radius-chart { padding: 12px 16px; }
.chart-rows { display: flex; flex-direction: column; gap: 6px; }
.chart-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.file-name { width: 140px; flex-shrink: 0; color: var(--text-bright, #e8eaf0); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dep-count { width: 28px; flex-shrink: 0; color: var(--text-muted, #636a80); text-align: right; font-size: 10px; }

/* Layer Chart */
.layer-chart { padding: 12px 16px; }
.layer-name { width: 100px; flex-shrink: 0; color: var(--text-bright, #e8eaf0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }

/* Subsystems Panel */
.subsystems-panel { padding: 12px 16px; border-top: 1px solid var(--border); }
.subsystem-list { display: flex; flex-direction: column; gap: 8px; }
.subsystem-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.directory-text { flex: 1; color: var(--text-bright, #e8eaf0); font-family: monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.label-badge { flex-shrink: 0; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.label-new { background: rgba(52,211,153,0.18); color: var(--success, #34d399); border: 1px solid rgba(52,211,153,0.35); }
.label-removed { background: rgba(255,107,107,0.18); color: var(--danger, #ff6b6b); border: 1px solid rgba(255,107,107,0.35); }
.subsystem-file-count { flex-shrink: 0; font-size: 11px; color: var(--text-muted, #636a80); white-space: nowrap; }
```
