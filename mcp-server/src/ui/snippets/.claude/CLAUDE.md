# UI Snippets — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Design system tokens and reusable HTML snippet templates read by renderer agents to compose `design.html`, `review.html`, `codebase-graph.html`, and `file-context.html` artifacts.

## Canonical Renderer Helpers <!-- last-updated: 2026-06-04 -->

**`DESIGN-SYSTEM.md` Section E is the single canonical home for the build-time renderer helpers `escapeHtml` and `markdownToHtml`.**

- Renderer templates reference Section E; they never re-inline these function definitions.
- `escapeHtml` — null-safe `String(s ?? "")` form + 5-replace chain.
- `markdownToHtml` — behavior-preserving union: code fences, h1–h4, ul/ol, bold/italic (`**`, `__`), code-span protection tokens (`\x00CODE{n}\x00`), `file:line` auto-linking, block-grouped paragraph wrapping. Calls `escapeHtml` internally (escape-first) — do NOT pre-escape input.
- The runtime `escHtml` inside `renderer-codebase-graph.md`'s Canvas force-sim IIFE is a separate, deliberate escaper scoped to that IIFE; it is NOT covered by this convention.

## Contents

| File | Purpose |
|------|---------|
| `DESIGN-SYSTEM.md` | Design tokens, component patterns, Section E canonical renderer helpers (`escapeHtml`, `markdownToHtml`) |
| `*.html` | Reusable HTML snippet fragments loaded by renderer agents |
