---
id: snippet-design-system-co-update
title: New Snippet Files Require Corresponding DESIGN-SYSTEM.md Section
severity: convention
scope:
  file_patterns:
    - "mcp-server/src/ui/snippets/**"
  layers: []
tags:
  - ui
  - design-systems
  - documentation
---

Adding a new `.html` file to `mcp-server/src/ui/snippets/` requires adding a
corresponding section to `mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` in the
same build. The section must document: purpose, required data fields, CSS token
dependencies, and a usage example.

## Rationale

`DESIGN-SYSTEM.md` is the authoritative reference for all agents that compose
HTML artifacts. When a snippet is added without a matching section, the next
agent to look up usage patterns will either miss the snippet or invent incorrect
usage. The co-update ensures discoverability stays in sync with the snippet
library.

## Evidence

3 consecutive snippet-addition builds (html-poc, enhanced-review-html,
redesign-file-detail-card-canvas) all updated DESIGN-SYSTEM.md alongside
new snippet files. Pattern confirmed by sug_KK2_promoted (3/3 threshold).
