---
id: snippet-docblock-metadata
title: HTML Snippet Files Require Machine-Readable Docblock
severity: convention
scope:
  file_patterns:
    - "mcp-server/src/ui/snippets/**/*.html"
  layers: []
tags:
  - ui
  - design-systems
  - documentation
---

Every `.html` snippet file in `mcp-server/src/ui/snippets/` must begin with a
`<!--` docblock containing all 5 tags: `@snippet`, `@description`, `@data`,
`@tokens`, `@usage`.

## Rationale

Snippet files are consumed by agent-composed artifact renderers. The docblock
provides machine-readable metadata that renderers use to discover, compose, and
validate snippets at runtime. Without the docblock, a renderer cannot enumerate
the required data fields or CSS token dependencies.

Mechanically enforced by `agent-composition.test.ts` — a non-conformant file
causes test failure.

## Example

```html
<!--
  @snippet stats-card
  @description Compact stat cell with label, value, and trend delta
  @data { label: string; value: number; delta?: number }
  @tokens --text-primary, --surface-raised, --positive, --negative
  @usage Use for summary metrics. Pass delta as null to hide trend arrow.
-->
<style>...</style>
<div class="stats-card">...</div>
```
