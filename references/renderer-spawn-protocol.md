---
name: renderer-spawn-protocol
description: >-
  Full renderer spawn protocol for Canon build checkpoints. Covers the
  per-checkpoint template/output/variables table, MCP tool requirements per
  template, and the dogfood-render obligation when renderer templates or
  consumed snippets are in the diff.
---

# Renderer Spawn Protocol

<!-- Managed by Canon. Manual edits are preserved. -->

**Purpose**: Per-checkpoint template, output path, required variables, and MCP requirements for renderer spawns. Read BEFORE spawning a renderer at any HITL checkpoint. See `CLAUDE.md` § Renderer Spawn Protocol for the inline model-selection rule and spawn pattern.

Read the appropriate template from `templates/renderer-*.md`, fill `## Variables`, pass `## Prompt` section as spawn prompt. Renderer writes to `${WORKSPACE}/artifacts/` and does NOT modify the worktree.

| Checkpoint | Template | Output | Required variables |
|------------|----------|--------|--------------------|
| Design | `renderer-design.md` | `design.html` | `${WORKSPACE}`, `${SLUG}`, `${DESIGN_PATH}`, `${DAG_PATH}`, `${PRD_PATH}`, `${RUNBOOK_PATH}` |
| Review | `renderer-review.md` | `review.html` | `${WORKSPACE}`, `${SLUG}`, `${BASE_COMMIT}`, `${WORKTREE_PATH}` |
| Codebase graph | `renderer-codebase-graph.md` | `codebase-graph.html` | `${WORKSPACE}`, `${SLUG}`, `${DIFF_BASE}`, `${SOURCE_DIRS}` |
| File context | `renderer-file-context.md` | `file-context.html` | `${WORKSPACE}`, `${SLUG}`, `${FILE_PATH}` |

MCP requirements: `renderer-design.md` — none; `renderer-review.md` — `show_pr_impact` + `get_context`; `renderer-codebase-graph.md` — `codebase_graph`; `renderer-file-context.md` — `get_file_context`.

**Dogfood-render obligation (watch_OOOOO2)**: when `git diff {base_commit}..HEAD --name-only` includes `templates/renderer-*.md` or renderer-consumed snippets (`mcp-server/src/ui/snippets/*.html` or `mcp-server/src/ui/snippets/DESIGN-SYSTEM.md`), the mandatory renderer spawn MUST use the changed template/snippet files from the build worktree (not the installed plugin copies) so the build's own review.html is rendered through its own renderer changes before the review step closes; record `dogfood_render: true` in the review step's `log_step` outcome. Builds changing only renderer data inputs (REVIEW.md, DESIGN.md) are exempt.
