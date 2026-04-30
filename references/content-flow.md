# Content Flow

The content flow is a lightweight workspace-creating pattern for Canon intents that edit tracked files but do not require the full build-flow step set. It shares the same runbook-vocabulary step IDs as build flows (see `references/runbook-vocabulary.md`) but omits steps that apply only to code: `design`, `test`, `security`, and `spike`.

---

## Purpose

Any Canon intent that edits a tracked file belongs in a workspace-creating flow so that:

1. There is an auditable record of what changed and why.
2. L4 (the active-workspace hook) can verify the change is part of a sanctioned flow.
3. The mandatory tail (`context-sync`, `learn`) runs, keeping Canon's documentation and principles current.

The content flow is the workspace-creating mechanism for three non-build intents:

| Intent | Variant | Spawning agent |
|--------|---------|----------------|
| `principle` | `content-flow/principle` | `writer` |
| `learn` (application mode) | `content-flow/learn-apply` | `writer` (receives accepted proposal from learner) |
| `docs` | `content-flow/docs` | (future; engineer in content-authoring mode) |

> **Note on `init_workspace`:** As of this writing, `init_workspace` defaults to a build-intent workspace layout. Full `intent_class` support (`build` | `principle` | `learn` | `docs`) needs to be added in a follow-up task (MCP server files are out of scope here). The behavioral contract defined in this document is the authoritative spec; the MCP tool will catch up. Until then, orchestrators calling `init_workspace` for a content flow should use a slug that signals the variant (e.g., `principle-<slug>`, `learn-apply-<slug>`).

---

## Step Sequence

Every content-flow runbook follows this sequence:

```
research → implement → review → context-sync → learn
```

All step IDs come from `references/runbook-vocabulary.md` (Version 1.0). No new step IDs are introduced by this pattern.

### Step details

| Step | Default agent | HITL | Notes |
|------|---------------|------|-------|
| `research` | planner | none | Investigate existing principles, prior learnings, coverage gaps. May be skipped for trivial edits (one-line corrections). |
| `implement` | writer | none | Content-authoring mode. The writer edits the target file(s) and produces an `implementation-log.md`. No code is written. The writer handles all principle edits — including those originating from learner proposals — to ensure conflict detection and format validation run consistently. |
| `review` | reviewer | checkpoint | Principle compliance and factual correctness of the edited content. |
| `context-sync` | scribe | none | Mandatory tail — update CLAUDE.md, context.md, CONVENTIONS.md if contract-level changes occurred. |
| `learn` | learner | none | Mandatory tail — pattern analysis from the completed flow. |

### Differences from build flows

| Build flow | Content flow |
|-----------|--------------|
| `design` step (architect) | Omitted — no architectural decisions needed for content edits |
| `implement` (code, TDD) | `implement` with content-authoring skill — agent uses Write/Edit tools on md files |
| `test` step (tester) | Omitted — no automated tests for markdown |
| `security` step | Omitted — content edits have no security surface |
| `spike` step | Omitted |
| `pre-launch-check` step | Omitted |
| `ship` step | Omitted (no PR; content lands directly) |

---

## Workspace Layout

Standard Canon workspace at `.canon/workspaces/<slug>/` with the following artifacts:

```
.canon/workspaces/<slug>/
├── journal.json                     # Step log (same schema as build flows)
├── plans/
│   └── <slug>/
│       └── implementation-log.md    # What file(s) were edited and why
└── context.md                       # Workspace context for agent spawns
```

The `implementation-log.md` is the primary artifact. It must document:
- Which file(s) were edited
- What changed (before / after summary, not full diff)
- The intent that triggered the flow (principle edit, learning application, docs update)
- Status: DONE / DONE_WITH_CONCERNS / BLOCKED

---

## Variant Specifications

### `content-flow/principle` — writer agent

Triggered by: user request to create or edit a principle, convention, or agent-rule.

- The orchestrator calls `init_workspace` with a slug derived from the principle ID (e.g., `principle-errors-are-values`).
- The `implement` step spawns the `writer` agent.
- The writer receives the workspace path in its spawn prompt and produces `implementation-log.md` upon completion.
- All existing writer modes (new-principle, new-agent-rule, edit) continue to work within this flow.

### `content-flow/learn-apply` — writer applying accepted learner proposal

Triggered by: user acceptance of a proposal from `.canon/proposed-learnings/` and request to apply it.

- The learner's role ends at proposal generation (mining mode). It writes structured proposals to `.canon/proposed-learnings/` — it never edits principle or convention files.
- When the user accepts a proposal, the orchestrator creates a workspace and spawns the `writer` with the accepted proposal as context. The writer applies the change using its full pipeline: conflict detection, format validation, severity checks, and implementation logging.
- The writer receives the proposal file path in its spawn prompt and produces `implementation-log.md`.

### `content-flow/docs` (future)

Triggered by: documentation-only edits (`docs/*.md`, `references/*.md`, etc.).

Not yet active. When added, the `implement` step will spawn an engineer with `skills: [content-authoring]` or the writer depending on the doc type. This variant follows the same sequence and workspace layout.

---

## Orchestrator Protocol

When routing a `principle`, `learn` (application), or `docs` intent under `CANON_AGENT_TEAMS_MODE=on`:

1. Call `init_workspace({ flow_name: "content-flow", task: "<description>", tier: "fast-path", ... })`.
2. Determine which variant applies (see table above).
3. Call `log_step` for each planned step.
4. Spawn the `research` step if the intent is non-trivial.
5. Spawn the `implement` step with the appropriate agent (writer or learner).
6. Run the mandatory tail: `context-sync`, then `learn`.
7. Call `verify_completion` and `update_board`.

The MCP tool composition table in CLAUDE.md applies to each step type (e.g., call `get_principles` before the `implement` spawn).
