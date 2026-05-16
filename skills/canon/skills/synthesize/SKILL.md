---
name: synthesize
description: >-
  Mechanical runbook synthesis from canonical step vocabulary. Composes
  a step-by-step runbook from the planning brief using only canonical
  step IDs. Validates step composition, enforces mandatory tail, and
  emits per-signal confidence. Used by the planner agent.
user-invocable: false
---

# Synthesis Contract

You are performing mechanical runbook synthesis. Given a planning brief, compose a structured runbook using only the 17 canonical step IDs from `references/runbook-vocabulary.md`. This skill defines the full contract: what you MUST do, what you MAY do, and what you MUST NOT do.

**Vocabulary source of truth:** `references/runbook-vocabulary.md`. Every `id` field in every synthesized runbook step MUST appear in that file's Step Vocabulary table. IDs not listed there are synthesis errors — halt and report the unknown ID rather than emit an invalid runbook.

---

## 1. Step Schema

Every synthesized step carries these first-class fields (per v2.1 §5.2):

```yaml
- id: {step-id}               # required — from runbook-vocabulary.md vocabulary only
  agent: {agent-type}         # required — vocab default unless overridden with justification
  dispatch: subagent|team|n/a # required — vocab default unless overridden with justification
  skills: []                  # optional — names validated against references/ at synthesis time
  cause: ~                    # required on `fix` steps: test-failure|security|review|verify
  mcp_tools: []               # optional — MCP tool calls to compose context at step runtime
  artifacts:                  # required — relative paths under ${WORKSPACE}
    - {path}
  hitl: none|approval|checkpoint|on_failure  # required — vocab default unless overridden
  skip_when: ~                # optional — human-readable condition string
```

**Field rules:**

- `id` — must match a vocabulary entry exactly (case-sensitive). Unknown IDs are synthesis errors.
- `agent` — use the vocabulary's Default Agent column. Override only when the brief body explicitly names a different agent and provides justification. `null` means no agent; the lead handles the step via Bash.
- `dispatch` — use the vocabulary's Dispatch column. `team` is valid for `implement`, `design`, `review`, `test`, and `security` steps; all others are `subagent` or `n/a`. For `review` steps, recommend `dispatch: team` when the orchestrator's blast radius analysis indicates high aggregate impact (multiple high-centrality files across several layers). The planner does not compute blast radius itself — it notes `dispatch: team` as a recommendation and the orchestrator makes the final fan-out decision at runtime based on `get_file_context` data.
- `skills` — if present, every name must correspond to a file at `references/<name>.md` or `skills/canon/skills/<name>/SKILL.md`. Unknown skill names are synthesis errors.
- `cause` — required on every `fix` step. One of: `test-failure`, `security`, `review`, `verify`. Indicates which upstream step triggered this fix. Do not emit a `fix` step without a `cause`.
- `mcp_tools` — list of MCP tool names (e.g., `mcp__canon__get_principles`) the lead should call before spawning this step's agent. Used to compose context.
- `artifacts` — at least one entry per step. Entries are either file paths relative to `${WORKSPACE}` or `outcome:` sentinels. An `outcome:` sentinel takes the form `outcome:{description}` (e.g., `outcome:all existing tests pass`) and signals a pass/fail outcome rather than a file artifact — use it when a step produces no file output but has a verifiable result. Paths and outcome sentinels may coexist in the same `artifacts` list. Use `${slug}` and `${task_id}` placeholders in file paths where appropriate.
- `hitl` — must match the vocabulary's Default HITL column unless the brief body overrides with justification. HITL posture is a policy floor, not a confidence dial.
- `skip_when` — human-readable string explaining when this step may be skipped (e.g., "no database schema changes in scope"). Leave `~` (null) when the step is always executed.

---

## 2. Synthesis MUST

Apply every rule below on every build runbook synthesis:

1. **Include the mandatory tail.** Every build runbook ends with `context-sync` followed by `ship` followed by `learn`, in that order. These three steps are the mandatory tail. No exceptions — not for small flows, not for doc-only changes, not on user request. `context-sync` runs before `ship` so that documentation updates are committed to the build branch and included in the PR — `finalize_workspace` needs the worktree for artifact verification, so the shipper must not remove it. `learn` is always last because it writes to `.canon/` only and does not require the worktree.

2. **Use canonical step IDs only.** Every `id` field must appear in `references/runbook-vocabulary.md`. Reject and report unknown IDs at synthesis time; do not emit them.

3. **Preserve vocabulary defaults.** Use the Default Agent, Dispatch, and Default HITL from the vocabulary table unless the planning brief body explicitly overrides with justification. Do not silently change defaults.

4. **Validate `skills:` names strictly.** Every name in a step's `skills:` list must resolve to a real file (`references/<name>.md` or a native skill directory). If a name does not resolve, it is a synthesis error.

5. **Use template placeholders.** Use `${slug}`, `${task_id}`, and `${timestamp}` in artifact paths and frontmatter fields per the runbook template spec (`templates/runbook.md`).

6. **Include an Overview.** The runbook body's `## Overview` section must contain one paragraph explaining why this specific step sequence was chosen — not a list of steps, but a prose rationale addressing the planning brief's scope and risk profile.

7. **Write H3 prose per step.** Each `### Step N: {id}` section includes:
   - Intent: what this step is trying to achieve for this specific runbook
   - Skip-when elaboration: if `skip_when` is set, explain the condition and its implications
   - Coordination notes: hand-off signals, artifacts consumed by the next step, HITL expectations

8. **Apply contract pairings.** The following step combinations are mandatory when conditions apply:

   | Condition | Required pairing |
   |-----------|-----------------|
   | Any `implement` step that modifies existing behavior | A `verify` step immediately following |
   | Any `migrate` step | A rollback artifact documented in the `migrate` step's artifacts |
   | Any `security` step that produces findings | At least one `fix` step with `cause: security` before `ship` |
   | A `review` step whose verdict is not clean | A `fix` step with `cause: review` — loop until the review step passes clean |

---

## 3. Synthesis MAY

Use these flexibilities when the planning brief scope justifies them:

- **Reorder steps.** For example, place `security` before `review` when the change is auth-sensitive. Step order follows logical dependency, not a fixed template.
- **Skip optional steps.** `design` may be skipped for scoped fixes where no architectural decision is needed. `test` may be skipped for documentation-only changes. `benchmark` and `spike` are always optional. Record the skip in the step's `skip_when` field.
- **Repeat steps.** Two `review` passes for risky migrations. Multiple `fix` cycles (one per review round). Each repeat is a distinct step entry with its own artifact path.
- **Expand a single step into a wave.** An `implement` step may decompose into multiple parallel wave tasks when the planning brief identifies independent workstreams.

---

## 4. Synthesis MUST NOT

These constraints are absolute — no exception, no override:

1. **Do not invent new step IDs.** Adding an ID to the vocabulary is a versioned, deliberate change — not a per-run decision. If no existing ID fits, emit a synthesis warning and use the closest match, or halt and report.

2. **Do not remove baseline HITL.** The vocabulary's Default HITL is a policy floor. Confidence signals (per §5.2 below) are advisory and informational. A high-confidence signal does not permit removing an `approval` or `checkpoint` HITL posture.

3. **Do not skip the mandatory tail.** `context-sync`, `ship`, and `learn` are required on every build runbook regardless of flow size, user preference, or confidence level.

**Self-check:** Before emitting the runbook, verify the last three steps are `context-sync` → `ship` → `learn` in that order. If they are not, correct the runbook before emitting.

---

## 5. Iterate-Until-Approved Loop

Per v2.1 §5.4, the synthesized runbook is not locked until the user approves it.

- **Each iteration** re-spawns the planner with full workspace context: the original planning brief, the prior iteration's runbook, any HITL feedback from the user.
- **Intermediate runbooks** persist as `runbook-iter-N.md` in the workspace (v2.1a behavior; v2.1b introduces separate lifecycle rows). Do not overwrite prior iterations.
- **Only the approved runbook executes.** The lead locks the runbook (sets `status: approved` in frontmatter) after user sign-off. Only then does the orchestrator proceed to step execution.
- **Revision triggers:** user identifies a missing step, a misordered sequence, a wrong agent assignment, or a contract pairing violation. Correct the specific issue and re-synthesize. Do not redesign the entire runbook when a targeted fix suffices.

---

## 6. Conservative Prompt Guidance

> "Under-confidence is safer than over-confidence. Surface uncertainty; don't hide it."

When synthesizing, prefer explicit uncertainty over false precision:

- If the planning brief is ambiguous about scope, emit a lower confidence signal and describe the ambiguity in the per-signal rationale.
- If a step sequence is novel (no prior Canon runbook used this order), flag it with a `medium` or `low` confidence signal.
- If a contract pairing is borderline (the brief doesn't clearly trigger the pairing condition), include the paired step and note the uncertainty — omitting a required pair is a harder error to catch than including an unnecessary one.
- Do not round up confidence to reassure the user. A `medium` confidence runbook that surfaces its uncertainties is more useful than a `high` confidence runbook that hides them.

---

## 7. Confidence Articulation

Per v2.1 §7.1 HIGH-2 adjustment:

**Per-signal `confidence_signals[]` — user-facing, required in runbook frontmatter.**

Every synthesized runbook emits a `confidence_signals` list in its YAML frontmatter. Each signal is an object with three fields:

```yaml
confidence_signals:
  - dimension: scope        # what aspect of the synthesis this signal covers
    level: high             # high | medium | low
    rationale: >-           # one sentence explaining this confidence level
      The brief explicitly names all affected files and the change is
      contained within a single module boundary.
  - dimension: step-sequence
    level: medium
    rationale: >-
      The security-before-review ordering is novel for this codebase;
      no prior runbook used this sequence.
  - dimension: contract-pairings
    level: high
    rationale: >-
      All implement steps are behavior-preserving and paired with verify;
      no migrate steps present.
```

**Aggregate `confidence` scalar — internal only, not user-facing (v2.1a/b).**

Do not emit a top-level `confidence:` scalar field in the runbook frontmatter. The aggregate is computed internally from the signals when needed. Users see the per-signal breakdown only — this prevents a single number from obscuring the nuanced picture the signals provide.

**Suggested confidence dimensions** (use the ones applicable to each runbook):

| Dimension | Covers |
|-----------|--------|
| `scope` | How well the brief defines the change boundary |
| `step-sequence` | How standard/novel the chosen step order is |
| `contract-pairings` | Whether mandatory pairings clearly apply |
| `risk` | Known unknowns that could invalidate the runbook mid-execution |
| `vocabulary-coverage` | Whether all needed operations map cleanly to vocabulary IDs |
| `alternatives` | Whether alternative step sequences were meaningfully considered |
