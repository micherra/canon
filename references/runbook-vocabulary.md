# Canonical Runbook Vocabulary

The canonical set of step IDs Canon knows. Every synthesized runbook uses only these IDs. Adding a new ID is a versioned change — deliberate and reviewed, never a per-run decision.

This file is the single source of truth. The synthesis skill (`references/runbook-synthesis.md`) validates every generated runbook against this vocabulary at synthesis time. Unresolvable step IDs are synthesis errors.

**Version: 1.0**

---

## Step Vocabulary

| Step ID | Default Agent | Dispatch | Default HITL | Purpose |
|---------|---------------|----------|--------------|---------|
| `research` | researcher | subagent | none | Investigation — any scope (codebase, risks, coverage gaps, migration scope, drift) |
| `design` | architect | subagent | approval | Plan index + design decisions |
| `spike` | engineer | subagent | none | Time-boxed exploratory prototype; produces findings, not shipped code |
| `implement` | engineer | subagent or team | none | Build code with TDD/BDD; `team` when wave-parallel |
| `migrate` | engineer | subagent | none | Schema/data migration execution (pairs with rollback artifact) |
| `verify` | engineer | subagent | on_failure | Run existing tests/gates post-change |
| `test` | tester | subagent | none | Net-new integration tests; coverage-gap fills |
| `benchmark` | tester | subagent | on_failure | Performance verification against baseline |
| `security` | security | subagent | none | Security assessment |
| `review` | reviewer | subagent | checkpoint | Principle compliance |
| `fix` | engineer | subagent | on_failure | Fix mode — requires `cause: test-failure \| security \| review \| verify` |
| `pre-launch-check` | null | n/a | on_failure | Gate-only — lead runs discovered checks via Bash |
| `ship` | shipper | subagent | on_failure | PR description synthesis |
| `context-sync` | scribe | subagent | none | Doc sync — **mandatory tail** |
| `learn` | learner | subagent | none | Pattern analysis — **mandatory tail** |

**Total: 15 entries** (13 functional + 2 mandatory tail).

---

## Column Reference

**Step ID** — lowercase-kebab identifier. Must be unique within the vocabulary. Used as the `id` field in synthesized runbook steps.

**Default Agent** — the Canon agent type spawned for this step. `null` means no agent is spawned; the lead handles the step directly (e.g., `pre-launch-check` runs gate commands via Bash). The planner may override the default agent with explicit justification in the brief body, but this is rare.

**Dispatch** — how the step is executed:
- `subagent` — single agent spawn. The lead waits for completion before proceeding.
- `team` — wave-parallel agent team. Multiple agents execute concurrently, each in an isolated worktree.
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

Every build runbook MUST end with the two mandatory tail steps in order:

1. `context-sync` — scribe updates CLAUDE.md, context.md, and CONVENTIONS.md when contract-level changes occurred during the flow
2. `learn` — learner analyzes the completed flow for patterns and suggests principle improvements

The planner MUST NOT skip these steps regardless of flow size, user preference, or confidence signal. They are the mechanism by which Canon's documentation and principles stay current.

---

## Step-Specific Constraints

### Artifacts: `outcome:` sentinel

Steps that produce no file output but have a verifiable pass/fail result may use an `outcome:` sentinel in their `artifacts` list instead of a file path:

```yaml
artifacts:
  - "outcome:{human-readable description of what must be true}"
```

The `outcome:` prefix signals a pass/fail outcome rather than a file artifact. The description is human-readable and appears in HITL output when the step fails. Paths and outcome sentinels may coexist in the same `artifacts` list.

### `fix`

The `fix` step requires a `cause` field indicating which upstream step triggered the fix:

- `cause: test-failure` — test step found failures
- `cause: security` — security step found actionable findings
- `cause: review` — review step found principle violations
- `cause: verify` — verify step found regressions

The `cause` field serves two purposes: analytic lineage (which upstream step triggered this fix, for outcome correlation) and skill hint (the planner may auto-add a domain primer based on the cause).

### `implement`

When dispatched as `team`, the planner decomposes the implementation into wave-parallel tasks. Each task gets an isolated worktree. The orchestrator manages worktree creation, merge, and cleanup.

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
