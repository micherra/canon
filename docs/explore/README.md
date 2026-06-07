# Canon Explore — Design Explorations and Proposals

This directory holds design explorations, competed proposals, and research documents that informed or may inform Canon's architecture. Unlike `docs/reference/` (authoritative, stable) and `docs/supervised-build-quality.md` (directional roadmap), `explore/` documents represent the reasoning behind decisions and open questions under investigation.

## Contents

| Directory / File | What it is |
|---|---|
| **[workflow-integration/](workflow-integration/)** | Complete artifacts from the 2026-06-07 design competition: how the Claude Code `Workflow` tool integrates into Canon. 3 proposals, 3 judge reports, ratified synthesis. **Start with [workflow-integration/SYNTHESIS.md](workflow-integration/SYNTHESIS.md).** |
| **[adaptive-queen.md](adaptive-queen.md)** | Exploration of an adaptive orchestrator model (parked; see context in project memory). |
| **[automatic-craft-prerequisites-scoping.md](automatic-craft-prerequisites-scoping.md)** | Analysis of automatic prerequisite scoping for craft audits. |

## Using these documents

Explore documents vary in status:

- **Ratified** (like `workflow-integration/SYNTHESIS.md`): a decision was made and recorded; the SYNTHESIS supersedes proposals for implementation purposes.
- **Parked** (like `adaptive-queen.md`): analysis is complete but no implementation decision was made.
- **Open** (like `automatic-craft-prerequisites-scoping.md`): still under consideration.

When referencing these documents in implementation work, check the document's own status section to understand how authoritative it is.
