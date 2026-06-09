# Advisor Strategy in Canon — Exploration Brief

## Status: Complete

**Mode:** Exploration (no code, read-only). **Date:** 2026-06-09.
**Question:** How can we leverage the Advisor Strategy in Canon?

---

## TL;DR (opinionated)

1. **The Anthropic builtin (`advisor_20260301`) is NOT reachable from Canon's spawn path.** It is a server-side Messages API beta tool (`anthropic-beta: advisor-tool-2026-03-01`); the model handoff happens *inside one `/v1/messages` request*. Canon spawns agents via Claude Code's `Agent` tool, not via raw Messages API calls — Canon never sees the `tools=[...]` array of the underlying request. So Canon cannot pass `advisor_20260301` to its agents. **This is the load-bearing feasibility finding.** ([blog](https://claude.com/blog/the-advisor-strategy), confirmed: "available exclusively through the Claude Platform's Messages API"; no subagent/Agent integration documented.)
2. **The Canon-native equivalent is a `consult_advisor` MCP tool** that does a one-shot `claude -p --model opus` subprocess call with shared context, returns guidance-only text, and logs an `advisor_consulted` event. This is **already proven feasible** — `.spike/spike-eval-iter3.ts:12,20` runs `claude -p` via `execSync` ("no API key needed — uses Claude Code auth"), and the production subprocess seam (`runShell`, `mcp-server/src/platform/adapters/process-adapter.ts:39`) already exists under the ADR-002 adapter boundary.
3. **The single most valuable first slice: give the `engineer` (sonnet) a `consult_advisor` affordance at its `NEEDS_CONTEXT` decision point** (`agents/engineer.md:248`). Today the engineer's only escape from an ambiguous plan or a borderline Canon-exception judgment is to *guess* or to bounce the whole step back to HITL / whole-agent `escalate_model`. An Opus advisor consult is the missing middle.
4. **Wire `consult_advisor` as a NEW escalation strategy `consult_advisor` placed BEFORE `escalate_model`** in the cascade (`escalation-cascade.ts:59`). It is strictly cheaper than promoting the whole agent to Opus and resuming from scratch. Keep it ALSO available as a standalone always-on affordance (the two are not mutually exclusive).

---

## Research (grounded findings)

### Finding A — Canon's current model tiers differ from the spawn-prompt's assumption
The spawn prompt stated "specialist agents run on sonnet/haiku." **Actual frontmatter** (`agents/*.md`):

| Agent | `model:` | Advisor-strategy fit |
|-------|----------|----------------------|
| engineer | **sonnet** | **HIGH** — cheap executor, frequent hard judgment calls |
| tester | **sonnet** | MEDIUM — flaky-test root-cause calls |
| scribe | **sonnet** | LOW — mechanical doc sync; few hard decisions |
| reviewer | **opus** | N/A — already the advisor tier |
| architect | **opus** | N/A — already the advisor tier |
| security | **opus** | N/A — already the advisor tier |

This reframes the whole opportunity: **the advisor strategy only pays off for the sonnet agents** (engineer, tester, scribe). The opus agents already pay the top-tier rate end-to-end — for them the inverse question ("can we DEMOTE them to a sonnet executor + opus advisor?") is a *cost-reduction* play, deferred (see Phase 3). Renderer spawns (haiku for design, sonnet for review/graph — CLAUDE.md Renderer Spawn Protocol) are mechanical template-fills with no hard decision point; not advisor candidates.

### Finding B — The decision points where sonnet agents currently guess or escalate wholesale
- **engineer `NEEDS_CONTEXT`** (`agents/engineer.md:248`): "Plan is ambiguous or has a design flaw (do NOT improvise — that's the architect's job)." Today this is a hard stop → bounce to architect/HITL. An advisor consult could resolve many of these in-line without a full architect re-spawn.
- **engineer Canon-exception judgment** (`agents/engineer.md:129`): deciding whether a rule-severity violation falls under a principle's `## Exceptions`. A borderline call here is exactly the "decision it cannot reasonably solve" the blog describes.
- **tester** flaky-vs-real root-cause calls (cf. PR #357 hardening — three flaky tests needed judgment about PATH-nondeterminism vs latency vs subprocess timeout).
- **reviewer borderline severity** (`agents/reviewer.md:604,736`): WARNING-vs-BLOCKING calls. Reviewer is *already opus*, so no advisor needed — but this is the archetype of the decision an advisor resolves.

### Finding C — `escalate_model` is the coarse-grained status quo
`escalation-cascade.ts:59` cascade: `add_primer → increase_budget → escalate_model → narrow_scope → hitl`. `escalate_model` (CLAUDE.md Auto-Escalation Protocol) means re-spawn the **whole agent** with `model: "opus"` — it throws away the executor's in-progress context and pays Opus rates for the *entire* re-run, not just the hard decision. The advisor pattern is the finer-grained alternative the cascade is missing.

The cascade is a clean insertion point: it's a **pure function** (`getNextStrategy`, `escalation-cascade.ts:93`), strategies are **tracked by name not index** (comment at `:15` — "reordering doesn't break in-flight cascades"), and the union type `EscalationStrategy` (`:22`) is the single edit site. Adding `"consult_advisor"` before `"escalate_model"` in `DEFAULT_ORDER` plus a `buildStrategyReasoning` case is a ~6-line change to the state machine.

### Finding D — The execution-store substrate for logging already fits
- `appendEvent(type: string, payload, correlationId?)` (`execution-store.ts:267`) takes an **arbitrary** event-type string. A new `advisor_consulted` event needs **no schema migration** — same path `get_next_escalation_strategy` uses for `auto_decision` (`get-next-escalation-strategy.ts:74`).
- `StateMetricsSchema` (`board-state-schemas.ts:60`) already has `model`, `input_tokens`, `output_tokens`, and crucially **`orientation_calls: z.number()`** (`:68`) — the exact precedent for a per-step call counter. An `advisor_calls` counter mirrors it (and is the natural `max_uses` analog — see Finding F).

### Finding E — A pre-existing "consultation" concept exists but is unrelated (do not conflate)
`board-state-schemas.ts:32` `ConsultationResultSchema` + `WaveResultSchema.consultations.{before,between,after}` (`:46`) is the **wave-level advisory-subagent** feature (consult a subagent before/between/after a DAG wave). The board README references `recordConsultationResult` (`mcp-server/src/domains/board/README.md:37`) but **grep finds no implementation in board source** — it appears to be a documentation-only / dead reference. **Naming collision risk:** name the new feature `advisor` (not `consult`) to avoid overloading this existing-but-distinct wave-consultation vocabulary. Flag the dead `recordConsultationResult` ref separately to the learner.

### Finding F — `max_uses` analog already has a Canon shape
The builtin's `max_uses` cap maps cleanly onto Canon's existing per-step counter pattern (`orientation_calls`). A `consult_advisor` MCP tool reads the current `advisor_calls` count for the step from state metrics, refuses (returns a `toolOk` with `{ refused: true, reason: "max_uses_exceeded" }` — errors-are-values) past a per-step cap (propose default 3, matching the blog's `max_uses: 3`), increments, and persists. No new infra.

### Finding G — Feasibility of the `claude -p` shim (the critical question)
**Reachable today.** Proof points:
- `.spike/spike-eval-iter3.ts` already calls `claude -p` for LLM reranking via `execSync`, explicitly noting it "uses Claude Code auth" (no API key plumbing).
- Production has the sanctioned seam: `runShell(command, cwd, timeout)` (`process-adapter.ts:39`, `shell: true`, 512KB maxBuffer, 30s default timeout). Per ADR-002 (mcp-server CLAUDE.md Invariants) **only `src/platform/adapters/` may import `node:child_process`** — so a `consult_advisor` service MUST route through `runShell`, not spawn directly. The 512KB output cap and 30s timeout are already enforced there.
- **Open risk:** `claude -p` latency and token-cost accounting are *not* captured by Claude Code's per-agent metrics (the advisor runs as a sub-process, invisible to the harness's agent transcript). Canon must self-account: capture wall-clock around `runShell` and log it to the `advisor_consulted` event. We cannot get true Opus token counts from `claude -p` stdout unless `--output-format json` exposes usage — **must verify** (see Open Questions).

---

## Approaches

Three candidate mechanisms for delivering advisor consultation. **No divergent sub-agent exploration was spawned** — the feasibility constraint (Finding G / the builtin being API-only) collapses the design space to essentially one viable mechanism; the other two are dominated. Recorded for the audit trail.

### Approach 1 — `consult_advisor` MCP tool (one-shot `claude -p --model opus`)  ← RECOMMENDED
A new MCP tool. Input: `{ workspace, step_id, question, context }`. Behavior: assembles a guidance-only prompt ("You are an advisor. Return ONLY a plan/correction/stop signal in ≤700 tokens. Do NOT produce user-facing output. Do NOT request tools."), invokes `claude -p --model opus --output-format json` via `runShell`, parses guidance, increments `advisor_calls`, logs `advisor_consulted`, returns `{ guidance, calls_used, refused? }`.

- **Honors:** errors-are-values (refusal is a value, not a throw), ADR-002 (routes through `runShell`), observable-best-effort (fail-open: advisor unavailable → return `{ guidance: null, degraded: true }` so the executor proceeds rather than blocks), information-hiding (executor sees guidance, not the subprocess).
- **Tensions:** simplicity-first (adds a tool + subprocess dependency on the `claude` CLI being on PATH inside the worktree). measure-before-optimizing (we assert cost savings but Canon's own numbers are unmeasured — Phase 1 must shadow-measure before claiming the blog's 11.9%).
- **Tradeoff:** Canon-native, fully observable in the execution store, model-agnostic, works on the existing Agent-spawn path **today**. Cost is a second process launch per consult (~the `claude -p` cold-start) and self-accounting burden.

### Approach 2 — Wait for / adopt the builtin `advisor_20260301` API tool
Pass `tools=[{type:"advisor_20260301", model:"claude-opus-4-6", max_uses:3}]` into the agent's underlying Messages request.

- **Blocked:** Canon does not construct the Messages API request for its agents — Claude Code's `Agent` tool does. There is no documented affordance to inject a `tools[]` entry into a spawned subagent's request, and the builtin is API-beta-only with no Agent/subagent integration (blog, confirmed). **Not reachable from Canon's spawn path.**
- **If it ever becomes reachable** (e.g., Claude Code exposes a per-agent `advisor` spawn field): it is strictly better — single request, no second process, native billing, native `max_uses`. **Defer and watch.** This is the "what to defer" answer.

### Approach 3 — Whole-agent `escalate_model` only (status quo, no advisor)
Do nothing new; rely on the existing cascade.

- **Honors:** simplicity-first (zero new code).
- **Tensions:** cost (pays Opus for the entire re-run), latency (full re-spawn discards executor progress), and it's all-or-nothing — there's no cheap "ask Opus one question" rung. This is the gap the advisor strategy exists to fill.

---

## Recommendation (phased, opinionated)

### Phase 0 — Shadow-measure feasibility (smallest valuable slice)
Build `consult_advisor` MCP tool (Approach 1) as a **standalone, shadow-only** affordance for the **engineer** agent at its two decision points (`NEEDS_CONTEXT`, `agents/engineer.md:248`; Canon-exception judgment, `:129`). "Shadow" = the engineer MAY call it, every call is logged to `advisor_consulted`, but it does NOT yet replace any `escalate_model` rung. Goal: collect real data — consult frequency, guidance length, whether `claude -p --output-format json` exposes token usage, latency distribution. Mirrors Canon's proven shadow-first pattern (cf. the principle-enforcement classifier epic, which shipped shadow-first).
- **One decision point, one agent, one mechanism.** Verify `--output-format json` usage field in the verify step (the silent-failure check: a `claude -p` that exits 0 but returns no usage block is a non-running artifact for cost-accounting purposes).

### Phase 1 — Wire into the escalation cascade
Add `"consult_advisor"` to `EscalationStrategy` (`escalation-cascade.ts:22`) and insert it **before** `"escalate_model"` in `DEFAULT_ORDER` (`:59`): `add_primer → increase_budget → consult_advisor → escalate_model → narrow_scope → hitl`. Add the `buildStrategyReasoning` case (`:71`). The orchestrator's Auto-Escalation Protocol (CLAUDE.md) gains a row: `consult_advisor → call consult_advisor MCP tool with the failing step's context, inject guidance into the re-spawn prompt`. This makes "ask Opus cheaply" a strictly-earlier, strictly-cheaper rung than promoting the whole agent.
- `max_uses` guardrail = per-step `advisor_calls` counter (Finding F), default cap 3, refusal is a `toolOk` value.

### Phase 2 — Extend to tester; add observability surface
Once Phase 1 data confirms net-positive (quality up OR cost down without quality loss), extend the affordance to the **tester** (flaky-vs-real judgment). Add an `advisor_calls` / `advisor_cost` rollup to `finalize_workspace`'s `FlowRunEntry` and a learner dimension watching advisor-consult ROI.

### Phase 3 — (DEFER) Demote opus agents to sonnet-executor + opus-advisor
The blog's biggest win (Haiku+Opus-advisor = 85% cost savings vs Sonnet-solo) is a *demotion* play. For reviewer/architect/security (currently opus end-to-end), the question is whether sonnet-executor + opus-advisor preserves quality. **High risk, defer** until Phase 1–2 prove the advisor mechanism is reliable in Canon. Do NOT lead with this.

### What to defer explicitly
- The builtin `advisor_20260301` API tool (Approach 2) — watch for Claude Code Agent-path exposure; adopt if it lands (would obsolete the `claude -p` shim's self-accounting burden).
- Opus-agent demotion (Phase 3).
- Wave-level advisor consults — already partially modeled by the dead `ConsultationResultSchema`; out of scope, flag to learner.

---

## Assumptions (surfaced)

- **A1:** `claude -p` is on PATH inside Canon build worktrees and inherits Claude Code auth (spike used it from the repo root; worktree context unverified). *If false, the shim needs an explicit binary path or auth env.*
- **A2:** `claude -p --model opus --output-format json` returns a `usage` block with token counts. *If false, Canon can only self-account latency, not Opus token cost — weakens the cost-observability story but not the quality story.*
- **A3:** A guidance-only Opus consult (≤700 tokens) is materially cheaper than a full opus whole-agent re-spawn. *Highly likely given the blog's 11.9% net reduction, but unmeasured in Canon — Phase 0 exists to measure it.*
- **A4:** The engineer's `NEEDS_CONTEXT` rate is high enough that an advisor rung pays for itself. *Unmeasured; Phase 0 shadow data decides.*

## Open Questions (for the user)

1. **Cost accounting depth:** Is latency-only self-accounting acceptable for Phase 0, or is true Opus token-cost (contingent on A2) a hard requirement before shipping? This gates whether Phase 0 can start before verifying `--output-format json`.
2. **Cascade vs always-on first:** Phase 0 proposes the standalone affordance first, cascade-wiring in Phase 1. Acceptable, or do you want the cascade insertion (Phase 1) as the very first slice because it's the cleaner conceptual fit?
3. **Scope of executor agents:** Limit to engineer for the first slice (recommended), or include tester from the start?

## Flags for the learner / follow-ups
- **Dead reference:** `recordConsultationResult` cited in `mcp-server/src/domains/board/README.md:37` has no implementation in board source — candidate doc-drift / dead-wire finding (matches Canon's known dead-wire defect class).
- **Stale CLAUDE.md ref:** mcp-server CLAUDE.md `features/` table lists a `prompt-pipeline/` directory ("Prompt assembly, context enrichment, consultation pipeline") that **does not exist on disk** (`ls` returned no such directory). Doc-freshness finding.

## Sources
- Advisor Strategy blog: https://claude.com/blog/the-advisor-strategy — builtin tool `advisor_20260301`, `max_uses`, billing, SWE-bench numbers, **API-beta-only availability** (`anthropic-beta: advisor-tool-2026-03-01`; no subagent/Agent integration).
- Feasibility proof: `.spike/spike-eval-iter3.ts:12,20` (`claude -p` via Claude Code auth).
- Subprocess seam: `mcp-server/src/platform/adapters/process-adapter.ts:39` (`runShell`); ADR-002 boundary (mcp-server CLAUDE.md Invariants).
- Cascade insertion point: `mcp-server/src/features/orchestration/services/escalation-cascade.ts:22,59,71,93`; tool wrapper `.../tools/get-next-escalation-strategy.ts:74`.
- Logging substrate: `execution-store.ts:267` (`appendEvent`); `board-state-schemas.ts:60-69` (`StateMetricsSchema`, `orientation_calls`).
- Agent tiers + decision points: `agents/engineer.md:129,248`; `agents/reviewer.md:604,736`; `agents/*.md` model frontmatter.
