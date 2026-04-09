# Canon Docs — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-09 -->
Human-readable project documentation, architecture references, and historical analysis. Docs are written for human engineers and architects, not for agent consumption (use CLAUDE.md files for agents).

## Architecture
<!-- last-updated: 2026-04-09 -->

- `reference/` — Authoritative reference documentation; `canon-reference.md` is the single comprehensive reference covering MCP tool tables, flow schema, hooks, and principles
- Standalone documents in the root cover architecture analysis, roadmaps, and retrospectives (e.g., `bounded-context-map.md`, `codebase-intelligence-roadmap.md`)
- `images/` — Diagrams and screenshots referenced by documentation

## Conventions
<!-- last-updated: 2026-04-09 -->

- Docs are for humans — prefer prose and tables over code snippets
- CLAUDE.md files are for agents — do not conflate the two audiences
- `canon-reference.md` is the canonical source of truth for MCP tool signatures; update it when tools change
- Historical and retrospective documents (lessons learned, improvement plans) are kept for context even after their recommendations are implemented