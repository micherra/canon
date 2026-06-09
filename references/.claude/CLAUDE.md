# Canon References — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Protocol fragments for the orchestrator and specialist agents. Each file defines a specific protocol, convention, or vocabulary that agents consult at runtime — not documentation for humans, but prescriptive instructions for agents.

## Architecture
<!-- last-updated: 2026-06-05 -->

```
references/
├── canon-artifact-locations.md   # Authoritative naming rules for workspace artifacts
├── canon-orchestrator.md         # Orchestrator protocol (journal, dispatch) — pointers to DAG + HITL refs
├── dag-execution-protocol.md     # Full DAG parallel build protocol (TeamCreate, merge, failure handling)
├── hitl-patterns.md              # Full HITL checkpoint catalog (every mandatory and advisory gate)
├── content-flow.md               # Principle/writer content authoring flow
├── principle-loading.md          # How agents load Canon principles
├── runbook-vocabulary.md         # Runbook step vocabulary and disposition values
├── status-protocol.md            # Agent status reporting (DONE / BLOCKED / etc.)
├── workspace-logging.md          # Journal protocol and workspace logging conventions
└── ...                           # Other protocol fragments
```

## Artifact Inventory
<!-- canon:inventory:start class=references -->
| artifact | summary |
|---|---|
| canon-artifact-locations.md |  |
| canon-orchestrator.md | >- |
| competition-debate.md |  |
| content-flow.md |  |
| context-isolation.md |  |
| dag-execution-protocol.md | >- |
| hitl-patterns.md | >- |
| learner-dimensions.md |  |
| plugin-server-boot.md |  |
| principle-format.md |  |
| principle-loading.md |  |
| principle-tier-routing.md |  |
| runbook-vocabulary.md |  |
| security-checklist.md |  |
| status-protocol.md |  |
| tester-report-template.md |  |
| workspace-logging.md |  |
| writer-worked-example.md |  |
<!-- canon:inventory:end -->

## Conventions
<!-- last-updated: 2026-06-02 -->

**File path accuracy in documentation**: every file path cited in a doc/reference file must resolve from the repo root. Before returning from a doc-authoring task, verify each cited path (or rely on `wiki_lint`'s `cited_paths` check) and correct any that do not resolve. A non-resolving path is a blocking defect caught at review.

Specifically:
- Use paths relative to the repo root (e.g., `mcp-server/src/features/diagnostics/tools/wiki-lint.ts`).
- Do NOT cite hypothetical or illustrative paths as if they were real — wrap them in a fenced block labeled `example` or `hypothetical` so the `cited_paths` lint check skips them.
- Template variables (`${WORKSPACE}/...`, `{slug}-PLAN.md`, `<stem>-SUMMARY.md`) are exempt from path existence checks.
- Bare filenames with no directory component (e.g., `foo.md`) are also exempt.

**Update `<!-- last-updated: YYYY-MM-DD -->` annotations** on any section you modify, so staleness detection (`wiki_lint` doc freshness) stays accurate.

## Verification

- [ ] All concrete file paths cited in this directory resolve from the repo root.
- [ ] Illustrative or hypothetical paths are wrapped in fenced blocks labeled `example`, `hypothetical`, or `template`.
- [ ] `wiki_lint` `cited_paths` check passes with zero new findings after changes.
