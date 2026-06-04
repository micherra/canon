---
template: reference
used-by: [orchestrator, architect, engineer]
read-by: [orchestrator]
---

# Canon Artifact Locations

This is the authoritative reference for every file Canon creates during a build, where it is written, and how it is named. Callers registering `artifacts_expected` paths must derive them from this spec — not from memory or guesswork.

**Key fact**: most Canon artifacts use fixed filenames under predictable directories. Three categories have variable-component filenames: implementation summaries (task-id stem), task plans (task-id stem), and decisions (decision-id stem). Transcripts also vary by step-id/agent/timestamp. See the quick reference table at the bottom for the full breakdown.

---

## Workspace structure

`init_workspace` creates the workspace directory and seeds its standard subdirectories (source: `mcp-server/src/domains/workspaces/workspace.ts`):

```
${WORKSPACE}/
  plans/<slug>/          # all per-build planning artifacts
  reviews/               # code review output
  artifacts/             # HTML reports for browser display
  transcripts/           # per-step JSONL conversation logs
  context.md             # session context (written by architect)
  journal.json           # step journal (managed by harness)
  orchestration.db       # execution store (SQLite, managed by harness)
```

---

## Artifact table

All paths are workspace-relative unless marked **repo-relative** or **external**.

| Artifact | Path | Naming | Producer | Notes |
|----------|------|--------|----------|-------|
| PRD | `plans/<slug>/prd.md` | fixed | PM / orchestrator | Written inline, not by a harness tool |
| Runbook | `plans/<slug>/runbook.md` | fixed | `init_workspace` | Only when `runbook_content` param is supplied |
| Planning brief | `plans/<slug>/planning-brief.md` | fixed | `init_workspace` | Only when `brief_content` param is supplied |
| Design | `plans/<slug>/DESIGN.md` | fixed | architect | Via architect template |
| Plan index | `plans/<slug>/INDEX.md` | fixed | `write_plan_index` | |
| Task DAG | `plans/<slug>/task-dag.yaml` | fixed | architect | Optional; absent for single-task builds |
| Task conventions | `plans/<slug>/CONVENTIONS.md` | fixed | architect | |
| Task plans | `plans/<slug>/<task-id>-PLAN.md` | **task-id variable** | architect | One per DAG node |
| **Implementation summary** | `plans/<slug>/<task_id>-SUMMARY.md` | **task_id variable — stem always matches the `task_id` passed to `write_implementation_summary`** | `write_implementation_summary` | Variable-stem artifact. Use `result.path` or the glob `plans/<slug>/*-SUMMARY.md`. When the caller passes `task_id = slug`, the stem is the slug — but there is no separate slug fallback. See §Registering `artifacts_expected` below. |
| Implementation summary sidecar | `plans/<slug>/<task_id>-SUMMARY.meta.json` | same stem as SUMMARY | `write_implementation_summary` | Machine-readable sidecar |
| Test report | `plans/<slug>/TEST-REPORT.md` | fixed | `write_test_report` / tester agent | |
| Test report sidecar | `plans/<slug>/TEST-REPORT.meta.json` | fixed | `write_test_report` | |
| Context sync | `plans/<slug>/CONTEXT-SYNC.md` | fixed | scribe agent | |
| Review | `reviews/REVIEW.md` | fixed | `write_review` / reviewer agent | |
| HTML design report | `artifacts/design.html` | fixed | renderer (design template) | Written by renderer agent, not by a harness tool |
| HTML review report | `artifacts/review.html` | fixed | renderer (review template) | |
| HTML codebase graph | `artifacts/codebase-graph.html` | fixed | renderer (codebase-graph template) | |
| HTML file context | `artifacts/file-context.html` | fixed | renderer (file-context template) | |
| Session context | `context.md` | fixed | architect (session-context template) | At workspace root |
| Transcript | `transcripts/<step_id>--<agent_type>--<iso>.jsonl` | derived — `<step_id>`, `<agent_type>`, `<iso>` are ISO timestamp | `capture_transcript` | Source: `mcp-server/src/features/orchestration/tools/capture-transcript.ts` line 86 |
| Decisions | `decisions/<decision-id>.md` | decision-id variable | architect | |
| Build trend summary | `build-trend-summary.md` | fixed | `finalize_workspace` side-effect | At workspace root; only written when sufficient flow history exists |
| Build digest | **external** — `~/.claude/projects/<dashed-project-dir>/memory/build-digest-<date>-<slug>.md` | derived | `finalize_workspace` side-effect | Written to Claude Code auto-memory, NOT in workspace. Auto-updates `MEMORY.md` index in the same directory. |
| Learner report | **repo-relative** `.canon/LEARNING-REPORT.md` | fixed | learner agent | Gitignored |
| Learner proposals | **repo-relative** `.canon/proposed-learnings/<id>.md` | id variable | learner agent | Gitignored |

---

## Registering `artifacts_expected`

When calling `log_step` with `artifacts_expected`, use the following patterns:

| Artifact | Recommended registration | Notes |
|----------|-------------------------|-------|
| Implementation summary | `plans/<slug>/*-SUMMARY.md` (glob) **or** the `path` field returned by `write_implementation_summary` | Prefer the returned `path` when the engineer has already run. Prefer the glob when pre-registering in `batch_log_steps` before the engineer runs. Never guess the stem. |
| All other artifacts | Exact path (e.g. `plans/<slug>/DESIGN.md`) | Fixed names — exact paths are safe and precise. |

### Why the summary is special

`write_implementation_summary` always uses the `task_id` field as the filename stem — there is no fallback to slug. However, the orchestrator cannot reliably predict the exact `task_id` value the engineer will pass before the engineer runs (it may be the slug, or a DAG task ID like `task-01`). Use the glob `plans/<slug>/*-SUMMARY.md` to match any summary in the slug's plan directory. The harness also has a narrow auto-discovery fallback: a literal expectation ending in `-SUMMARY.md` that does not match exactly is retried with a `<dir>/*-SUMMARY.md` glob. This fallback is scoped to SUMMARY-shaped names only; all other artifact misses are still reported as failures.

### Backward compatibility guarantee

Exact-path registrations and glob registrations for all other artifacts (DESIGN.md, REVIEW.md, TEST-REPORT.md, etc.) are matched exactly as before — the auto-discovery fallback does not apply to non-SUMMARY stems.

---

## Variable vs fixed names — quick reference

Four artifact categories have variable-component filenames:

| Category | Variable component | Example |
|----------|--------------------|---------|
| Implementation summary | `<task_id>` (required; equals slug when caller passes `task_id=slug`) | `plans/<slug>/<task-id>-SUMMARY.md` |
| Task plans | `<task-id>` | `plans/<slug>/<task-id>-PLAN.md` |
| Decisions | `<decision-id>` | `decisions/<decision-id>.md` |
| Transcripts | `<step_id>`, `<agent_type>`, `<iso>` | `transcripts/implement--canon:engineer--2026-06-02T21-00-00-000Z.jsonl` |

Everything else uses a fixed filename and is safe to register as an exact path.

---

## Notes on external / gitignored outputs

- **Build digests** are written to Claude Code's auto-memory directory (`~/.claude/projects/<dashed>/memory/`), which is outside the workspace and outside the repo. The harness cannot validate these via `artifacts_expected`.
- **Learner outputs** (`mcp-server/src/domains/.canon/proposed-learnings/`, `.canon/LEARNING-REPORT.md`) are gitignored. They are not part of the build artifact validation chain.
- **`orchestration.db`** and **`journal.json`** are harness-internal files managed exclusively by Canon tools. Agents must not read or write them directly.
