# learning/

Closes the leak where a shipped learning proposal orphans in "pending" state
forever (ADR-0049). Two pieces:

- **`actionability.ts`** — the shared classifier that decides whether a
  proposal is actionable backlog work or a passive tracking/observation
  artifact. Reads both frontmatter formats the proposal corpus uses (YAML
  `type:` and legacy bold `**Type**:`).
- **`reconcile-learnings.ts`** — the `reconcile_learnings` MCP tool. Scans the
  `.canon/proposed-learnings/{timestamp}/` review surface, auto-moves
  actionable proposals whose target already shipped to `applied/`, and
  auto-archives stale informational-only sets to `stale/`. Idempotent,
  fail-open, append-only, move-never-delete.

See `.claude/CLAUDE.md` for contract details and invariants.
