---
adr: "0061"
title: "The evaluator's verdict returns by tool result, not by mailbox — so it is spawned unnamed"
status: accepted
date: "2026-07-15"
build: "diagnose-and-fix-the-evaluator-gates-verdict-capture-channel-the"
---

# ADR-0061: The evaluator's verdict returns by tool result, not by mailbox — so it is spawned unnamed

## Context

Canon's evaluator gate (root `CLAUDE.md` → Post-Step Effects) is an advisory, fail-open
quality gate that runs after every `implement`/`fix` step in every tier. It spawns
`canon:evaluator` (Haiku) and reads a PASS/FAIL verdict from between `---VERDICT---` /
`---END_VERDICT---` delimiters. A parse failure deliberately falls open to PASS
(`PASS_parse_fallback`).

The gate never worked. Across at least three builds (PR #498, PR #504 ×2) it logged
`PASS_parse_fallback` every time — not because output was malformed, but because **the verdict
never reached the orchestrator at all**. The gate was silently disabled while reporting healthy
PASSes. Because the failure mode is fail-open by design, it could not self-surface; a learner
mining across builds eventually caught it.

The learner's hypothesised causes were: a Haiku-mangled delimiter literal, token/turn-limit
truncation, or an over-strict extraction regex. **A live two-arm probe disproved all three**
(`PROBE-FINDINGS.md`). Haiku emits the delimiters byte-exact; nothing truncates; and there is
no regex — the entire gate is CLAUDE.md prose executed by the orchestrator LLM.

The real cause is structural. The harness enforces a two-tier spawn model:

- **`name:` present → teammate.** Joins a flat roster; returns output only via `SendMessage`.
- **`name:` absent → subagent.** Its final message is returned as the Agent tool result.

`CLAUDE.md` mandated a **named** spawn (`name: evaluator-eval-{job_suffix}`), while
`canon:evaluator`'s tool grant is `tools: [Read]` — no `SendMessage`, and no write tool. It is
the **only** Canon agent with zero return channels. Its verdict was structurally undeliverable.

The control case is decisive: in the same build, the named `engineer-implement-a09b5e75` idled
identically — and lost nothing, because the engineer writes `write_implementation_summary`.
**No Canon agent has `SendMessage`; every named agent's output survives via a durable
artifact.** That is why ADR-0043's fail-closed write-receipt gate exists. The evaluator was
designed as a return-text judge but spawned through the named-teammate mechanism.

## Options Considered

### Option A: Spawn the evaluator unnamed + synchronous

**Pros:**
- Proven by direct probe: returns a full, delimiter-intact, planted-FAIL verdict in ~21s on
  the first attempt, with zero retries.
- Zero code. A spawn-config change only.
- Already the established precedent for a comparable read-only helper: the Renderer Spawn
  Protocol, 13 lines below in the same file, says "Spawn generic `Agent()` (not named)."
- Keeps the evaluator a pure `permissionMode: plan`, `tools: [Read]` judge.

**Cons:**
- The verdict is **ephemeral** — not durably archived; it lives only in the tool result.
- Synchronous, so the gate blocks the orchestrator for the evaluator's runtime (~20s).

**Canon-principle alignment:** honors `simplicity-first`, `probe-before-build-invoke-not-infer`.

### Option B: Grant the evaluator `SendMessage` and keep the named spawn

**Pros:**
- Preserves visual consistency with every other agent's named spawn.
- Verdict could arrive asynchronously without blocking.

**Cons:**
- Buys an async mailbox round-trip for a value the orchestrator must wait for anyway.
- Requires the evaluator to *know* to send, adding a failure mode where it evaluates
  correctly but forgets to deliver — reintroducing the exact silent-loss class being fixed.
- No other Canon agent has `SendMessage`; this would make the evaluator the outlier in the
  opposite direction.

**Canon-principle alignment:** tensions `simplicity-first`.

### Option C: Give the evaluator a durable artifact (`write_evaluation` → `VERDICT.md`)

**Pros:**
- Architecturally consistent with every other agent (output survives via artifact).
- Auditable and durable; the verdict would survive compaction and be minable by the learner.
- Would integrate with the existing ADR-0043 write-receipt gate.

**Cons:**
- Requires a new MCP write tool, which drags in the tool-surfacing gate (ADR-0048) and the
  dead-wire gate.
- Breaks `permissionMode: plan` — the evaluator would need write capability.
- Makes a deliberately ephemeral judgment durable, for a verdict consumed immediately and
  never re-read.
- Disproportionate to a defect whose fix is deleting one parameter.

**Canon-principle alignment:** honors auditability; tensions `simplicity-first`.

## Decision

Chosen: **Option A — spawn the evaluator unnamed + synchronous.**

It is the only option proven to work by invocation rather than argument, it costs no code, and
it matches precedent already in the same file. The evaluator's verdict is an **ephemeral tool
result**, not a durable artifact — and that is acceptable because the *decision the verdict
drives* is already durably recorded via `log_step` / `log_decision` outcomes. We durably record
the judgment, not the reasoning that produced it.

Option C is the genuine fork, and the reason this ADR exists: choosing A means the verdict is
**not** durably archived. That is the real trade-off, and it is what makes the decision
hard-to-reverse — moving to C later means a new MCP tool, a `permissionMode` change, and
write-receipt integration.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| `probe-before-build-invoke-not-infer` | honors | The channel was invoked, not inferred. All three inferred hypotheses were disproven by the probe; the fix targets what the probe actually showed. |
| `simplicity-first` | honors | Fixes the spawn, not the parser. No retry, no byte-count gate, no new tool. |
| `fail-closed-by-default` | tensions (deliberately) | Governs *safety* gates. This is an advisory quality gate; step 7's fail-open posture is preserved intentionally. Loud ≠ blocking. |
| `leave-touched-files-better` | honors | An invariant test closes the whole class (zero-return-channel agents), not just this instance. |

## Consequences

**Positive:**
- The evaluator gate actually evaluates — first try, no retry.
- The `PASS_parse_fallback` branch becomes rare-to-never, restoring it to a real signal: if it
  fires now, something is genuinely wrong.
- A general invariant is now enforced in CI: *an agent with no write capability and no
  `SendMessage` has no return channel and must not be spawned named.*

**Negative / trade-offs:**
- The verdict text is not durably archived. A future learner cannot mine historical verdict
  *reasoning* — only the logged PASS/FAIL outcome. Accepted.
- The gate blocks the orchestrator synchronously for ~20s per implement/fix step.
- The evaluator is now deliberately inconsistent with every other agent's named spawn. This is
  a **maintenance hazard**: it looks like an oversight and invites "tidying." The inline reason
  in `CLAUDE.md`, the `## Return Channel` section in `agents/evaluator.md`, and the invariant
  test exist specifically to defend against that.

## Revisit-If

- The harness changes its named→teammate / unnamed→subagent split, or begins auto-delivering a
  named agent's final message to its spawner. The invariant test is the tripwire.
- A concrete consumer appears for historical verdict *reasoning* (e.g. a learner that mines
  evaluator findings across builds to tune the rubric) — that demand would justify Option C's
  durable artifact.
- `canon:evaluator` ever needs a write or `SendMessage` tool for another reason; at that point
  the zero-return-channel constraint dissolves and the named spawn becomes viable again.
- `PASS_parse_fallback` recurs after this fix — that would mean the diagnosis was incomplete,
  not that the fallback needs loosening.
