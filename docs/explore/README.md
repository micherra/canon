# Canon Explore — Design Explorations and Proposals

This directory holds design explorations, competed proposals, and research documents that informed or may inform Canon's architecture. Unlike `docs/reference/` (authoritative, stable) and `docs/supervised-build-quality.md` (directional roadmap), `explore/` documents represent the reasoning behind decisions and open questions under investigation.

## Contents

| Directory / File | What it is |
|---|---|
| **[workflow-integration/](workflow-integration/)** | Complete artifacts from the 2026-06-07 design competition: how the Claude Code `Workflow` tool integrates into Canon. 3 proposals, 3 judge reports, ratified synthesis. **Start with [workflow-integration/SYNTHESIS.md](workflow-integration/SYNTHESIS.md).** |
| **[rlm-followups/](rlm-followups/)** | Decided 6-item self-improvement program derived from the RLM article (isaacflath.com/writing/rlm). Decided via adversarial architect panel; reframed as "subtraction, not unification." Phase 0 (seam convention) is in progress. **Start with [rlm-followups/PROGRAM.md](rlm-followups/PROGRAM.md).** |
| **[adaptive-queen.md](adaptive-queen.md)** | Exploration of an adaptive orchestrator model (parked; see context in project memory). |
| **[automatic-craft-prerequisites-scoping.md](automatic-craft-prerequisites-scoping.md)** | Analysis of automatic prerequisite scoping for craft audits. |
| **[orchestrator-scoped-principle-measurement-gap.md](orchestrator-scoped-principle-measurement-gap.md)** | Open: the 23-principle zero-citation measurement gap (decision recorded in ADR-0035) and the deferred orchestration-trace self-review surface (Option B) as its long-term fix. |
| **[compilation-gradient.md](compilation-gradient.md)** | Open: pressure-tests the "compilation gradient" framing (PAW paper) against Canon's fuzzy→deterministic architecture; recommends a three-tier execution gradient and one probe-build. The recommended probe ran (see `docs/t2-probe-results.md` — INCONCLUSIVE, 0/96 retrievable). |

## Using these documents

Explore documents vary in status:

- **Ratified** (like `workflow-integration/SYNTHESIS.md`): a decision was made and recorded; the SYNTHESIS supersedes proposals for implementation purposes.
- **Parked** (like `adaptive-queen.md`): analysis is complete but no implementation decision was made.
- **Open** (like `automatic-craft-prerequisites-scoping.md`): still under consideration.

When referencing these documents in implementation work, check the document's own status section to understand how authoritative it is.
