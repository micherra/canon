# Canonical Runbook Vocabulary

The canonical set of step IDs Canon knows. Every synthesized runbook uses only these IDs. Adding a new ID is a versioned change — deliberate and reviewed, never a per-run decision.

This file is the single source of truth. The synthesis skill (`references/runbook-synthesis.md`) validates every generated runbook against this vocabulary at synthesis time. Unresolvable step IDs are synthesis errors.

**Version: 1.1**

---

## Step Vocabulary

| Step ID | Default Agent | Dispatch | Default HITL | Purpose |
|---------|---------------|----------|--------------|---------|
| `research` | planner | subagent | none | Investigation — any scope (codebase, risks, coverage gaps, migration scope, drift) |
| `design` | architect | subagent or team | approval | Plan index + design decisions |
| `spike` | engineer | subagent | none | Time-boxed exploratory prototype; produces findings, not shipped code |
| `implement` | engineer | subagent or team | none | Build code with TDD/BDD; `team` when DAG parallel |
| `migrate` | engineer | subagent | none | Schema/data migration execution (pairs with rollback artifact) |
| `verify` | engineer | subagent | on_failure | Run existing tests/gates post-change |
| `test` | tester | subagent or team | none | Net-new integration tests; coverage-gap fills |
| `benchmark` | tester | subagent | on_failure | Performance verification against baseline |
| `security` | security | subagent or team | none | Security assessment |
| `review` | reviewer | subagent or team | checkpoint | Principle compliance |
| `fix` | engineer | subagent | on_failure | Fix mode — requires `cause: test-failure \| security \| review \| verify` |
| `pre-launch-check` | null | n/a | on_failure | Gate-only — lead runs discovered checks via Bash |
| `context-sync` | scribe | subagent | none | Doc sync — **mandatory tail** |
| `ship` | shipper | subagent | on_failure | Create PR from worktree branch to main; direct merge when explicitly requested — **mandatory tail** |
| `learn` | learner | subagent | none | Pattern analysis — **mandatory tail** |
| `compete` | orchestrator | team | checkpoint | Divergent-then-converge exploration — N teams produce independent solutions, synthesizer combines |
| `debate` | orchestrator | team | checkpoint | Adversarial refinement — multi-team structured deliberation with convergence detection |

**Total: 17 entries** (14 functional + 3 mandatory tail).

---

## Column Reference

**Step ID** — lowercase-kebab identifier. Must be unique within the vocabulary. Used as the `id` field in synthesized runbook steps.

**Default Agent** — the Canon agent type spawned for this step. `null` means no agent is spawned; the lead handles the step directly (e.g., `pre-launch-check` runs gate commands via Bash). The planner may override the default agent with explicit justification in the brief body, but this is rare.

**Dispatch** — how the step is executed:
- `subagent` — single agent spawn. The lead waits for completion before proceeding.
- `team` — DAG parallel agent team. Engineer teams use isolated worktrees; other teams (design, review, test, security) share the workspace directory with ID-tagged output files.
- `n/a` — no agent dispatch; the lead handles the step directly.

**Default HITL** — when the orchestrator presents results to the user:
- `none` — fully autonomous; no user checkpoint.
- `approval` — results presented for explicit user approval before proceeding.
- `checkpoint` — results presented for user review; user may intervene but flow continues by default.
- `on_failure` — results presented only when the step fails or produces concerning output.

The planner MUST NOT remove baseline HITL from step defaults. The runbook's declared `hitl:` posture stays regardless of confidence signal.

**Purpose** — what the step does. Guides the planner's step-selection logic.

---

## Mandatory Tail

Every build runbook MUST end with the three mandatory tail steps in order:

1. `context-sync` — scribe updates CLAUDE.md, context.md, and CONVENTIONS.md when contract-level changes occurred during the flow. Runs before ship so that doc updates are committed to the build branch and included in the PR — `finalize_workspace` needs the worktree for artifact verification, so nothing removes it until after `finalize_workspace` completes.
2. `ship` — shipper creates a PR from the worktree branch to main; direct merge when explicitly requested. Runs after context-sync because the scribe needs the worktree available to commit doc updates before the PR is created.
3. `learn` — learner analyzes the completed flow for patterns and suggests principle improvements. Writes to `.canon/` only and does not require the worktree.

The planner MUST NOT skip these steps regardless of flow size, user preference, or confidence signal. They are the mechanism by which Canon ships work and keeps its documentation and principles current.

---

## Step-Specific Constraints

### Artifacts: `outcome:` sentinel

Steps that produce no file output but have a verifiable pass/fail result may use an `outcome:` sentinel in their `artifacts` list instead of a file path:

```yaml
artifacts:
  - "outcome:{human-readable description of what must be true}"
```

The `outcome:` prefix signals a pass/fail outcome rather than a file artifact. The description is human-readable and appears in HITL output when the step fails. Paths and outcome sentinels may coexist in the same `artifacts` list.

### `review`

The standard artifact path for a review step is `${WORKSPACE}/reviews/REVIEW.md`. Runbooks that include a `review` step should declare this artifact path explicitly so the orchestrator's post-step artifact check can verify it exists:

```yaml
artifacts:
  - ${WORKSPACE}/reviews/REVIEW.md
```

### `fix`

The `fix` step requires a `cause` field indicating which upstream step triggered the fix:

- `cause: test-failure` — test step found failures
- `cause: security` — security step found actionable findings
- `cause: review` — review step found principle violations
- `cause: verify` — verify step found regressions

The `cause` field serves two purposes: analytic lineage (which upstream step triggered this fix, for outcome correlation) and skill hint (the planner may auto-add a domain primer based on the cause).

### `implement`

When dispatched as `team`, the planner decomposes the implementation into DAG parallel tasks. Each task gets an isolated worktree. The orchestrator manages worktree creation, merge, and cleanup.

When dispatching two or more parallel engineers to the same worktree, the runbook should designate one as the committer responsible for verifying and committing after parallel completion, or include an explicit consolidation step. Without this, neither engineer commits, forcing the orchestrator to spawn a third agent for consolidation.

### `design`, `review`, `test`, `security` (team dispatch)

When any of these step types are dispatched as `team`, multiple agents execute in parallel sharing the workspace directory. Each agent writes ID-tagged output files (e.g., `review-agent-01.md`, `security-agent-02.md`) rather than isolated worktrees. The lead consolidates outputs before proceeding.

### `migrate`

Migration steps pair with a rollback artifact. The synthesis contract requires that any runbook containing a `migrate` step also documents the rollback strategy.

### `verify`

Runs existing tests and type checks after an implementation step to detect regressions. When all checks pass, no file artifact is produced — use the `outcome:` sentinel:

```yaml
artifacts:
  - "outcome:all tests and type checks pass"
```

File artifacts (e.g., a test-results log) may be added alongside the sentinel when available.

### `pre-launch-check`

Gate-only step with no agent. The lead runs discovered gate commands (from prior steps' `discovered_gates`) via Bash. All gates must pass for the step to succeed; any failure triggers HITL (`on_failure`). Because this step produces no file output, use the `outcome:` sentinel:

```yaml
artifacts:
  - "outcome:all discovered gates pass"
```

### `review`

Team dispatch: orchestrator partitions files by blast radius, spawns N reviewers with scoped file lists, consolidates into single REVIEW.md. See CLAUDE.md Team Dispatch Protocol.

### `compete`

- Orchestrator spawns N teams (max 5) as parallel agents with competing instructions.
- Each team receives either a lens-based or generic framing per `references/competition-debate.md` § Spawn Framing.
- After all teams return, orchestrator spawns a synthesizer with all outputs + original brief.
- Synthesis strategy: `synthesize` (default — combine best ideas) or `select` (pick winner). Runbook specifies `synthesize` unless the brief explicitly calls for a winner.
- Full protocol details: `references/competition-debate.md` § Competition Protocol.

### `debate`

- Orchestrator drives round-by-round: Position → Challenge → Response → Narrow.
- Teams communicate on channel `debate-round-{N}`.
- Convergence checked after qualifying rounds per algorithm in `references/competition-debate.md` § Convergence Detection.
- Hard stop at `max_rounds` (default 5); HITL checkpoint after completion.
- Full protocol details: `references/competition-debate.md` § Debate Protocol.

---

## Versioning Policy

The vocabulary follows semver-style discipline:

### Minor versions (additive only)

- New step IDs
- New default values for existing columns
- New optional columns added to the step schema

Existing runbooks remain valid across minor version changes. No regeneration needed.

### Major versions (breaking changes)

- Removing a step ID
- Renaming a step ID
- Changing the semantics of an existing step ID

Breaking changes require a deprecation cycle: at least one minor version where the entry is marked deprecated (still functional, emits a deprecation notice at synthesis time). Removal happens in the next major version after the deprecation notice has been live.

### Version history

| Version | Date | Change |
|---------|------|--------|
| 1.1 | 2026-05-15 | Added `compete` and `debate` step IDs — 17 total |
| 1.0 | 2026-04-22 | Initial vocabulary — 15 step IDs |

---

## Resume Behavior Across Vocab Versions

When a runbook is resumed after a vocabulary version change:

**Minor version change (additive):** locked runbooks continue with the synthesis-time vocabulary. New step IDs are available for new runbooks but do not affect in-progress flows. No regeneration needed.

**Major version change (entry removed):** if a locked runbook references a step ID that was removed in the new major version, the planner regenerates the runbook with full workspace context:

- Original planning brief
- Prior approved runbook
- Steps already executed and their artifacts
- HITL events from the prior session

The regenerated runbook is presented for user re-approval. The flow does not continue until the user approves the regenerated runbook or aborts the flow.

Most vocabulary evolution is additive (minor versions), so regeneration is rare in practice.
