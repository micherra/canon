# What Canon can learn from III (workers.iii.dev)

> Exploration artifact — a thinking document, not a spec. Produced 2026-06-27 from a
> deep-research pass over https://workers.iii.dev/ and linked sources, mapped against
> Canon's architecture. Per-claim confidence flagged; verified facts distinguished from
> inference. Persisted by the orchestrator after the research agent's write repeatedly
> cliffed — content is the agent's, transcribed verbatim.

## Cross-cutting caveat (read first)

The landing page frames III as **"Anthropic's III HQ."** This could **NOT be verified.**
Primary sources show an independent **`iii-hq`** org that is **Claude-*compatible*** (works
with Claude Code, Cursor, 30+ agents), not demonstrably Anthropic-owned. Treat the
ownership framing as **unconfirmed** throughout.

## 1. Executive summary (highest-value learnings, ranked)

1. III's **Worker / Trigger / Function** triad ("something hosts work, something causes
   it, something does it") is a cleaner, *smaller composable unit* than anything Canon
   has — Canon's smallest reusable unit is a heavyweight agent or a monolithic MCP
   server. The idea worth stealing is the **uniform contract**, not the registry.
2. III is **reactive / event-driven** (`iii-state` change-triggers → durable turn loop);
   Canon is deliberately **imperative** (dc-06: nothing auto-starts). This is the deepest
   tension — III shows reactive autonomous loops are buildable as a substrate.
3. III has a real **public distribution layer** (35 workers, 183k installs, verified-author
   badges, editor picks, collections); Canon ships everything in-repo though its artifact
   classes are already registry-shaped.
4. III's **observability is ONE uniform OTel substrate** (`iii-observability`); Canon's is
   fragmented across journal / decisions / checkpoint / drift / metrics.
5. III packages **loop infra + HITL approval-gate + isolation** (`iii-sandbox` microVMs) as
   installable workers; Canon builds these into the orchestrator.

## 2. What III is

A worker **registry + CLI + engine runtime**. Architecture rests on one triad:

- **Worker** — a small, single-purpose unit (either an "engine" runtime component or a
  "binary" standalone executable) that integrates with the "III engine," is discovered and
  installed via the CLI, and registers callable functions + reactive triggers under a
  uniform contract.
- **Function** — a callable the worker exposes (e.g. `iii-http`: expose functions as HTTP
  endpoints).
- **Trigger** — a reactive, event-driven hook (e.g. `iii-state`: distributed KV whose
  *changes fire triggers*), which is what drives autonomous loops.

**Collections** group workers by purpose: *iii-builtins* ("runtime workers that ship with
every iii engine"), *data-management* (Postgres/MySQL/SQLite), *agentic* ("autonomous loop
infrastructure"). Flagship workers reveal the model: `iii-http` (110k installs),
`iii-state` (30k, reactive change triggers), `iii-queue` (async jobs, retries, dead-letter),
`iii-observability` (OTel traces/metrics/logs/alerts/sampling), `iii-sandbox` (microVM
isolation, 14 `sandbox::*` triggers), pub/sub + durable streams, LLM provider abstraction,
and agent harness loops. Mental model: a **reactive effect-runtime** where state changes
drive autonomous loops, the worker is the unit of deployment/isolation, and composition
happens through functions + triggers.

## 3. Full enumerated III → Canon opportunity set

Every distinct opportunity, including rejects and already-haves.

1. **[adopt] Unify telemetry into one trace spine** — *M* — One append-only event schema +
   sink; project journal/decisions/checkpoint/drift/metrics as views. Mirrors
   `iii-observability`'s single OTel substrate. Highest leverage: makes
   trace-driven-evolution's provenance⋈failure attribution trivial.
2. **[explore] Reactive trigger substrate UNDER the orchestrator gate** — *L* — Internal
   event bus where artifact mutations emit subscribable events (à la `iii-state`
   change-triggers) instead of checkpoint-polling; keep dc-06 as policy (orchestrator alone
   initiates). Resolves the dc-06 tension: reactivity as substrate, gating as policy.
3. **[explore] Separate the two isolation problems; add an untrusted-execution sandbox
   tier** — *M–L* — Make explicit that worktrees isolate TRUSTED authorship while the queued
   overlay/trust-tier work needs a DISTINCT untrusted-execution boundary (container/microVM
   class), as `iii-sandbox` draws with its 14 `sandbox::*` triggers. Directly informs
   backlog work.
4. **[explore] "Canon pack" export/import (read-only) before any marketplace** — *M* —
   `canon pack export/import <class> <id>` tarballs for loops/routines/principles/primers
   (already frontmatter+registry shaped). Captures ~80% of III registry value (shareability)
   at ~5% of cost; defers hosting/trust/versioning.
5. **[explore] Mechanize HITL into a single gate primitive** — *S–M* — One
   `request_approval({gate, payload})` MCP call that every gate routes through, replacing the
   prose HITL catalog enforced behaviorally. Mirrors iii's approval-gate as a composable
   primitive; turns behavioral obligation into a deterministic, loggable call site.
6. **[explore] Smaller composable capability unit (the missing middle)** — *L / mostly
   conceptual* — III's Worker (single-purpose process, registers fns+triggers, uniform
   contract) sits between Canon's heavyweight agents and its monolithic MCP server. Worth a
   design exploration of whether Canon wants such a unit. The idea to steal is contract
   uniformity, not the registry.
7. **[explore] Decompose the loop/evolve/learner monolith into smaller units** — *L* — III's
   agentic collection ships loop infra as swappable workers
   (session-manager/context-manager/llm-router/approval-gate/sandbox). Extract Canon's
   loop-tick/evolve/learner into independently-testable units with narrow MCP contracts. Do
   AFTER the trace spine (#1) unifies their I/O.
8. **[explore] Live subscribable registries** — *M* — III's Engine lets tools "subscribe to
   changes" of the worker/function/trigger registry; Canon's
   list_loops/list_routines/list_principles are static reads. A change-subscription
   capability would feed #2.
9. **[explore] Durable queue substrate with dead-letter** — *M* — `iii-queue` offers named
   queues + retries + dead-letter. Canon has retry/backoff + escalation protocol (prose) and
   TaskQueue/DAG but no durable dead-letter. Could harden long-running/failed-agent handling.
10. **[explore] Direct III interop spike** — *S to scope* — III workers ship
    Claude-Code-installable skills; Canon is a Claude-Code plugin. Spike whether Canon could
    CONSUME an III worker (`iii-observability` as trace sink, `iii-queue` as DAG substrate)
    instead of building #1/#9 in-house — explicit buy-vs-build.
11. **[already-have] Functions/engine-routed calls ≈ MCP tools** — *no action* — Same idea,
    Canon's are bundled not independently installable; routing is fine.
12. **[already-have] Collections ≈ Canon artifact classes** — *no action* — Canon already
    groups by class; "collections" is just curation on top, low value pre-registry.
13. **[already-have / validate] Durable context-assembly + turn loop** — *no action* — iii's
    session-manager/context-manager/durable-turn-loop independently validate Canon's
    checkpoint/rehydration/get_context-batching design. Cite as external corroboration.
14. **[reject-with-reason] LLM provider abstraction (iii harness/llm-router)** — Canon is
    Claude-only by design; a multi-provider abstraction layer adds no value.
15. **[reject-with-reason] Per-worker config hot-reload** — Low ROI for a single-plugin
    system; Canon's coarse plugin-update reload is adequate.
16. **[reject-with-reason, for now] Hosted public marketplace** (verified authors, editor
    picks, install counts) — Canon has one primary consumer; a public registry is premature
    and a large security/trust surface. Revisit only if #4 sees cross-project demand.

## 4. Top 3 opportunities (the ranked recommendation)

1. **[adopt] Unify telemetry into one trace spine** *(M)* — directly accelerates the in-flight
   trace-driven-evolution epic.
2. **[explore] Reactive trigger substrate under the orchestrator gate** *(L)* — resolves the
   dc-06 tension cleanly: reactivity as substrate, gating as policy.
3. **[explore] Separate the two isolation problems; add an untrusted-execution sandbox tier**
   *(M–L)* — directly informs the queued overlay-inert-data-hardening / trust-tier backlog.

## 5. Open questions / could not verify

- **Ownership.** "Anthropic's III HQ" framing unverified (see top caveat).
- **Exact trigger semantics.** Whether III triggers are at-least-once / exactly-once, ordered,
  or durable across engine restarts — inferred from `iii-queue`/`iii-state` descriptions, not
  confirmed from primary docs.
- **Worker isolation boundary.** microVM-per-worker vs microVM-per-invocation not confirmed.
- **Interop reality.** Whether an III worker is genuinely installable/consumable from a
  Claude-Code plugin context (#10) is a spike, not a known fact.

## 6. Sources

- https://workers.iii.dev/ (registry landing page — worker list, install counts, collections)
- Worker detail pages: `iii-http`, `iii-state`, `iii-queue`, `iii-observability`, `iii-sandbox`
- `iii-hq` org / CLI docs and related Claude-compatible-agent references (web search)

## 7. Roadmap audit of the ethos-fits

> Added 2026-06-28 by an explore/audit pass. Maps the ethos-FITTING subset of §3 against
> Canon's actual roadmap (memory `project_*` entries + in-flight `docs/explore/` + live git/PR
> state). Verdicts cite PR numbers, branches, and memory entries verified against the tree on
> 2026-06-28 (HEAD `cee7f54e`).

### Audit table

| Fit | Roadmap status | Mapped epic / PR# / memory-entry | Verdict | Recommended next move |
|---|---|---|---|---|
| **#1 Unified trace spine** (one append-only event substrate; journal/decisions/checkpoint/drift/metrics as views) | **in-flight (partial substrate exists) + net-new for the unification** | Trace-driven-evolution epic (`project_trace_driven_evolution_decisions`): provenance #413, fitness gate #414, attribute_failure #418, Mutator #421, evolve loop #423. Existing substrate: execution-store **event log** (`appendEvent` / `FlowEventMap` typed events / `correlation_id`, `mcp-server/src/domains/messages/events.ts`) + `post_event` MCP tool. MP-2/MP-5 telemetry backlog (`project_mp2_parameter_logging`, `project_mp5_efficiency_index`). | **reframe-of-existing + prerequisite refactor** — NOT a duplicate of TDE provenance. TDE solved *attribution* (provenance⋈failure join) on top of fragmented stores; #1 proposes *unifying the stores themselves*. A typed append-only event log already exists but journal.json, decisions ledger, checkpoint.md, the separate drift SQLite, and metrics are **not yet views over it**. | Do NOT open as a parallel track. Frame as a **consolidation refactor inside the trace-evolution epic, sequenced AFTER Phase 1 stabilizes** (#423 just landed). Pre-work: inventory the 5 stores' write sites, design the unified event schema as a superset of `FlowEventMap` + `ContextProvenanceRecord`, prove journal-as-view first (lowest risk), defer drift/metrics. This also unblocks MP-2/MP-5 (their data lands in the spine for free). |
| **#5 HITL gate primitive** (`request_approval({gate, payload})` MCP call every gate routes through) | **net-new** (no `request_approval` tool exists — grep-confirmed) | Adjacent to: parked runbook→Workflow-compilation direction (`project_harness_workflow_compilation_direction`, G8 tier→gate semantics + "HITL = segment-at-gates"); the prose HITL catalog (`references/hitl-patterns.md`); decisions ledger `log_decision` (#394) which already durably records gate *outcomes*. | **genuinely-new (architectural debt-paydown)** — turns the behaviorally-enforced "Honesty clause" obligation into a deterministic loggable call site. Complements, not replaces, `log_decision` (that records the *outcome*; this would mechanize the *request*). | Scope as a **Small standalone build**, independent of #1. Highest-value slice: a single `request_approval` MCP tool that (a) renders the gate payload, (b) fires `PushNotification`, (c) writes the decision-ledger row, (d) blocks. Migrate the 9-pattern HITL catalog to call it incrementally. Sequence it to land BEFORE the runbook→Workflow compiler (its G8 segment-at-gates seam needs exactly this primitive). |
| **#6/#7 Uniform contracts + decompose loop/evolve/learner monolith** | **partially realized (discipline shipped) + net-new for loop-tick** | `model-step-in-agent-layer` convention (.canon/, #421) + `no-llm-calls-in-mcp-tools`; the TDE epic already extracted **narrow deterministic MCP tools** (`select_mutation_targets`, `attribute_failure`, `evaluate_candidate` under `features/evolution/tools/`) with the model step in the `evolve-candidate` skill. Loop framework (`project_loop_integration_explored`, Phases A–E) made loops a uniform artifact class with a **generic** runner (dc-03). | **reframe-of-existing-discipline** for evolve/learner (already decomposed into narrow contracts); **additive** for the loop-tick runner and the learner's monolithic dimensions. | LOW urgency — the contract-uniformity ethos is already an enforced convention. Targeted next move: only decompose where a unit is still monolithic and hard to test (the learner's multi-dimension pass; the loop-tick observe→diff→surface body). Gate this behind #1 (the trace spine unifies their I/O — §3 item #7 explicitly says "do AFTER the trace spine"). Not a standalone epic. |
| **#3 Untrusted-execution sandbox tier** (container/microVM boundary distinct from worktree) | **net-new — DISTINCT from the in-flight trust-tier work** | In-flight branch `canon/overlay-inert-data-hardening-4-redesign…` (Layers A–D: neutralize + fence + `trust_tier` schema, commits `8f710110`→`29597f35`, **NOT on main**); `project_posthog_context_mill_phase0` QUEUED→now in-flight. `ContextProvenanceRecord` trust_tier (Layer 3, `inert-B`). No microVM/container isolation exists (`features/evolution` "sandbox" = eval temp-dir candidate injection, not an exec boundary). | **genuinely-new** — the overlay/inert-data work is **data-neutralization at context assembly** (treat untrusted overlay text as inert data); #3 is an **execution isolation boundary** for running untrusted code. Orthogonal problems sharing the word "trust." Worktrees isolate *trusted authorship*; neither existing track gives an untrusted-*execution* boundary. | Keep OUT of the inert-data build (don't conflate). Park as **explore-grade** until a concrete untrusted-execution need exists — Canon runs only its own agents today, so the threat surface is hypothetical. Revisit if/when Canon consumes third-party workers (§3 #10 interop spike) or runs user-supplied code. Lower priority than #1/#5. |
| **#2/#8 Reactive event substrate UNDER the orchestrator gate** + subscribable registries | **net-new (substrate seeds exist) — gated behind #1** | In-process `EventEmitter` + typed `FlowEventMap` already exist (`events.ts`); `cliff_detected` is already emitted+consumed. `list_loops`/`list_routines`/`list_principles` are static reads (the §3 #8 "subscribe to changes" gap). dc-06 non-declarative invariant (root CLAUDE.md Loop Framework). | **prerequisite-dependent / additive** — reactivity-as-substrate, gating-as-policy resolves the dc-06 tension cleanly (the brief's #2 framing). Does **NOT threaten dc-06**: dc-06 governs *who initiates a flow* (orchestrator only); an internal event bus that *notifies* without auto-spawning preserves it. The threat would only arise if a subscriber auto-dispatched — which the design explicitly forbids. | **Blocked-by #1.** A durable subscribable event bus is the same substrate as the trace spine viewed reactively — building #2 before #1 would create a second event store to later reconcile. Sequence: #1 unifies the append-only log → #2 adds a subscription/notification layer over it → registries become live. For the loop roadmap this is **enabling, not blocking**: harness-watch/evolve currently poll via `get_build_history`; a change-subscription would let them react instead of poll — a clean optimization, not a dependency. |
| **#13 Durable context/turn loop** (confirmation-only) | **shipped (validated)** | `write_orchestrator_checkpoint` + `get_decisions` + In-Session Compaction Rehydration (#394); `reconcile_workspace` cliff detection; `get_context` batching; `disk-is-source-of-truth-on-resume` convention (#406). | **redundant (external corroboration only)** — III independently validates Canon's existing checkpoint/rehydration/get_context design. No build. | No action. Cite as external corroboration in any future design doc that touches the checkpoint/rehydration design. Close as "validated." |

### Resolving the four pointed questions

1. **Does #1 duplicate/subsume TDE provenance (#413/#414/#418) and the MP-2/MP-5 backlog?**
   Neither duplicates nor is duplicated. TDE built *attribution* (provenance⋈failure) over today's
   fragmented stores; #1 is the **prerequisite consolidation refactor** those stores never got. A
   typed append-only event log already exists (`appendEvent`/`FlowEventMap`) but journal/decisions/
   checkpoint/drift/metrics are not yet views over it. #1 belongs **inside the trace-evolution
   epic, sequenced after Phase-1 stabilization** — a parallel track would fork the event schema.
   MP-2/MP-5 (blocked on telemetry depth) become near-free once their data lands in the spine.

2. **Is #3 sandbox tier the same as the queued overlay/trust-tier work?**
   **No — genuinely distinct.** The overlay-inert-data-hardening branch (Layers A–D, in-flight,
   not on main) does **data-neutralization at context assembly** (untrusted overlay text → inert
   data, plus a `trust_tier` provenance field). #3 is an **execution isolation boundary** for
   running untrusted *code*. Same word, orthogonal problems. Do not fold #3 into the inert-data
   build.

3. **Are #2/#8 blocked-by or enabling-for the loop roadmap? Does it threaten dc-06?**
   **Enabling, not blocking** for loops (harness-watch/evolve poll today; a change-subscription
   lets them react). **Blocked-by #1** itself (don't build a second event store). **Does not
   threaten dc-06** — dc-06 constrains *initiation* (orchestrator only); an internal
   notify-without-auto-spawn bus preserves it. dc-06 stays as policy on top of the reactive
   substrate, exactly the brief's #2 thesis.

4. **For #5 gate primitive and #6/#7 decomposition — on any roadmap?**
   **#5 is net-new** (no `request_approval` exists), but adjacent to the parked
   runbook→Workflow-compilation G8/segment-at-gates design — and a **prerequisite** for it.
   Worth a Small standalone build now; complements (doesn't replace) `log_decision`.
   **#6/#7 is partly already-shipped discipline** — `model-step-in-agent-layer` +
   `no-llm-calls-in-mcp-tools` conventions and the TDE epic's narrow deterministic MCP tools
   already embody contract uniformity. Net-new only for the still-monolithic loop-tick runner and
   the learner's multi-dimension pass; §3 itself says do it AFTER #1.

### Sequencing recommendation

Given the dependencies, tackle the fitting items in this order:

1. **#5 HITL gate primitive** (`request_approval`) — **start now, independent, Small.** No upstream
   dependency; pays down the behavioral-obligation debt the Honesty clause flags; and it is the
   load-bearing seam the parked Workflow-compilation direction (G8) will later need.
2. **#1 Unified trace spine** — **next, but sequenced after TDE Phase-1 settles** (#423 just
   landed; let it stabilize). Frame as a consolidation refactor *inside* the trace-evolution epic,
   not a parallel track. Unblocks MP-2/MP-5 as a side effect.
3. **#2/#8 Reactive substrate + live registries** — **blocked on #1.** Build the subscription/
   notification layer over the unified log once it exists; then make `list_*` registries live.
   Converts loop polling to reactive as a clean follow-on.
4. **#6/#7 Decompose loop-tick/learner monolith** — **blocked on #1** (per §3 #7: "do AFTER the
   trace spine unifies their I/O"). Low urgency; the contract-uniformity ethos is already an
   enforced convention, so this is targeted cleanup of the few remaining monolithic units, not an
   epic.
5. **#3 Untrusted-execution sandbox tier** — **park as explore-grade.** No concrete need while
   Canon runs only its own agents; distinct from the in-flight inert-data/trust-tier work. Revisit
   only if the §3 #10 III-interop spike or user-supplied-code execution materializes.
6. **#13 Durable context/turn loop** — **no work; close as validated** external corroboration of
   the shipped checkpoint/rehydration design.

**Net:** only **#5** is unblocked-and-actionable today. **#1** gates #2/#8 and #6/#7 and should be
sequenced behind TDE Phase-1 stabilization. **#3** parks; **#13** closes.
