# Advisor Strategy in Canon — Exploration Brief

## Status: Complete (revised 2026-06-09 — see Re-test section)

**Mode:** Exploration (no code, read-only). **Date:** 2026-06-09.
**Question:** How can we leverage the Advisor Strategy in Canon?

> **REVISION NOTICE (2026-06-09):** New information surfaced after the original brief — `/advisor` exists as an installed **Claude Code skill** (description: "Let Claude consult a stronger model at key moments"), distinct from the `advisor_20260301` Messages-API builtin the original brief analyzed. This reopens the feasibility question. See **"Re-test: /advisor as an installed skill"** immediately below. The original analysis (TL;DR points 1–4, Approaches, Recommendation) is **preserved but conditionally superseded** — superseded items are marked inline with **[SUPERSEDED-IF-SKILL-INVOCABLE]**.

---

## Re-test: /advisor as an installed skill (revises prior conclusion)

### What changed

The original brief's load-bearing finding was: *the Anthropic builtin `advisor_20260301` is a Messages-API-only beta tool, unreachable from Canon's `Agent`-spawn path.* **That finding about the API builtin remains true and is unaffected.** What it missed: `/advisor` ALSO exists as an **installed Claude Code skill** — a different mechanism entirely. It appears in slash-command autocomplete alongside `/deep-research`, ships inside the Claude Code app bundle (not as a `SKILL.md` under `~/.claude`), and is invoked via the native **`Skill` tool**. Skills are a runtime-invocable capability; the API builtin is a request-construction-time tool. They are NOT the same mechanism, and the new one may be reachable where the old one is not.

### The load-bearing question is now: can a Canon-spawned subagent invoke the `Skill` tool?

This is a **tool-allowlist question**, and Canon's architecture gives a clear, grounded answer for the mechanism — the empirical confirmation is being probed in parallel.

**Mechanism analysis (grounded in repo):**

1. **Canon agents have an explicit, closed `tools:` allowlist.** Every agent definition (`agents/*.md`) declares a `tools:` block — the exhaustive set of tools that spawned subagent may call. The engineer lists 12 tools (`agents/engineer.md` frontmatter: Read, Write, Edit, Bash, Glob, Grep, WebFetch, + 5 `mcp__canon__*`). **`Skill` is not among them.** No Canon agent lists `Skill` in `tools:` (`grep '  - Skill' agents/` → zero matches). Therefore, **as the repo stands today, no Canon subagent can invoke `/advisor`-the-skill** — not because the harness forbids it, but because Canon's own least-privilege allowlist never grants it. *Verified in repo.*

2. **The `skills:` frontmatter field is a RED HERRING — it is not the `Skill` tool.** Four agents (`architect`, `learner`, `writer`, `planner`) declare a `skills:` field (e.g. `canon:synthesize`). This is **Canon's own bundled-skill preloader, not the native `Skill` tool.** The authoritative explanation is in `resolve-agent-skills.ts:28-35`: Canon deliberately keeps its rules/references/primers/templates OUT of the native `skills:` mechanism and resolves them itself as flat `.md` files injected as preload TEXT. The `canon:synthesize` etc. references resolve to `skills/canon/skills/<name>/` and are loaded by `resolve_agent_skills` into the spawn prompt — they are never invoked via a `Skill` tool call at runtime. **Conclusion: declaring `skills:` in an agent grants zero `Skill`-tool access.** Granting `/advisor` would require adding `Skill` to the agent's `tools:` block, exactly as `WebSearch`/`LSP` were granted in the prior harness-capabilities build. *Verified in repo (`resolve-agent-skills.ts:16-41`; `agents/*.md` frontmatter).*

3. **Is `Skill` even grantable to a subagent, or is it subagent-excluded like `EnterPlanMode`?** This is the decisive sub-question, and the repo carries a directly-relevant precedent. The prior `harness-capabilities-round1` build (`.canon/workspaces/canon--harness-capabilities-round1/.../DESIGN.md:73`) documents a **subagent tool-exclusion list** — tools that depend on main-conversation UI/session state and are *inert even if listed* in `tools:`: **`Agent`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `ScheduleWakeup`, `WaitForMcpServers`.** **`Skill` is NOT on that documented exclusion list.** That same build successfully granted `WebSearch`/`LSP` to subagents by adding them to `tools:`, proving the allowlist-grant path works for non-excluded tools. **So the mechanism analysis says: `Skill` is *probably* grantable to a subagent via `tools:`, the same way `LSP` was** — but with one caveat below. *The exclusion list itself was the prior architect's knowledge-grounding, not a harness-source extraction → treat as high-confidence-but-not-verified. This is precisely what the parallel live probe resolves.*

**What must be true for branch (a) [skill-invocable] to hold:**
- `Skill` is not in the harness's subagent-exclusion set (probe confirms).
- The `/advisor` skill is discoverable/invocable by name from a subagent context (it ships in the app bundle, not `~/.claude` — so it is not a user-registered SKILL.md; whether bundle-shipped skills are exposed to subagents is the empirical unknown). **Assumption, not verified.**
- The harness `.claude/settings.json` permission layer allows `Skill` (current allow-list does NOT list `Skill`; `agents/*.md tools:` is the per-agent grant, but the harness-level `permissions.allow` may also gate it — `Skill` is absent there too, `.claude/settings.json`). **This is a second gate the original instruction underweighted: a `tools:` grant may be necessary but not sufficient if the harness permission layer also screens `Skill`.** *Verified absent in repo; effect unverified.*

### What `/advisor`-the-skill actually does (knowable vs assumption)

- **Knowable from its description** ("Let Claude consult a stronger model at key moments"): it is a guidance-consultation affordance — same INTENT as the API builtin and the same intent as the original brief's `consult_advisor` shim.
- **NOT knowable from the repo:** its *mechanism*. Two possibilities, materially different for cost/observability:
  - **(i) Server-side handoff** — the skill internally triggers the same `advisor_20260301` builtin within the current request. If so, context is shared natively, billing is native, but it is invisible to Canon's execution store (no `advisor_consulted` event unless Canon wraps the call).
  - **(ii) Skill orchestrates a separate `claude -p`-style call** — the skill spawns/queries a stronger model out-of-band. If so, it is closer to the original brief's shim, with the same self-accounting gap.
- **My lean (assumption, flagged):** given it is packaged as a *skill* (an instruction/orchestration artifact) rather than exposed as a tool-type, it most likely **drives a model consultation via skill instructions** (closer to ii or a hybrid) rather than being a thin wrapper over the API builtin — but **this is inference, not verified.** The cost-accounting and context-sharing answer hinges entirely on this, and the repo cannot resolve it. *Assumption — requires the live probe or Claude Code skill-source inspection.*

### Revised feasibility verdict — both branches explicit

**Branch (a) — `/advisor`-as-skill IS subagent-invocable (probe confirms `Skill` grantable + bundle skill reachable):**
- The `consult_advisor` MCP shim from the original brief becomes **largely unnecessary.** Adoption collapses to **instruction-only + one allowlist line**:
  1. Add `Skill` to the relevant agent's `tools:` block (e.g. `agents/engineer.md`) — one line, exactly like the `LSP`/`WebSearch` grants in `harness-capabilities-round1`.
  2. Add a short protocol paragraph to the agent body (`engineer.md`) at its decision points: *"At `NEEDS_CONTEXT` (ambiguous plan / design-flaw) or a borderline Canon-exception judgment (`:129`), before bouncing to HITL or guessing, invoke `/advisor` with the specific decision and ≤700-token context. Treat the returned guidance as advisory; do not let it expand scope."*
  3. **Zero new MCP code, zero new subprocess seam, zero ADR-002 surface.**
  - **What the `engineer.md` edit looks like:** +1 line in `tools:` (`  - Skill`) and a ~6-line "Advisor consultation" subsection in the body near `:248`. That's the entire change for the engineer.
  - **How `max_uses` / observability work WITHOUT a shim — this is the branch's real weakness:** the original brief's clean story (per-step `advisor_calls` counter via `StateMetricsSchema.orientation_calls` precedent; `advisor_consulted` event via `appendEvent`) **does not apply** to a native-`Skill` invocation, because the skill call happens *inside the agent's turn loop, invisible to Canon's MCP layer.* Canon would have **no automatic event, no call counter, no cost capture** for a native `/advisor` invocation. Options: (i) accept loss of observability (advisor calls become as invisible as any other in-agent tool use, surfaced only via transcript capture — `capture_transcript` already harvests the agent JSONL, so a post-hoc grep for `/advisor` invocations in the transcript is the cheapest observability path); (ii) keep a thin `consult_advisor` MCP wrapper ANYWAY purely as the *instrumented* path and instruct the agent to call the wrapper instead of the raw skill — which re-introduces most of the shim and erases the "zero code" advantage. **Net: branch (a) trades the shim's code cost for an observability/`max_uses` gap.** Whether that trade is worth it depends on whether the user wants per-call advisor cost accounting (original Open Question 1).

**Branch (b) — NOT subagent-invocable (probe shows `Skill` is subagent-excluded OR bundle skills aren't exposed to subagents OR harness `permissions.allow` screens it):**
- **Fall back to the original brief's `consult_advisor` MCP shim, unchanged.** The `claude -p --model opus` shim via `runShell` (Approach 1, `process-adapter.ts:39`) remains the only Canon-native path, and the whole original Recommendation (Phase 0 shadow-measure → Phase 1 cascade-wiring) stands as written. In this branch the original brief is **not superseded at all** — the skill re-test simply confirms there was no shortcut.

**Which branch each Canon agent lands in** (independent of (a)/(b), this is about WHICH agents would adopt advisor at all — unchanged from the original Finding A):
- **engineer (sonnet)** → primary adopter in BOTH branches (decision points `engineer.md:248` NEEDS_CONTEXT, `:129` Canon-exception). In branch (a): gets `Skill` in `tools:` + protocol text. In branch (b): gets the `consult_advisor` shim affordance.
- **tester (sonnet)** → secondary adopter, Phase 2, BOTH branches (flaky-vs-real judgment).
- **scribe (sonnet)** → **NOT an adopter in either branch.** Mechanical doc-sync; no hard decision point warrants a stronger-model consult. (Original Finding A: LOW fit.)
- **reviewer / architect / security (opus)** → already top-tier; advisor is redundant for them (they ARE the advisor tier). Unchanged.

### Bottom line of the re-test

The new information **does not invalidate the original brief's API-builtin finding** (still true: builtin unreachable). It **adds a possible shortcut** (skill-invocation) that, IF the probe confirms subagent-invocability AND the user accepts the observability gap, **reduces the engineer adoption to ~7 lines of agent-markdown edits and zero MCP code** — superseding the shim-build recommendation for branch (a). If the probe disconfirms, **nothing changes** and the original shim recommendation stands. The decision is gated on the parallel live probe (`Skill`-tool subagent-invocability) and Open Question 1 (is per-call advisor cost-accounting a hard requirement — if yes, even branch (a) wants an instrumented wrapper, narrowing the gap between the branches).

---

## TL;DR (opinionated)
<!-- [SUPERSEDED-IF-SKILL-INVOCABLE]: Points 2–4 below assume the consult_advisor MCP shim is the only path. If the parallel probe confirms /advisor-the-skill is subagent-invocable, see branch (a) in the Re-test section — the shim becomes optional and adoption is instruction-only. Point 1 (API builtin unreachable) is UNAFFECTED and remains true. -->


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

## Broader skill-leverage survey

Beyond `/advisor`, which OTHER installed Claude Code skills could Canon leverage, and where? **The same subagent-invocability dependency applies to EVERY row** — none of these is reachable from a Canon subagent unless `Skill` is (a) not subagent-excluded and (b) added to that agent's `tools:` allowlist (and possibly cleared at the harness `permissions.allow` layer). One line per skill: real leverage vs redundant-with-existing-Canon.

| Skill | Candidate Canon home | Verdict | Notes |
|-------|---------------------|---------|-------|
| **`/advisor`** | engineer / tester (sonnet) at decision points | **Real leverage** | The whole subject of this brief — fills the "ask a stronger model one question" gap between guess and whole-agent `escalate_model`. Subagent-invocability gated on the probe. |
| **`/deep-research`** | architect (research arm) / learner (pattern mining) | **Partial leverage, mostly redundant** | The architect ALREADY owns codebase research via `semantic_search` + `get_file_context` + `graph_query` + `WebFetch`/`WebSearch` (granted in `harness-capabilities-round1`). `/deep-research` would only add value for *external/web-heavy* research the architect can't satisfy with WebFetch — a narrow slice. Learner is data-mining its own stores, not external research → no fit. **Low priority.** |
| **`/verify`** | tester (functional-verification gap) | **Real leverage — highest-value non-advisor candidate** | Canon has a known, repeatedly-flagged gap: the tester must functionally verify new features, not just run the suite (user feedback: `feedback_test_features_before_merge`, `feedback_reviewer_must_build`). If `/verify` drives independent functional verification, it directly addresses that gap. **Worth a dedicated probe.** Same subagent-invocability dependency. |
| **`/claude-md-improver`** | scribe (context-sync) | **Redundant with existing Canon** | The scribe ALREADY owns CLAUDE.md/CONVENTIONS.md sync and has a hardened scope-guard against over-trimming (`feedback_always_both_docs`, post-scribe scope guard in CLAUDE.md). An external CLAUDE.md improver would *conflict* with Canon's surgical-sync discipline and the scribe's scope guard. **Skip — Canon's version is more constrained and safer.** |
| **`/frontend-design`** | renderer agents (design/review HTML) | **Marginal — possible leverage, low priority** | Renderers fill `templates/renderer-*.md` against `mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` (the authoritative design system). `/frontend-design` could help generate NEW snippet recipes but would risk drifting from the existing locked design system (user feedback: `feedback_renderer_match_existing_ui` — review HTML MUST match existing UI patterns). **Skip for production rendering; possibly useful as a one-off design-exploration aid outside the build loop.** |
| **`/code-review`** | reviewer (comparison baseline) | **Redundant with existing Canon, but useful as a baseline probe** | Canon's reviewer is a heavily-specialized opus agent (5-stage protocol, principle-grounded, craft-profile scoring, MCP-tool functional verification). `/code-review` would be a *weaker generic* substitute — NOT a replacement. **Only leverage: run it once as a baseline to measure how much Canon's specialized reviewer beats a generic one** (craft-metric validation). Not a production path. |
| **`/simplify`** | reviewer / engineer (simplicity-first enforcement) | **Redundant with existing Canon** | Canon already enforces `simplicity-first` / `no-dead-abstractions` via the reviewer and the engineer's `agent-simplify-before-extending` rule. `/simplify` overlaps existing principle enforcement. **Skip — no incremental leverage.** |

**Survey conclusion:** Only **`/advisor`** (this brief) and **`/verify`** (tester functional-verification gap) represent genuine net-new leverage. Both are gated on the identical subagent-invocability question. Everything else is either redundant with a more-constrained Canon equivalent (`claude-md-improver`, `simplify`, `code-review`) or a narrow/risky marginal add (`deep-research`, `frontend-design`). **Recommendation: if the live probe confirms `Skill` is subagent-invocable, prioritize a `/verify`-for-tester probe immediately after `/advisor`-for-engineer — it addresses a documented, recurring Canon quality gap.**

---

## Sources
- Advisor Strategy blog: https://claude.com/blog/the-advisor-strategy — builtin tool `advisor_20260301`, `max_uses`, billing, SWE-bench numbers, **API-beta-only availability** (`anthropic-beta: advisor-tool-2026-03-01`; no subagent/Agent integration).
- Feasibility proof: `.spike/spike-eval-iter3.ts:12,20` (`claude -p` via Claude Code auth).
- Subprocess seam: `mcp-server/src/platform/adapters/process-adapter.ts:39` (`runShell`); ADR-002 boundary (mcp-server CLAUDE.md Invariants).
- Cascade insertion point: `mcp-server/src/features/orchestration/services/escalation-cascade.ts:22,59,71,93`; tool wrapper `.../tools/get-next-escalation-strategy.ts:74`.
- Logging substrate: `execution-store.ts:267` (`appendEvent`); `board-state-schemas.ts:60-69` (`StateMetricsSchema`, `orientation_calls`).
- Agent tiers + decision points: `agents/engineer.md:129,248`; `agents/reviewer.md:604,736`; `agents/*.md` model frontmatter.

### Sources added for the re-test (skill mechanism)
- **`skills:` field ≠ `Skill` tool:** `mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts:16-41` (authoritative comment — Canon resolves its `rules/references/primers/templates`/bundled-`skills:` itself as preload TEXT, deliberately kept OUT of the native `skills:` mechanism; never a runtime `Skill` tool call). Canon's bundled skills live in `skills/canon/skills/{synthesize,refine,analyze-patterns,write-principle}/`.
- **No agent grants `Skill`:** `agents/*.md` `tools:` frontmatter (`grep '  - Skill' agents/` → zero matches); engineer allowlist is 12 tools, none is `Skill`.
- **Subagent tool-exclusion list (precedent):** `.canon/workspaces/canon--harness-capabilities-round1/expose-three-claude-code-harness-capabilities-to-canon/plans/.../DESIGN.md:73` — documents `Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode, ScheduleWakeup, WaitForMcpServers` as subagent-inert-even-if-listed; **`Skill` is NOT on that list** (architect knowledge-grounding, not harness-source-verified → the parallel probe resolves it). Same build proved `WebSearch`/`LSP` are grantable to subagents via `tools:` (`DESIGN.md:95,97`).
- **Harness permission layer:** `.claude/settings.json` `permissions.allow` — does NOT list `Skill` (a possible second gate beyond per-agent `tools:`; effect unverified).
- **`/advisor`-the-skill mechanism (i vs ii):** unknowable from repo — requires live probe or Claude Code skill-source inspection. Flagged as assumption.
