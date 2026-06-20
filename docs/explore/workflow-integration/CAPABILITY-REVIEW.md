<!-- Persisted from .canon/history/fresh-architect-review-of-claude-code-workflow-tool — explore flow 2026-06-07; competition: 3 proposals, 3 judges, synthesis ratified at HITL -->
## Status: Complete

# Capability Review — Claude Code `Workflow` Tool vs Canon Orchestration

> Research-only deliverable (2026-06-07). Neutral, shared fact base for three competing
> design teams proposing Workflow-into-Canon integrations. No integration design is
> advocated here. Sources: `research/workflow-tool-spec.md` (authoritative for the
> Workflow tool), Canon as-built (`CLAUDE.md`, `references/`, `agents/`, `hooks/`,
> `mcp-server/src/features/orchestration/`), prior art read last
> (`docs/supervised-build-quality.md` § "New Epic — Deterministic Spine", lines 152–171).

## ASSUMPTIONS

- **A1 — Hooks fire for workflow-spawned subagents.** The spec is silent on whether
  PreToolUse/PostToolUse hooks (`hooks/hooks.json`) run inside agents spawned via
  `agent()`. Canon's current DAG workers (spawned via the Agent tool) do get hooks, and
  `agentType` resolves "from the SAME registry as the Agent tool," so I assume parity.
  If false, the L4 backstop layer (workspace-check, destructive-guard) is absent inside
  workflows — design teams MUST verify empirically before relying on it.
- **A2 — Agent frontmatter tool allowlists are honored** for `agentType: 'canon:*'`
  agents inside workflows (same registry as Agent tool). The ToolSearch sentence in the
  spec describes MCP schema loading, not allowlist override.
- **A3 — Workflow agents can run Bash/git** (they are normal subagents; only the
  *script* is sandboxed). All worktree/commit mechanics therefore remain available at
  the agent level even though the script has no fs access.
- **A4 — `meta.phases` model field is display-only** ("model = display note"), so model
  routing is done per-`agent()` via `opts.model`, not per-phase.

These assumptions do not change the constraint ledger; they change which integration
shapes are cheap. Teams should budget one empirical probe each for A1 and A2.

---

## 1. Workflow tool capability map

Authoritative source: `research/workflow-tool-spec.md` (workspace-relative). Everything
below is restated from it; section refs are to that file.

### 1.1 Execution model

| Property | Fact |
|---|---|
| What runs | Self-contained **plain JavaScript** orchestration script; control flow in code, not model-driven |
| Where it runs | Sandboxed JS context: standard built-ins only; **no fs, no Node APIs**; async body (`await` directly) |
| Determinism contract | `Date.now()`, `Math.random()`, argless `new Date()` **throw**. Timestamps come in via `args`; variation by index, not randomness |
| Background | Returns immediately with task ID + `runId`; `<task-notification>` on completion; `/workflows` shows live progress to the user |
| Journaling | Every `agent()` call's (prompt, opts) → result is recorded per run (harness-side), enabling prefix-cached resume |
| Opt-in | Orchestrator may invoke Workflow **only** when user opted in: keyword "ultracode", session toggle, user asks for workflow/orchestration in own words, **a skill instructs it**, or user invokes a named/saved workflow |
| Script persistence | Inline `script` (≤512KB) is auto-persisted to a session-directory file; path returned in tool result. Iterate by editing the file and re-invoking with `{scriptPath}` |
| Saved workflows | `name` param loads built-ins or `.claude/workflows/` entries, parameterized via `args` |
| `meta` export | Mandatory PURE LITERAL (no variables/calls/spreads/interpolation): `name`, `description` (shown in permission dialog), optional `whenToUse`, optional `phases[]` matched EXACTLY by title against `phase()` calls |
| Return value | Script `return` becomes the tool result the orchestrator reads |

### 1.2 Primitives

**`agent(prompt, opts?) → Promise<any>`** — spawn a subagent.
- No `schema`: returns final text as string (agent is told its text IS the return value).
- `opts.schema` (JSON Schema): agent forced through a StructuredOutput tool; returns a
  **validated object**; validation at tool-call layer → model retries on mismatch.
- `opts.agentType`: custom subagent type (`'canon:reviewer'`, `'canon:engineer'`, …) —
  resolved from the **same registry as the Agent tool**; composes with `schema`.
- `opts.model`: `'sonnet' | 'opus' | 'haiku'` override; default inherits session model.
- `opts.label`, `opts.phase`: display/progress-group control (`opts.phase` avoids races
  on global `phase()` state inside `pipeline()`/`parallel()`).
- `opts.isolation: 'worktree'`: fresh worktree per agent, ~200–500ms + disk each,
  auto-removed if unchanged, **auto-merges to calling branch on completion** — the spec
  itself flags this as bypassing Canon's controlled merge lifecycle (Canon CLAUDE.md
  prohibits it for code-writing agents).
- **Never throws to the script**: returns `null` if the user skips the agent mid-run
  (via `/workflows`) or the agent dies on terminal API error after retries. Idiom:
  `.filter(Boolean)`.

**`pipeline(items, ...stages) → Promise<any[]>`** — per-item staged flow with **no
barrier between stages** (item A in stage 3 while item B in stage 1). DEFAULT for
multi-stage work; wall-clock = slowest single-item chain. Stage callbacks get
`(prevResult, originalItem, index)`. A throwing stage drops that item to `null`.

**`parallel(thunks) → Promise<any[]>`** — concurrent with a **barrier**; failed thunks
resolve to `null`; the call never rejects. Barrier-choice discipline (verbatim): a
barrier is justified ONLY when stage N needs cross-item context from ALL of stage N−1
(dedup/merge, aggregate early-exit, "the other findings" prompts). Smell test:
`parallel → pure transform → parallel` means the barrier was unnecessary.

**`workflow(nameOrRef, args?) → Promise<any>`** — run another workflow inline (saved
name or `{scriptPath}`). Child **shares** concurrency cap, agent counter, abort signal,
and token budget. **Nesting is one level only** — `workflow()` inside a child throws.
Throws on unknown name / unreadable scriptPath / child syntax error.

**`budget`** — `{total, spent(), remaining()}` in **output tokens**, shared across main
loop + all workflows this turn. `total` comes ONLY from a user "+500k"-style directive
(else `null`, `remaining() === Infinity`). HARD ceiling: at `total`, further `agent()`
calls THROW.

**`phase(title)` / `log(message)`** — progress grouping and narrator lines.
**No-silent-caps rule**: any bounded coverage (top-N, sampling, no-retry) must be
`log()`ged.

**`args`** — the invocation's `args` JSON, verbatim (must be real JSON, not stringified).

### 1.3 Limits

| Constraint | Value |
|---|---|
| Concurrent `agent()` per workflow | min(16, CPU cores − 2); excess queues |
| Lifetime agents per workflow | 1,000 |
| Items per `pipeline()`/`parallel()` call | 4,096 (explicit error, never silent truncation) |
| `workflow()` nesting | 1 level |
| Script size | 512KB |

MCP: workflow agents reach **all session-connected MCP tools via ToolSearch** (schemas
on demand). Caveat: interactively-authenticated MCP servers may be absent in
headless/cron runs.

### 1.4 Resume

`{scriptPath, resumeFromRunId}` (same session; TaskStop prior run first). The **longest
unchanged prefix** of `agent()` calls — matched on exact (prompt, opts) — returns cached
results instantly; first changed/new call onward runs live. Same script + same args →
100% cache hit. This is the reason for the nondeterminism ban: a timestamp in a prompt
would invalidate the cache from that point on replay. Fallback with no journal: read
`agent-<id>.jsonl` transcripts and hand-author a continuation script.

### 1.5 HITL semantics

**There is NO mid-run HITL primitive.** The user can skip individual agents from
`/workflows` (script sees `null`), and the orchestrator can TaskStop the run, but a
script cannot pause to ask a question. HITL must live at workflow boundaries
(sequential invocations). The spec explicitly notes this is consistent with Canon's
previously decided segment-at-gates design.

### 1.6 Canonical patterns and idioms (available, not prescriptive)

Find→adversarial-verify pipelines; justified-barrier dedup; loop-until-count /
-budget / -dry (convergence: dedup vs ALL SEEN, not vs confirmed); adversarial verify
(N refuters, majority kill); perspective-diverse verify; judge panel; multi-modal
sweep; completeness critic. Orchestrator idioms: **hybrid scouting** (scope inline,
then Workflow over the work-list) and **phase-per-workflow** (sequence of workflows
with the orchestrator deciding between fan-outs).

### 1.7 Adjacent harness facts

- The Agent tool shares the agent-type registry; supports `name` + SendMessage
  continuation, `run_in_background`, `team_name`, `isolation: 'worktree'`.
- Agent teams (TeamCreate/TaskCreate/SendMessage) are a separate experimental
  primitive gated by `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (currently enabled here);
  Canon's DAG protocol currently depends on them.
- ScheduleWakeup / CronCreate exist (background-maintenance adjacency, not core build
  orchestration).

---

## 2. Canon orchestration surface map

Each row: where defined, what state it owns, rigidity (how much legitimate adaptivity
the mechanism has — "rigid" mechanisms are determinism candidates; "adaptive" ones are
LLM-judgment territory).

| # | Mechanism | Defined in | State owned | Rigidity |
|---|---|---|---|---|
| S1 | **PM triage / Pre-Build Gate** (refine tiers, scope check, trivial→engineer vs non-trivial→architect) | `CLAUDE.md` §Pre-Build Gate; `skills/canon/skills/refine/SKILL.md` | `sharpened-request.md`, routing decision | **Adaptive** — judgment-heavy, conversation-driven |
| S2 | **Autonomy tier** (`compute_autonomy_tier`: autonomous / light-touch / supervised; fail-safe = supervised; plan approval + initial review verdict mandatory at every tier) | `CLAUDE.md` §Autonomy Tier Protocol; `mcp-server/src/features/orchestration/tools/compute-autonomy-tier.ts` (+ `services/confidence-scorer.ts`) | Tier decision, `auto_decision` audit event in execution store | **Rigid** once computed — a pure signal→tier function with user override |
| S3 | **Runbook** (17-step closed vocabulary, YAML step blocks, mandatory tail context-sync→ship→learn, `hitl:` per step, `skip_when`, `outcome:` sentinels, confidence_signals) | `templates/runbook.md`; `references/runbook-vocabulary.md` (v1.1) | `plans/<slug>/runbook.md`; status lifecycle draft→approved→locked→completed | **Mixed**: synthesis is adaptive; the executed sequence is rigid by design ("architect decides execution strategy — orchestrator follows it") |
| S4 | **Task DAG + validation** | `templates/task-dag.md`; validator at `mcp-server/src/shared/lib/dag-validator.ts` (cycles, unresolved refs, self-refs) | `plans/<slug>/task-dag.yaml` | **Rigid** — pure data + pure validator |
| S5 | **Team dispatch (DAG parallel)** — TeamCreate/TaskCreate, ≤5 workers, single-task guard, per-task worktrees `canon-task/{task_id}` branched from `BUILD_BASE_COMMIT`, alphabetical `--no-ff` merge, post-merge per-file diff verification, conflict→HITL, teardown | `references/dag-execution-protocol.md`; `templates/worker-prompt.md` | Task queue, per-task worktrees/branches | **Rigid protocol on experimental substrate.** Critical caveat (dag-execution-protocol.md:16): the live exercised path is **single-worktree sequential**; wave-lifecycle helpers were deleted in PR #167; the parallel path is documented intent without automated tooling |
| S6 | **Team review consolidation** — blast-radius-driven fan-out, REVIEW-{N}.md, dedup by (file,principle,line), minority-finding verification probes (top-5 cap), worst-case verdict | `CLAUDE.md` §Team Dispatch Protocol | `reviews/REVIEW-{N}.md` → consolidated `reviews/REVIEW.md` | **Rigid** consolidation algorithm; adaptive partitioning inputs |
| S7 | **Journal / step protocol** — `log_step` before/after every spawn, `batch_log_steps`, closed `skip_reason` vocabulary, ghost-step surfacing at finalize | `CLAUDE.md` §Journal Protocol; `mcp-server/src/features/orchestration/tools/orchestration-journal.ts` | `journal.json` + `orchestration.db` (SQLite execution store) — both harness-managed; agents must not touch them directly (`references/canon-artifact-locations.md:104`) | **Rigid** — pure bookkeeping with only failure modes. Known defect: `log_step` read-modify-write on journal.json is unlocked → DAG-worker race (supervised-build-quality.md:179) |
| S8 | **Reconcile / cliff detection** — `reconcile_workspace` flags started/planned steps with missing or `## Status: Partial` artifacts; `capture_transcript` harvest; surfacing-only HITL (no auto re-spawn); `cliff_detected` telemetry | `mcp-server/src/features/orchestration/tools/reconcile-workspace.ts`; `references/hitl-patterns.md:34` | Telemetry events; reads journal + artifact tree | **Rigid** detection; user-adaptive disposition |
| S9 | **Escalation cascade** — add_primer → increase_budget → escalate_model → narrow_scope → hitl; strategies tracked by name; 2-min hard timeout → hitl; flow-config skips | `mcp-server/src/features/orchestration/services/escalation-cascade.ts` ("Pure escalation state machine"); tool `get-next-escalation-strategy.ts` | Cascade state in execution store | **Rigid** — explicitly a pure state machine |
| S10 | **Re-spawn enrichment** — uncommitted-work commit, completed-file lists from git diff, prior artifacts, no-duplicate instruction; stream-idle = resume-first via SendMessage (not re-spawn) | `CLAUDE.md` §Re-spawn Enrichment Protocol, §Agent Spawn Error Handling | None (prompt composition) | **Mixed** — mechanical data-gathering + adaptive prompt assembly |
| S11 | **Renderer protocol** — mandatory HTML at design/review HITL (`artifacts/design.html`, `review.html`), generic Agent + template spawn-prompts, `present_artifact`, dogfood-render obligation | `CLAUDE.md` §Renderer Spawn Protocol; `templates/renderer-*.md` | `artifacts/*.html` | **Rigid** obligation, adaptive content |
| S12 | **HITL gates catalog** — plan approval + initial review verdict (mandatory at ALL tiers); build-step checkpoints (supervised only); adversarial re-review (supervised, post-CLEAN); review-fix loop (max 3 → HITL); WARNING close-out; manual-verification gate; cliff surfacing; merge conflict; gate failure; architect design conversation | `references/hitl-patterns.md` (full catalog) | User decisions; review-fix iteration count | **Rigid trigger conditions**, human-adaptive outcomes. Gate *count* is tier-dependent — this determines how finely any no-mid-run-HITL execution must be segmented |
| S13 | **Worktree lifecycle** — `init_workspace` creates `{workspace}/worktree` on `canon/{slug}`; Canon owns merge lifecycle; `isolation: "worktree"` prohibited (auto-merge bypass); shipper/scribe constraints (no worktree-remove before finalize) | `CLAUDE.md` §Specialist Agents (isolation model), §Completion Checklist; `tools/init-workspace.ts` | Worktree dir + branch | **Rigid** invariant — repeatedly reinforced; known flake: init_workspace sometimes silently skips worktree creation (memory: verify `test -d`) |
| S14 | **Hooks (L4 backstops)** — `hooks/hooks.json`: workspace-check (Edit/Write/tracked-Bash blocked without active workspace; `CANON_PARENT_WORKSPACE` authorizes worktree agents; gitignored paths exempt), destructive-guard, workspace-lock-guard, pre-push-review, pre-commit checks, large-file-guard, principle-inject, dag-dispatch-guard (advisory warn on raw Agent spawns during DAG), post-commit-trailers (PostToolUse, **warn-only**; hard check deferred to `completion-verify.sh`), learn-nudge, compaction-check, session-start suite, tool-loop-detector, session-duration-watchdog | `hooks/` + `hooks/canon-agent-teams/` | None (interceptors) | **Rigid** — deterministic shell; the only non-LLM enforcement layer Canon has |
| S15 | **Finalize / completion checklist** — `finalize_workspace` (journal verification, ghost steps, build-trend summary, build digest to auto-memory), push-state check, pre-push mergeability check, doc-file conflict pre-check, post-scribe scope guard, summary-vs-diff contradiction check (advisory) | `CLAUDE.md` §Completion Checklist, §Post-Step Effects | Flow-run analytics (`diff_stat`), digests | **Rigid** checklist |
| S16 | **Learner loop** — mandatory tail `learn` step; proposals to `.canon/proposed-learnings/`; never skipped (standing user rule) | `agents/learner.md`; `references/runbook-vocabulary.md` §Mandatory Tail | `.canon/` learning artifacts (gitignored; no worktree needed) | **Rigid** obligation, adaptive content |
| S17 | **Agent contracts** — 13 agents (`agents/*.md`): frontmatter tool allowlists + model tier (architect/opus, engineer/sonnet, evaluator/haiku read-only, …); status protocol DONE / DONE_WITH_CONCERNS / HAS_QUESTIONS / BLOCKED / FIXED (`references/status-protocol.md`); artifact-write-before-return; coverage-table obligations (Brief Coverage, Criteria Coverage, Canon Compliance) | `agents/`, `rules/`, `references/` | Artifacts per `references/canon-artifact-locations.md` (fixed names except SUMMARY/PLAN/decision stems) | **Mixed** — contracts rigid, content adaptive. Note: `evaluate_step` + evaluator agent are currently a **dead wire** (uninvoked; project memory) |
| S18 | **Spawn enrichment** — `resolve_agent_skills` preload verbatim at prompt top; `get_context` batched per step type; domain primers by name; turn_budget; commit-provenance trailers (Canon-Workflow/Agent/State/Task) | `CLAUDE.md` §Skill Preloading, §MCP Tool Composition, §Commit Provenance | None (prompt composition) | **Rigid** recipe per step type |
| S19 | **Silent dispatch / conversation hygiene** — 6-item output allowlist; motivated by ~100-message cache_control TTL bug | `CLAUDE.md` §Silent Dispatch | None | **Rigid** allowlist |

---

## 3. Junction analysis — Workflow primitive × Canon mechanism

Legend: **IMPLEMENTS** (primitive can directly carry the mechanism), **STRENGTHENS**
(primitive improves the mechanism's guarantees), **CONFLICTS** (incompatible as-is —
needs adaptation or exclusion), **OBSOLETES** (primitive makes the mechanism
unnecessary in workflow-executed regions), **NEUTRAL/OUT** (mechanism stays
orchestrator-side regardless).

### 3.1 Matrix (summary)

| Workflow primitive ↓ / Canon mechanism → | S3 runbook | S5 DAG dispatch | S6 review consolidation | S7 journal | S8 cliff/reconcile | S9 escalation | S10 re-spawn enrich | S12 HITL gates | S13 worktrees | S14 hooks | S17 agent contracts | S18 spawn enrich |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `agent(agentType:'canon:*')` | implements step execution | implements worker spawn | implements reviewer spawn | conflicts (can't log_step from script) | — | — | — | — | — | A1 assumption | implements + strengthens (schema) | conflicts (script can't call resolve_agent_skills) |
| `schema` structured output | strengthens (machine-readable step results) | strengthens (task results) | strengthens (findings as objects, not parsed md) | strengthens (statuses become data) | — | — | — | strengthens (verdict routing in code) | — | — | **strengthens strongly** | — |
| `pipeline()` | implements multi-stage steps | implements per-task stage chains | implements find→verify | — | — | — | — | — | — | — | — | — |
| `parallel()` | implements team-dispatch steps | **implements/possibly obsoletes TeamCreate path** | implements N-reviewer fan-out + barrier consolidation | — | — | — | — | — | — | — | — | — |
| `workflow()` (nesting 1) | implements phase composition | implements per-wave children | — | — | — | — | — | segments map to gate regions | — | — | — | — |
| `budget` | conflicts (units/ownership) | — | — | — | — | partially implements increase_budget | — | — | — | — | conflicts with turn_budget semantics | — |
| Resume (prefix cache) | — | strengthens (wave replay) | — | **conflicts (double bookkeeping)** | **strengthens/partially obsoletes** | partially obsoletes | **largely obsoletes in-workflow** | — | — | — | — | — |
| Determinism ban | constrains prompt composition | constrains enrichment payloads | — | conflicts (timestamps) | — | — | conflicts (git-state prompts) | — | — | — | — | **conflicts (must pre-freeze into args)** |
| Background + `/workflows` | — | strengthens visibility | — | — | — | — | — | conflicts (gate timing) | — | — | — | strengthens S19 |
| No-mid-run-HITL | — | — | — | — | conflicts (surfacing timing) | conflicts (hitl terminal strategy) | — | **HARD CONFLICT (tier-dependent)** | — | — | conflicts (HAS_QUESTIONS) | — |
| Opt-in rule | — | — | — | — | — | — | — | — | — | — | — | **HARD CONFLICT vs auto-dispatch (with skill-channel mitigation)** |
| `isolation:'worktree'` | — | conflicts | — | — | — | — | — | — | **HARD CONFLICT (auto-merge)** | — | — | — |
| Sandbox (no fs/MCP in script) | conflicts (can't read artifacts) | conflicts (can't run git merges) | conflicts (can't read REVIEW-{N}.md) | **HARD CONFLICT** | conflicts | conflicts (cascade state) | conflicts | — | conflicts | — | conflicts (artifact verification) | conflicts |

### 3.2 Hard conflicts (explicit)

**HC-1: `isolation: 'worktree'` auto-merge vs Canon-owned worktree lifecycle (S13).**
The Workflow spec itself carries the Canon note: agent-level worktree isolation
auto-merges to the calling branch, bypassing Canon's controlled merge (verification
diffs, conflict-HITL, no-ff provenance). Canon CLAUDE.md prohibits it for code-writing
agents. **However** (A3): workflow-spawned engineers are real agents with Bash — the
existing worker-prompt pattern (agent creates its own `canon-task/{task_id}` worktree
from `BUILD_BASE_COMMIT` via git commands) carries over unchanged. The conflict is with
the *opts flag*, not with worktree isolation per se. Merge execution (S5 merge
protocol) cannot run in the script (no fs/git) — it must run either in a dedicated
merge-agent node or orchestrator-side at a workflow boundary.

**HC-2: No-mid-run-HITL vs the HITL gate catalog (S12).**
A script cannot pause for plan approval, review verdict, WARNING close-out,
build-step checkpoints, adversarial re-review presentation, manual-verification gate,
or cliff surfacing. Two mandatory gates exist at **every** tier (plan approval, initial
review verdict). Tier determines the rest: supervised adds build-step checkpoints after
each major step + adversarial re-review + full WARNING ceremony; light-touch removes
build-step checkpoints only; autonomous removes WARNING close-out and auto-proceeds
CLEAN-after-fix. Consequence (fact, not design): the maximum uninterrupted workflow
segment is the inter-gate region, and that region's length is a function of tier.
Available partial mitigations native to the tool: user-initiated `/workflows` agent
skip (script sees `null`), orchestrator TaskStop + later `resumeFromRunId`, and early
`return` from the script (status-carrying result the orchestrator can route to HITL,
then resume — note an answer-bearing prompt change invalidates prefix cache from that
call onward).

**HC-3: Sandboxed script vs MCP/journal/filesystem writes (S7, also S6/S5 mechanics).**
The script cannot call `log_step`, read `REVIEW.md`, verify `artifacts_expected`,
write the execution store, or run git. Per `references/canon-artifact-locations.md:104`,
`journal.json`/`orchestration.db` are harness-managed and **agents must not write them
directly** either — so "have each agent log its own step" contradicts current doctrine
as written (though agents *do* have MCP access via ToolSearch, so the doctrine, not the
capability, is the constraint). Meanwhile the Workflow runtime keeps its **own**
journal (per-`agent()` results, per `runId`). Integration must reconcile two journals
with different grains; the open space is in §5.

**HC-4: Opt-in rule vs Canon's "default to action" auto-dispatch (S1, CLAUDE.md
§Intent Classification).** Canon auto-routes build intents without confirmation; the
Workflow tool may only be invoked after explicit user opt-in. Load-bearing fact: the
spec's opt-in list includes **"a skill instructs it"** — Canon is a skill/plugin, so a
Canon skill instruction is a legitimate opt-in channel. Whether per-build human consent
should *additionally* be collected (e.g., folded into the always-mandatory plan-approval
gate) is open design space, but the bare conflict has a sanctioned resolution path.

**HC-5: Resume determinism vs time/state-dependent prompt composition (S10, S18).**
Canon's spawn prompts are enriched with live state: `resolve_agent_skills` preloads,
`get_context` output, git-diff-derived completed-file lists, re-spawn enrichment,
timestamps. Inside a script, none of that can be *fetched* (no MCP/fs from script) and
none of it may be *nondeterministic* (cache invalidation). The two sanctioned shapes
are: freeze enrichment into `args` at invocation time (orchestrator-side hybrid
scouting), or fetch via a scout `agent()` node whose result feeds later prompts
(deterministic-by-journal on replay: the cached scout result reproduces downstream
prompts exactly). Conversely, much of S10 re-spawn enrichment exists precisely because
Canon lacks cheap resume — Workflow's prefix-cache resume covers the same failure class
losslessly *within* a run, which is why the matrix marks S10 "largely obsoletes
in-workflow."

**HC-6: `budget` ownership/units vs Canon turn budgets (S9, S18).** Canon paces agents
in turns (`turn_budget`, escalation `increase_budget` doubling, cap 80) and the
orchestrator sets them. Workflow `budget` is output-tokens, **shared-pool**, hard-throw
at ceiling, and is set only by a user "+N"-style directive — the orchestrator cannot
program it per-build or per-node. There is no per-`agent()` token cap. Per-node budget
control inside workflows remains prompt-level (turn_budget text), unchanged.

### 3.3 Notable strengthens/obsoletes (non-conflicts)

- **`schema` vs Canon's parse-the-markdown contracts (S17, S6, S12).** Today the
  orchestrator greps SUMMARY `### Status` fields, parses REVIEW.md verdicts, and
  enforces coverage tables by convention. `agent(…, {schema})` returns validated
  objects with tool-layer retry-on-mismatch — a strictly stronger contract for status
  routing, verdict branching, findings dedup, and coverage accounting *inside workflow
  regions*. Artifacts-on-disk remain necessary for humans/renderers/finalize; schema
  output and artifact writes are complementary, not either/or.
- **`parallel()`/queueing vs TeamCreate dependency (S5).** The DAG protocol's
  substrate (agent teams) is experimental, env-gated, and its per-task-worktree wave
  path lost its tooling in PR #167 (sequential single-worktree is the live path; see
  also the standing TODO to degrade gracefully when teams tools are unregistered).
  Workflow's `parallel()` + automatic concurrency management (min(16, cores−2),
  queueing, 4096-item ceiling) is a stable, non-experimental substitute *for the
  dispatch layer specifically*; merge protocol and single-task semantics still need a
  home (script structure makes "one task per worker" structural rather than
  guard-enforced — each task is simply one `agent()` call). The dag-dispatch-guard hook
  (advisory, matcher: Agent) would not observe in-workflow `agent()` calls either way
  (it watches the orchestrator's Agent tool-calls).
- **Workflow journal + resume vs cliff detection (S8).** Canon's cliff machinery
  exists because a dead agent leaves a partial artifact and no recoverable state.
  Within a workflow run, a dead agent is a `null` (script-visible, policy-decidable in
  code) and a killed *run* is resumable from the exact `agent()` boundary with cached
  prefix. `reconcile_workspace` remains necessary at workspace grain (steps outside
  workflows; partial-skeleton artifacts), but its workload shrinks wherever workflows
  execute. `capture_transcript`'s fallback role maps to the spec's own fallback
  (`agent-<id>.jsonl` hand-authored continuation).
- **Escalation cascade in code (S9).** `null`-return + in-script retry with
  `opts.model: 'opus'`, halved scopes, or added primer text (passed via args/scout
  results) re-implements add_primer / escalate_model / narrow_scope deterministically.
  `increase_budget` has no token-level analog (HC-6); `hitl` as terminal strategy must
  surface at a boundary (HC-2). The 2-minute cascade timeout is wall-clock —
  unimplementable in-script (no clock); a count-based bound replaces it.
- **Background + `/workflows` vs Silent Dispatch (S19).** A background workflow
  collapses N orchestrator messages into one invocation + one notification, directly
  relieving the ~100-message cache_control TTL failure mode that motivated Silent
  Dispatch, and gives the user *better* live visibility than the allowed one-line
  state transitions. Conflict surface: post-step orchestrator effects (renderer spawn,
  summary-vs-diff check, artifact checks) migrate to notification-time or to in-workflow
  verifier nodes.
- **Stream-idle resume protocol (S10/watch_NNNNN2).** SendMessage continuation of a
  stalled agent is an Agent-tool affordance; the script has no equivalent (a stalled
  workflow agent eventually errors → `null`). Run-level resume replaces it. Teams
  should treat the resume-first standing rule as orchestrator-scope, not
  workflow-scope.
- **Renderer protocol (S11).** Renderers are ordinary spawned agents → expressible as
  `agent()` nodes (haiku/sonnet per template). `present_artifact` + AskUserQuestion are
  orchestrator-side → boundary work. No conflict; placement choice only.
- **Mandatory tail (S3/S16).** context-sync → ship → learn is a fixed sequence with
  closed skip predicates — the most workflow-shaped region in Canon (rigid, no
  legitimate adaptivity, currently enforced only behaviorally + by learn-nudge hook).
  Tail steps need worktree git access (scribe commit, shipper push) — agent-level
  capability (A3), not script-level.

---

## 4. Constraint ledger (hard limits for all design teams)

1. **Opt-in**: Workflow only after explicit user opt-in; sanctioned channels include a
   skill instructing it (HC-4). Designs must state their consent story.
2. **No mid-run HITL**: gates only at workflow boundaries; in-run user power is limited
   to per-agent skip and TaskStop. Plan approval + initial review verdict are mandatory
   at ALL Canon tiers and cannot be compiled away.
3. **Determinism ban**: no `Date.now()`/`Math.random()`/argless `new Date()` (they
   throw); no nondeterministic prompt content; timestamps via `args`; vary by index.
4. **Sandbox**: script has no fs, no Node APIs, no MCP, no git; plain JS only (no
   TypeScript syntax); `meta` is a pure literal; script ≤512KB.
5. **Caps**: concurrency min(16, cores−2); 1,000 lifetime agents/workflow; 4,096 items
   per pipeline/parallel call; `workflow()` nesting exactly 1 level.
6. **Failure semantics**: `agent()` never throws — `null` on skip/terminal failure;
   `parallel()`/`pipeline()` never reject; throwing stages drop items to `null`.
   Designs must specify null-policy per node class.
7. **Budget**: token ceiling is user-directive-only, shared-pool, throws at ceiling;
   no per-agent token caps; guard loops with `budget.total &&`.
8. **Resume**: same-session only; prefix match on exact (prompt, opts); any upstream
   prompt change invalidates downstream cache.
9. **`isolation: 'worktree'` auto-merge is prohibited** for Canon code-writing agents
   (existing CLAUDE.md rule; reaffirmed by the spec note). Worktree mechanics must use
   Canon-owned patterns (agent-side git per worker-prompt, or orchestrator-side).
10. **`args` must be real JSON** (not stringified); it is the only orchestrator→script
    data channel besides the script text itself.
11. **MCP availability caveat**: interactively-authenticated MCP servers may be absent
    headless — any cron/background design must degrade.
12. **Canon invariants that remain binding regardless of substrate**: mandatory tail
    (never skip learner/context-sync/ship), commit provenance trailers, artifact
    locations per `references/canon-artifact-locations.md`, journal.json/orchestration.db
    are harness-tool-managed only, runbook vocabulary is closed/versioned, baseline
    HITL postures in the vocabulary may not be removed by synthesis.
13. **No-silent-caps**: any bounded coverage inside a workflow must be `log()`ged.
14. **Verify A1/A2 empirically** (hook firing + allowlist honoring for workflow
    agents) before depending on L4 enforcement or tool restriction inside workflows.

---

## 5. Degrees of freedom (genuine open design space — listed, not designed)

1. **Scope axis** — which runbook regions execute as workflows: mandatory tail only;
   review→fix→re-review loop; verify pipelines; DAG implement waves; team-review
   fan-out/consolidation; whole inter-gate segments; whole-build (autonomous tier).
   Tier-dependent segmentation is forced (HC-2), but where to draw the ambition line
   is open.
2. **Authorship axis** — hand-written saved workflows in `.claude/workflows/`
   (versioned, reviewable, testable) vs per-build generated scripts (persisted via
   scriptPath) vs a **static generic runner script + compiled plan passed as `args`**
   (data, not code). The runner-plus-args shape is newly observable from the spec
   (`name`/`scriptPath` + verbatim `args`, pure-literal `meta`) and interacts with
   resume (stable script text maximizes prefix reuse on mid-run resume).
3. **Journal reconciliation model** — orchestrator logs one journal step per workflow
   invocation (coarse); agents self-log via MCP (doctrine change required, HC-3);
   post-hoc expansion of the workflow's structured return into per-step journal entries
   at notification time; or treating the Workflow run journal as authoritative for
   in-run grain with `runId` cross-referenced in `journal.json`. Interacts with the
   known journal write-race precondition (supervised-build-quality.md:179).
4. **HITL boundary design** — how gates are conducted between workflow segments
   (existing AskUserQuestion + renderer flow), whether early-`return` status results
   create soft gates, whether plan approval doubles as Workflow consent (HC-4), how
   `/workflows` skip and TaskStop are folded into the gate catalog as new user verbs.
5. **Structured-output contracts** — which Canon artifacts/protocols gain JSON
   schemas (status block, review findings, coverage tables, verdicts, task results)
   and how schema objects coexist with on-disk markdown artifacts + renderer inputs.
6. **Worktree strategy inside workflows** — worker-prompt-style agent-managed
   per-task worktrees with a merge-agent node; single shared build worktree with
   sequential `agent()` nodes; orchestrator-performed merges at boundaries; whether
   the unsupported parallel-wave path (PR #167 gap, adaptive-queen revisit trigger)
   gets rebuilt **on** Workflow instead of on agent teams.
7. **Failure/escalation policy in code** — retry counts, model escalation ladders,
   scope-splitting, primer injection via scout nodes, null-policy per node class,
   count-based cascade bounds; what remains of `get_next_escalation_strategy`
   orchestrator-side.
8. **Dispatch-substrate strategy** — Workflow vs TeamCreate/TaskCreate vs sequential
   subagents per step type and per environment (experimental-flag availability);
   whether `compete`/`debate` steps (orchestrator-driven team rounds) map to judge-panel
   / adversarial workflow patterns or stay on teams.
9. **Consolidation/verification patterns** — adoption of spec patterns (adversarial
   verify, judge panel, loop-until-dry with all-seen dedup, completeness critic,
   minority-finding probes as refuter nodes) for Canon review/security/test steps.
10. **Background-build UX** — long builds as background workflows with
    notification-driven orchestrator resumption; what the user sees in `/workflows` vs
    Canon progress lines; conversation-length (TTL bug) relief as an explicit goal.
11. **Budget governance** — how Canon expresses cost intent given budget is
    user-directive-only (prompt-level turn budgets, FLEET-style static scaling when a
    directive exists, model-tier selection per node).
12. **Enrichment freezing** — what goes into `args` at invocation (resolve_agent_skills
    preloads, get_context snapshots, base_commit, primer text) vs what a scout agent
    fetches in-run; staleness vs cache-stability tradeoff.
13. **Observability/telemetry mapping** — `phase()`/`log()` naming conventions vs
    runbook step IDs; `record_agent_metrics`/`post_event` equivalents at notification
    time; how `cliff_detected`-class telemetry applies to killed runs.
14. **Vocabulary evolution** — whether runbook step schema gains machine-readable
    fields needed for compilation (the prior art's G1–G9 list) and which of those are
    actually expressible (see §6 on G5/G6).
15. **Adjacent (flagged, lower priority)** — ScheduleWakeup/CronCreate for janitor/
    learner/maintenance loops; saved diagnostic workflows (`/canon:diagnose`-style)
    as named workflows users can invoke directly (which is itself an opt-in channel).

---

## 6. Prior-art reconciliation — "Deterministic Spine" epic

Source: `docs/supervised-build-quality.md:152-171`. Read after forming the view above.

**Confirms (fresh review agrees):**

- **Segment-at-gates is not a choice — it is the only shape.** The spec states there
  is no mid-run HITL primitive and itself cites consistency with the decided design.
  The epic's rejection of in-Workflow HITL nodes is correct: no primitive exists to
  build them on.
- **Tier-gated compilation is well-founded.** Gate count is tier-dependent (S2/S12);
  autonomous builds have the fewest firing gates → longest viable segments. The
  epic's "compile autonomous/light-touch first; defer supervised" matches the
  mechanics exactly. W8 (whole-build) as "viable, deferred, boundary-gated" for the
  autonomous tier is consistent with the two always-mandatory gates: a whole-build
  compile still splits at plan approval and initial review verdict.
- **G8 (tier→gate semantics) being load-bearing** is confirmed — it is precisely the
  data that determines segment boundaries under HC-2.
- **"Hooks first" sequencing (X4 Stop-hook tail enforcement)** is untouched by
  anything in the Workflow spec; it remains complementary floor-hardening regardless
  of any Workflow adoption.
- **The closed 17-step vocabulary as the shape-agnosticity guard** is confirmed as the
  right invariant: every compiled construct must reduce to vocabulary steps, and the
  vocabulary's versioning policy (`references/runbook-vocabulary.md`) already handles
  evolution.

**Extends (facts the epic did not account for):**

- **The opt-in rule** (HC-4) is absent from the epic's risk list. It is a real
  precondition for any auto-compiled execution, with a sanctioned mitigation (skill
  instruction channel) the teams must explicitly invoke or supplement.
- **"Validated IR, not generated source" maps even more cleanly than the epic knew.**
  The harness offers `name`/`scriptPath` + verbatim `args`: a permanently-trusted,
  hand-written runner saved in `.claude/workflows/` can interpret the compiled plan
  passed as `args` data. This dissolves the generated-code-trust risk *and* the
  determinism risk (data can't call `Date.now()`), and a stable script maximizes
  resume prefix reuse. The epic's "thin permanently-trusted runner" gains a concrete,
  native home.
- **Resume economics.** The epic does not discuss Workflow's prefix-cached resume.
  It materially changes the cost of mid-build failure in compiled regions
  (largely superseding re-spawn enrichment there, S10) and weakens one argument for
  keeping regions orchestrator-driven.
- **Journal double-bookkeeping** (HC-3) is a new integration surface the epic never
  mentions: the Workflow runtime journals every `agent()` call independently of
  `journal.json`/`orchestration.db`. Any compiled execution needs an explicit
  reconciliation model (§5 item 3), and inherits the known journal write-race
  precondition.
- **Budget reality check.** The epic's G5 "per-node budget" is **not expressible** in
  the native budget primitive (token pool is global, user-directive-only, no per-agent
  cap). G5 survives only as prompt-level turn budgets. Similarly G6 "fan-out width
  policy" is partially subsumed by the runtime's own concurrency management
  (min(16, cores−2) + queueing); explicit width keeps only a cost-control role.
- **Null-failure semantics** (`agent()` never throws) gives the compiled review→fix
  loop and wave execution a concrete, deterministic failure-policy substrate the epic
  left abstract (G3 failure-routing edges now have a defined mechanism to route *on*).

**Contradicts / nuances:**

- **W4 "tail pipeline as a `pipeline()`" is a shape mismatch in the letter, not the
  spirit.** `pipeline(items, …stages)` is a per-item fan-out construct; the mandatory
  tail is a single-item sequential chain (context-sync → ship → learn on one build).
  Encoding it as `pipeline([build], sync, ship, learn)` works but degenerates to
  sequential awaits; the PoC's real validation targets are the `agentType:'canon:*'`
  call path, skip-predicate porting, worktree/git access from in-workflow agents (A3),
  journaling reconciliation, and the notification-time tail of orchestrator effects —
  not pipeline parallelism. Teams should not let the construct name drive the design.
- **"Wall-clock/2-min timeout" style controls do not port.** The escalation cascade's
  hard timeout (escalation-cascade.ts) is clock-based; scripts have no clock. Any
  compiled cascade must be count-bounded. Minor, but the epic implies the cascade
  semantics carry over unchanged.
- **The epic's scope/authorship two-axis framing under-counts a third axis:
  dispatch substrate.** Canon's parallel path currently *requires* experimental agent
  teams (env-gated; wave tooling deleted in PR #167). Workflow adoption is not only
  "make the invariant parts deterministic" — it is also a candidate replacement for an
  experimental dependency on the *adaptive* parallel path. That is a separate decision
  axis with its own risk profile, and it is squarely inside the competition's design
  space (§5 items 6, 8).

---

## Appendix: key file references

- Workflow spec (authoritative): `docs/explore/workflow-integration/workflow-tool-spec.md`
- Orchestration protocol: `CLAUDE.md`
- DAG protocol: `references/dag-execution-protocol.md` (esp. line 16 caveat)
- HITL catalog: `references/hitl-patterns.md`
- Artifact locations: `references/canon-artifact-locations.md`
- Runbook vocabulary (v1.1, 17 steps): `references/runbook-vocabulary.md`
- Runbook template: `templates/runbook.md`; worker prompt: `templates/worker-prompt.md`
- Agents: `agents/` (13 definitions; frontmatter = tools/model contracts)
- Hooks: `hooks/hooks.json`; L4 backstop `hooks/canon-agent-teams/canon-workspace-check.sh`; trailer check `hooks/canon-agent-teams/post-commit-trailers.sh` (warn-only) + `completion-verify.sh`
- Orchestration tools: `mcp-server/src/features/orchestration/tools/` (init-workspace, orchestration-journal, reconcile-workspace, compute-autonomy-tier, get-next-escalation-strategy, capture-transcript, write-* artifact tools); services: `escalation-cascade.ts`, `confidence-scorer.ts`
- DAG validator: `mcp-server/src/shared/lib/dag-validator.ts`
- Prior art: `docs/supervised-build-quality.md` lines 152–171 (+179 journal-race precondition)
