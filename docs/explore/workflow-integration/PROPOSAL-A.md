<!-- Persisted from .canon/history/fresh-architect-review-of-claude-code-workflow-tool — explore flow 2026-06-07; competition: 3 proposals, 3 judges, synthesis ratified at HITL -->
## Status: Complete

# PROPOSAL A — Determinism Maximalist: The Compiled Build

> Team A of 3. Philosophy: every part of a Canon build that has only failure modes — no
> legitimate adaptivity — runs as compiled, journaled, prefix-cached Workflow execution.
> Prose protocols become code. L1 behavioral gates become structural impossibilities.
> Sources: `research/workflow-tool-spec.md` (authoritative), CAPABILITY-REVIEW.md
> (constraint ledger respected throughout), Canon as-built.

## ASSUMPTIONS

- Inherits A1–A4 from CAPABILITY-REVIEW.md. A1/A2 are resolved by a mandatory probe in
  Increment 0 (§4.7); the design degrades safely if either is false (§4.7).
- Assumes `args` payloads of low-hundreds-of-KB are acceptable (spec caps *script* at
  512KB; no stated args cap). Mitigated regardless by the env-snapshot pattern (§3.4),
  which keeps `args` small by design.
- Assumes the Workflow tool remains non-experimental (unlike agent teams, it carries no
  env-flag gate in the spec). This is load-bearing for F4 (§2) and stated as a risk (§6).

---

## 1. Vision

Today, a Canon build is an LLM faithfully (usually) executing ~2,000 lines of prose
protocol: CLAUDE.md orchestration sequences, the DAG execution protocol, the HITL
catalog, journal bookkeeping, skip-reason vocabularies, merge choreography, renderer
obligations. Every one of those prose obligations is an L1 behavioral gate, and Canon's
own history is a catalog of L1 drift: the `evaluate_step` dead wire, the twice-corrected
forgotten renderer spawn, skipped journal entries, the journal write race, the scribe
over-trim, ghost steps. The orchestrator is the least reliable component executing the
most invariant logic.

**End state:** the architect still designs every build adaptively — nothing about PM
triage, requirements, design conversations, or runbook synthesis changes. But the
approved runbook + task DAG are then **compiled** by a pure, unit-tested TypeScript
function into a validated `WorkflowPlan` IR — plain JSON data. A single, permanently
trusted, hand-written, versioned **segment runner** (a saved workflow in
`.claude/workflows/`) interprets that IR. The build executes as a short sequence of
background Workflow invocations — one per inter-gate segment — with the orchestrator
reduced to its only irreplaceable jobs: conducting HITL gates between segments and
handling the genuinely unforeseen.

Inside a segment, everything that is today prose is code: the DAG scheduler, the
review→fix→re-review loop bound at 3 iterations, the team-review dedup algorithm, the
minority-finding probe cap, the escalation ladder, the skip predicates, the merge
choreography, the renderer spawn, the no-silent-caps logging. Agent statuses and review
verdicts cross the boundary as schema-validated objects, not regex-scanned prose. Every
`agent()` result is journaled by the harness; a killed build resumes from the exact
agent boundary with a 100% cached prefix. The Canon journal becomes a single-writer
projection of the workflow trace — which deletes the journal write race rather than
mitigating it.

The user experience: one plan-approval gate (which doubles as Workflow consent), live
progress in `/workflows` instead of forty orchestrator messages (killing the ~100-message
cache_control TTL failure mode at the root), a review-verdict gate with the HTML
dashboard always rendered — because the renderer is an IR node, not a memory the
orchestrator must retain — and a mandatory tail that is structurally unskippable because
it is the final segment of the compiled plan, backstopped by a Stop-hook.

A Canon build stops being a long conversation that hopefully follows the manual. It
becomes a compiled artifact with gates.

---

## 2. Feature inventory

Ranked by leverage-per-risk; F1–F3 are the load-bearing core.

| # | Feature | What it does | Workflow primitive(s) | Canon mechanism replaced/strengthened | Effort | Leverage |
|---|---------|--------------|----------------------|----------------------------------------|--------|----------|
| F1 | **Segment runner + WorkflowPlan IR + `compile_runbook`** | Pure compiler `(runbook, task-dag.yaml, tier) → validated IR segments`; one trusted generic runner script interprets IR passed as `args`. Segment-at-gates from tier (G8). | `name`/`scriptPath` + `args`, `agent()`, `phase()`, `log()`, script `return` | S3 runbook execution, S5 dispatch, S18 spawn recipes; extends `dag-validator.ts` into `validateWorkflowPlan` | L | Very high |
| F2 | **Trace-ledger journal projection (`ingest_segment_trace`)** | Runner returns a structured `step_trace[]`; orchestrator ingests it into journal.json + orchestration.db in ONE locked, single-writer transaction per segment. Workflow `runId` cross-referenced per step. | script `return` value, harness journal | S7 journal protocol — **and deletes the journal write race** (single writer by construction) | M | Very high |
| F3 | **Schema-typed statuses & verdicts** | Every IR node carries a JSON Schema; engineer/reviewer/tester statuses, review verdicts, coverage tables return as validated objects with tool-layer retry. Markdown artifacts still written to disk (unchanged contract). | `agent(…, {schema, agentType})` | S17 regex-scanned `### Status` prose; implements the decided Tier-2 "typed agent status return" item natively | S | Very high |
| F4 | **DAG scheduler on Workflow (drop TeamCreate)** | Runner implements a ready-set topological scheduler over IR task nodes: each task = one `agent()` (engineer, self-managed `canon-task/{id}` worktree per worker-prompt). Per-task start as soon as deps complete — finer than waves. Merge-agent node executes the merge protocol verbatim; post-merge per-file diff check node. | `parallel()`-style concurrency via runtime cap, `agent(agentType:'canon:engineer')` | S5 — replaces env-gated experimental TeamCreate path whose wave tooling was deleted in PR #167; single-task guard becomes structural (one task = one call) | M | Very high |
| F5 | **Compiled review fan-out + consolidation** | N reviewers in `parallel()`; dedup by (file, principle, line) as pure JS in the script; minority findings → refuter `agent()` probes (top-5 cap with `log()` per no-silent-caps); worst-case verdict computed in code; renderer node emits review.html before segment returns. | `parallel()`, `pipeline()`, schema, `log()` | S6 consolidation algorithm (today prose-executed by the orchestrator); S11 renderer obligation (twice-forgotten — now structural) | M | High |
| F6 | **Compiled escalation ladder (null-policy per node class)** | `agent()` null → in-code ladder: retry → `opts.model:'opus'` → deterministic scope-halving by index → early `return {status:'BLOCKED', resume_point}`. Count-bounded (no clock in sandbox). | `agent()` null semantics, `opts.model` | S9 escalation cascade (already "a pure state machine" — now actually executed by a machine); 2-min wall-clock bound → count bound | S | High |
| F7 | **Resume-first recovery** | Dead/killed segment → `{scriptPath, resumeFromRunId}`: cached prefix replays completed agents instantly. Cross-session: `compile_remainder(plan, ledger)` emits the un-executed suffix as a fresh segment. Retires re-spawn enrichment inside compiled regions. | Resume/prefix cache, trace ledger | S10 re-spawn enrichment, S8 cliff machinery (workload shrinks to non-compiled regions) | S | High |
| F8 | **Mandatory tail as final segment + Stop-hook backstop** | context-sync → ship → learn compiled as the terminal IR segment; skip predicates (G4) evaluated in code from a git-facts scout node. X4 Stop-hook enforces gates/tail happened (floor, not ceiling). | sequential `agent()` chain, scout node | S3/S16 mandatory tail (today behaviorally enforced + learn-nudge hook); the user's strongest standing rules become structural | S | High |
| F9 | **Enrichment freezer (env snapshots)** | At segment invocation the orchestrator materializes `resolve_agent_skills` preloads, `get_context` output, primers, base_commit, timestamps into immutable files under `${WORKSPACE}/segments/{id}/env/`; IR prompts reference stable *paths*. Cache-stable AND compact `args`. | `args`, determinism ban compliance | S18 spawn enrichment under HC-5; staleness bounded to segment grain | S | High |
| F10 | **Background-build UX / TTL relief** | Each segment is one background tool call + one notification instead of dozens of orchestrator messages; `/workflows` gives the user live per-agent progress with skip power. | background runs, `/workflows`, `phase()` | S19 Silent Dispatch — the ~100-message TTL bug is starved at the source | XS (free with F1) | High |
| F11 | **Post-segment provenance audit** | Trace ingest verifies, in code: commit trailers present, declared artifacts exist, committed paths ⊆ IR-declared file lists. Compensates if A1 (hooks-in-workflow) is false; tightens it if true. | trace + orchestrator-side checks | S14 hook layer (post-commit-trailers is warn-only today), S15 contradiction check — becomes deterministic | S | Med-High |
| F12 | **Saved diagnostic & maintenance workflows** | `/canon:diagnose`, janitor sweeps, learner mining as named workflows in `.claude/workflows/` — user-invocable (itself an opt-in channel); cron-able where MCP-auth allows. | `name`, ScheduleWakeup/Cron | S16 adjacency; DoF #15 | S | Med |
| F13 | **G1–G9 runbook field enrichment** | Machine-readable loop bounds, exit predicates, failure-routing edges, evaluable skip predicates, fan-out, merge strategy, tier→gate semantics, post-merge assertions. Standalone value; hard prerequisite of F1. | (none — pure schema work) | S3 runbook schema; per prior epic, G8 is the segmentation driver | S | High (enabler) |

Explicitly **kept orchestrator-side** (legitimate adaptivity): PM triage (S1), architect
design + runbook synthesis (S3 synthesis half), all HITL gate *conduct* (S12),
requirements conversations, unforeseen-failure judgment, and the interpretive execution
path as fallback (§6).

---

## 3. Architecture

### 3.1 Components and ownership

```
architect (adaptive, unchanged)
  └─ runbook.md + task-dag.yaml + G1–G9 fields
        │
        ▼
compile_runbook (NEW MCP tool — pure, unit-tested TS in mcp-server)
  ├─ reads tier (compute_autonomy_tier) → firing-gate set (G8)
  ├─ splits runbook at firing gates → N segments
  ├─ emits WorkflowPlan IR (JSON) per segment
  └─ validateWorkflowPlan (extends dag-validator.ts): cycles, refs,
     schema, vocabulary-closure, null-policy completeness
        │
        ▼
orchestrator (gate conductor)
  ├─ freezes env snapshots → ${WORKSPACE}/segments/{id}/env/
  ├─ invokes Workflow { name: 'canon-segment-runner', args: { ir, env_paths, ts } }
  ├─ receives <task-notification> → reads structured return
  ├─ ingest_segment_trace (NEW MCP tool) → journal.json + SQLite, single writer
  ├─ conducts gate (AskUserQuestion + present_artifact, unchanged catalog)
  └─ next segment (gate answers injected as args.hitl_answers — post-gate
     nodes only, preserving the prefix cache of earlier calls)
        │
        ▼
canon-segment-runner (hand-written plain JS, versioned in repo at
skills/canon/workflows/canon-segment-runner.js, installed to .claude/workflows/)
  ├─ interprets IR: sequential steps, DAG scheduler, bounded loops
  ├─ spawns agent(prompt, {agentType:'canon:*', schema, model, phase})
  ├─ null-policy + escalation ladder per node class
  └─ returns { status, step_trace[], verdicts, resume_point }
```

**Authorship answer (DoF #2): static runner + compiled plan as data.** Nobody ever
reviews generated JavaScript. The runner is reviewed once, unit-tested in CI (it is
plain JS — testable in Node with a mocked `agent()`), and changes via normal PRs. The
per-build IR is data: schema-validated, diffable, rendered into design.html for the
plan-approval gate. Generated-code trust risk dissolves; the determinism ban is
satisfied by construction (data cannot call `Date.now()`); and a byte-stable script
maximizes resume prefix reuse across every build and every resume.

### 3.2 The IR (illustrative fragment)

```json
{
  "ir_version": "1.0",
  "vocab_version": "1.1",
  "build": { "slug": "add-export-tool", "workspace": "…", "base_commit": "85b0056d",
             "tier": "light-touch", "invoked_at": "2026-06-07T18:02:11Z" },
  "segment": { "id": "seg-2-implement-to-review-verdict",
               "after_gate": "plan-approval", "ends_at_gate": "review-verdict" },
  "env": { "engineer_preload": "segments/seg-2/env/engineer-preload.md",
           "reviewer_preload": "segments/seg-2/env/reviewer-preload.md",
           "context_snapshot": "segments/seg-2/env/get-context.md" },
  "nodes": [
    { "id": "scout-facts", "kind": "scout", "agent_type": "canon:engineer",
      "model": "haiku", "schema_ref": "GitFacts",
      "prompt_template": "facts-scout@1" },
    { "id": "implement", "kind": "dag",
      "tasks": [
        { "task_id": "schema-types", "depends_on": [], "files": ["mcp-server/src/shared/schema/export.ts"],
          "agent_type": "canon:engineer", "schema_ref": "TaskResult",
          "prompt_template": "worker@2", "worktree": "canon-task/schema-types" },
        { "task_id": "tool-impl", "depends_on": ["schema-types"], "files": ["mcp-server/src/features/export/tools/export.ts"],
          "agent_type": "canon:engineer", "schema_ref": "TaskResult",
          "prompt_template": "worker@2", "worktree": "canon-task/tool-impl" }
      ],
      "null_policy": "escalate-ladder", "ladder": ["retry", "model:opus", "split", "blocked"] },
    { "id": "merge", "kind": "merge_agent", "order": "alphabetical",
      "post_assert": "per-file-diff-nonempty", "on_conflict": "return:BLOCKED" },
    { "id": "verify", "kind": "gate_commands", "agent_type": "canon:engineer",
      "commands": ["npm run build", "npm run lint", "npm test", "bash hooks/lint.sh"],
      "schema_ref": "VerifyResult", "on_fail_route": "fix(cause=verify)", "max_iterations": 2 },
    { "id": "review", "kind": "fanout_review", "partitions": "from_args",
      "schema_ref": "ReviewFindings", "dedup": "file-principle-line",
      "minority_probe": { "cap": 5, "order": "severity-then-blast-radius" } },
    { "id": "render-review", "kind": "renderer", "template": "renderer-review",
      "model": "sonnet", "output": "artifacts/review.html",
      "null_policy": "retry-then-flag" }
  ],
  "return_contract": "SegmentResult@1"
}
```

### 3.3 The runner (illustrative excerpt — plain JS, hand-written, versioned)

```js
export const meta = {
  name: 'canon-segment-runner',
  description: 'Executes one compiled Canon build segment (validated IR via args)',
  whenToUse: 'Invoked by the Canon orchestrator between HITL gates. Not for direct use.',
}

const ir = args.ir
const trace = []
const T = (id, status, extra) => trace.push({ id, status, ...extra })

// --- DAG scheduler: ready-set loop, finer-grained than waves ---
async function runDag(node) {
  const done = new Map(), failed = new Set()
  let pending = [...node.tasks]
  while (pending.length) {
    const ready = pending.filter(t => t.depends_on.every(d => done.has(d)))
    if (!ready.length) { // blocked subgraph: deps failed
      pending.forEach(t => T(t.task_id, 'blocked_by_dependency'))
      return { ok: false, done, failed }
    }
    pending = pending.filter(t => !ready.includes(t))
    const results = await parallel(ready.map(t => () => runTask(node, t)))
    ready.forEach((t, i) => results[i]
      ? done.set(t.task_id, results[i])
      : failed.add(t.task_id))
    if (failed.size) { log(`tasks failed: ${[...failed].join(', ')}`); return { ok: false, done, failed } }
  }
  return { ok: true, done, failed }
}

async function runTask(node, t) {
  const prompt = renderPrompt(t.prompt_template, t, ir.env) // pure string assembly from IR — deterministic
  for (const rung of node.ladder) {
    const opts = { agentType: t.agent_type, schema: SCHEMAS[t.schema_ref],
                   phase: 'Implement', label: t.task_id,
                   ...(rung === 'model:opus' ? { model: 'opus' } : {}) }
    if (rung === 'split') return await runSplit(node, t)   // deterministic halving by file index
    const r = await agent(prompt, opts)                    // never throws; null on skip/death
    if (r && r.status === 'DONE') { T(t.task_id, 'completed', { commit: r.commit_sha }); return r }
    T(t.task_id, `ladder:${rung}:${r ? r.status : 'null'}`)
  }
  return null
}

// --- bounded review→fix loop (G1 cap, G3 routing, schema verdicts) ---
async function reviewFixLoop(reviewNode, fixTemplate, maxIter) {
  let verdict = await runFanoutReview(reviewNode)          // parallel + in-script dedup + probes
  for (let i = 0; i < maxIter && verdict.level === 'BLOCKING'; i++) {
    const fix = await agent(renderPrompt(fixTemplate, { findings: verdict.blocking }, ir.env),
      { agentType: 'canon:engineer', schema: SCHEMAS.FixResult, phase: 'Fix' })
    if (!fix) return { verdict, exhausted: true }
    verdict = await runFanoutReview(reviewNode)
  }
  return { verdict, exhausted: verdict.level === 'BLOCKING' }
}

// --- main: interpret nodes sequentially; early-return = soft gate ---
for (const node of ir.nodes) {
  phase(node.id)
  if (budget.total && budget.remaining() < 30_000) {
    return { status: 'PAUSED_BUDGET', step_trace: trace, resume_point: node.id }
  }
  const out = await RUNNERS[node.kind](node)               // table-driven; no per-flow branching
  if (out && out.early_return) {
    return { status: out.status, step_trace: trace, resume_point: node.id, detail: out.detail }
  }
}
return { status: 'SEGMENT_COMPLETE', step_trace: trace, verdicts: collectVerdicts(trace) }
```

Notes the judge should check against the constraint ledger: no clock, no randomness, no
fs, no MCP, plain JS, `meta` pure literal, `agent()`-null handled everywhere,
`budget.total &&` guard, `log()` on every bounded coverage, table-driven node dispatch
(the shape-agnosticity lint from the prior epic — "no `if flow === …`" — applies to
`RUNNERS` verbatim).

### 3.4 State flow: two journals, one writer

The Workflow harness journal (per-`agent()` results, keyed by `runId`) is treated as
**authoritative for in-run grain**. The Canon journal is a **projection**:

1. Before invoking a segment: one `log_step({ step_id: "segment:seg-2", status: "started" })`.
2. On notification: `ingest_segment_trace({ workspace, runId, step_trace })` expands the
   trace into per-vocabulary-step journal entries (with `runId` + agent labels
   cross-referenced) and the segment completion — written in a single locked
   transaction by the only writer that exists (the orchestrator).

This resolves HC-3 without breaking doctrine: agents still never touch
journal.json/orchestration.db; the script never needs fs; and the known write race
(supervised-build-quality.md:179 precondition) is not mitigated but **made impossible
in compiled regions** — there are no concurrent `log_step` writers left.

Skip predicates are evaluated in the runner from the git-facts scout node's structured
output, and every skip lands in the trace with its closed-vocabulary `skip_reason` —
ingest validates skip reasons against the vocabulary at write time. An empty skip
reason becomes a hard ingest error, not a protocol violation someone must notice.

### 3.5 HITL: segment-at-gates, answers as forward-only args

Gates are conducted by the orchestrator exactly as the existing catalog specifies
(AskUserQuestion + present_artifact + renderer HTML — the HTML now produced by an IR
node, so it always exists). The compiler computes the firing-gate set from tier:

| Tier | Firing gates | Typical segments for a feature build |
|---|---|---|
| autonomous | plan approval, initial review verdict | 2–3 (near-whole-build; W8 realized) |
| light-touch | + WARNING close-out, manual verification, adversarial absent | 3–4 |
| supervised | + build-step checkpoints after design/implement/verify/review, adversarial re-review | 5–8 (segments shrink; value survives — see below) |

Two rules make this safe:

- **Forward-only answers.** A gate answer is injected as `args.hitl_answers[gate_id]`,
  consumed only by post-gate nodes' prompt templates. Pre-gate `agent()` calls keep
  byte-identical (prompt, opts) — so a TaskStop'd or edited run resumed via
  `resumeFromRunId` retains its full cached prefix.
- **Early return = soft gate.** Mid-segment BLOCKED conditions (merge conflict,
  escalation exhausted, verify hard-fail) return a structured status + `resume_point`.
  The orchestrator conducts the corresponding catalog gate (merge-conflict, gate-failure)
  and re-invokes; the prefix cache replays everything before the failure instantly.

**Departure from prior art (deliberate):** the Deterministic Spine epic deferred the
supervised tier. We compile it anyway. A supervised build degenerates toward
one-step-per-segment — and that is still strictly better than today: each step gains
typed statuses, in-code loops (the review-fix loop fits inside one segment even under
supervised, because the catalog's checkpoints are per major step, not per iteration),
trace-projected journaling, structural renderer spawns, and resume. Segment size is a
tier parameter, not a viability cliff.

### 3.6 Worktrees (HC-1 compliant)

`isolation: 'worktree'` is never used. The build worktree is created by
`init_workspace` as today. DAG task agents are real agents with Bash (A3): the IR
worker prompt carries the existing worker-prompt.md mechanics — create
`{projectDir}/.canon/worktrees/{task_id}` on `canon-task/{task_id}` branched from
`BUILD_BASE_COMMIT`, commit with provenance trailers, report a typed `TaskResult`
containing the commit SHA. The merge-agent node runs the merge protocol's exact git
commands (alphabetical `--no-ff`, post-merge per-file diff assertion from IR data,
abort-and-return on conflict). Sequential single-worktree builds compile to a chain of
`agent()` nodes sharing `{workspace}/worktree` — the live path today, unchanged in
semantics, upgraded in substrate.

### 3.7 Opt-in (HC-4 compliant)

Three stacked consents, strongest wins:

1. **Skill channel** — the Canon skill instructs Workflow usage (explicitly sanctioned
   by the spec's opt-in list).
2. **Per-build consent at plan approval** — the always-mandatory plan-approval gate
   presents "Execution: compiled workflow, N segments (tier: X)" in design.html and the
   text runbook. Approving the plan is approving the execution mode. Saying "no
   workflow" or "supervised mode, interpretive" selects the legacy path.
3. **Named workflows** (F12) — user invocation of a saved workflow is itself opt-in.

---

## 4. Conflict resolutions

### HC-1 — `isolation:'worktree'` auto-merge vs Canon-owned lifecycle
Resolved by exclusion + relocation (§3.6): the opts flag is banned by IR schema
(`validateWorkflowPlan` rejects any node carrying `isolation`), worktree mechanics stay
agent-side per worker-prompt.md, and merge execution moves to a dedicated merge-agent
node executing IR-declared commands. Canon retains full merge custody; conflicts
early-return to the merge-conflict gate.

### HC-2 — No mid-run HITL vs the gate catalog
Resolved by segment-at-gates with tier-derived boundaries (§3.5), plus two native
mechanisms the catalog gains as new user verbs: `/workflows` per-agent skip (the runner
treats the resulting `null` per node-class null-policy and records `user_skipped` in
the trace) and TaskStop → resume. The two always-mandatory gates (plan approval,
initial review verdict) are compiler invariants: `compile_runbook` refuses to emit a
plan that does not segment at both — they cannot be compiled away even by a buggy
runbook. Early-return soft gates handle mid-segment failure surfacing. Supervised tier
compiles to smaller segments rather than being deferred.

### HC-3 — Sandboxed script vs MCP/journal/fs
Resolved by role separation: the script computes and routes; **agents** (which have
Bash, fs, and MCP via ToolSearch) do all world-touching work; the **orchestrator** does
all journal writes via `ingest_segment_trace` as the single writer (§3.4). Artifacts
remain on disk written by agents (artifact-write-before-return unchanged); the script
reads only structured returns. Doctrine ("journal is harness-tool-managed only") is
preserved, and the write-race precondition is eliminated in compiled regions.

### HC-4 — Opt-in vs default-to-action
Resolved by the three-channel consent stack (§3.7). The bare conflict is settled by the
spec's own "a skill instructs it" channel; we add per-build human consent folded into
the always-firing plan-approval gate because determinism should be auditable, not
sneaky. Consent state is recorded in the trace ledger (`execution_mode: compiled`,
gate id, timestamp from args).

### HC-5 — Resume determinism vs live enrichment
Resolved by the enrichment freezer (F9): all spawn enrichment is materialized to
immutable per-segment snapshot files; IR prompts reference stable paths, so (prompt,
opts) are byte-stable across replays while agents read full content from disk. In-run
dynamic facts come from scout nodes whose results are journaled — on replay the cached
scout result reproduces downstream prompts exactly. Timestamps enter via `args`.
Staleness is bounded to segment grain, which is exactly the grain at which a human
re-approves direction anyway. Re-spawn enrichment (S10) is retired inside compiled
regions; resume replaces it (F7).

### HC-6 — `budget` ownership/units vs turn budgets
Accepted as-is; no fight with the primitive. Per-node pacing stays prompt-level
(`turn_budget` text frozen into IR prompt templates). The runner adds two deterministic
behaviors: every loop is `budget.total &&`-guarded, and an under-threshold check
early-returns `PAUSED_BUDGET` with a resume point rather than letting a mid-loop
`agent()` throw at the ceiling. FLEET-style width scaling activates only when a user
directive exists; otherwise width comes from G6/IR and the runtime's own concurrency
cap governs.

### A1 unknown — do hooks fire inside workflow-spawned agents?
**Probe (Increment 0):** a 3-node probe workflow spawning `agentType:'canon:engineer'`
which (a) attempts an Edit outside any active workspace (expect canon-workspace-check
block if A1 true), (b) makes a tracked-Bash write attempt (destructive-guard), (c)
commits without trailers (post-commit-trailers warn). Compare observed behavior against
the same agent spawned via the Agent tool. **If A1 false:** the design does not lean on
L4 inside workflows — F11's post-segment provenance audit (trailers, artifact existence,
committed-paths ⊆ declared-files) provides a deterministic, code-level replacement
executed at ingest time, and the merge node's per-file diff assertion bounds what can
land. Hooks remain the floor outside workflows either way (X4 ships regardless).

### A2 unknown — are frontmatter tool allowlists honored for `agentType:'canon:*'`?
**Probe (same workflow):** spawn `agentType:'canon:evaluator'` (read-only allowlist)
and instruct it to attempt a Write; expect refusal/absence of the tool. **If A2 false:**
node prompts carry explicit tool-restriction text (the same L1 mechanism agents run
under today), F11 audits world-effects after the fact, and high-risk read-only roles
(refuters, judges) get `model:'haiku'` + schema-only contracts that give them nothing
actionable to write. Neither falsity blocks the architecture; both would be recorded as
constraints in the IR docs.

---

## 5. Migration path

Each increment ships independently and is valuable alone.

| # | Increment | Contents | Value if we stop here |
|---|-----------|----------|----------------------|
| 0 | **Probes + G1–G9** | A1/A2 probe workflow (results documented in references/); G1–G9 runbook field enrichment (F13); wiki-lint doc correction for stale `drive_flow` references (prior-art landmine). | Runbooks become unambiguous specifications; empirical facts replace assumptions. |
| 1 | **W4 tail segment (committed PoC, upgraded shape)** | Hand-written IR (no compiler yet) for context-sync → ship → learn through the real `canon-segment-runner` with a git-facts scout + in-code skip predicates; `ingest_segment_trace` v0 (coarse). Validates `agentType:'canon:*'` path, A3 worktree/git access, trace ingestion, notification tail. | The user's strongest standing rules (never skip learner/tail) become structural on every build. |
| 2 | **Typed statuses + verify/review-fix segment** | Schemas for status/verdict/coverage (F3); compiled verify → review fan-out → bounded fix loop → renderer segment (F5, F6) invoked for fix-type and light-touch builds. | The highest-drift loop in Canon (review-fix, renderer obligation, verdict parsing) is code; Tier-2 typed-status item shipped natively. |
| 3 | **`compile_runbook` transpiler + segment-at-gates** | Full pure compiler over the closed 17-step vocabulary + `validateWorkflowPlan`; autonomous + light-touch builds compile end-to-end; trace projection at full grain; F9 freezer; F10 UX. | Whole inter-gate regions deterministic; TTL bug starved; resume-first recovery live. |
| 4 | **DAG segment on Workflow** | F4 ready-set scheduler + merge-agent + provenance audit (F11); TeamCreate path demoted to fallback behind the env flag check (closes the standing degrade-gracefully TODO). | Parallel builds run on a stable substrate; PR #167 tooling gap closed without rebuilding wave helpers. |
| 5 | **Supervised compilation + W8** | Supervised tier compiles to fine segments; autonomous tier runs near-whole-build (2–3 segments). Interpretive path retained but demoted to explicit user request. | Maximal end state; orchestrator is a gate conductor. |
| 6 | **Prose retirement + F12** | CLAUDE.md protocol sections (DAG protocol mechanics, journal choreography, merge steps) shrink to pointers at IR semantics docs; saved diagnostic/maintenance workflows ship. | The manual stops being the runtime. |

Rollback at every increment: the interpretive path is never deleted (it is also the
no-consent path), so any segment class can be reverted to orchestrator-driven execution
by a one-line routing change.

---

## 6. Risks & rejected alternatives

**Rejected: per-build generated workflow scripts.** Generated code must be trusted or
reviewed every build; any codegen nondeterminism breaks prefix caching; a codegen bug is
arbitrary behavior. IR-as-data + static runner gets identical expressive power with a
schema check instead of a code review. (This also answers "you rebuilt the #151 flow
engine": #151 deleted a *persisted, hand-authored, per-flow* library + bespoke engine.
Here there is exactly one flow-agnostic runner, lint-guarded against per-flow branching,
and the per-build artifact is ephemeral validated data downstream of a freshly designed
runbook. The closed 17-step vocabulary remains the guarded invariant.)

**Rejected: in-workflow HITL emulation** (polling agents, sentinel files, wait-loops).
No primitive exists; it would burn agents as timers (no clock in-script), and it fights
the tool's explicit design. Segment-at-gates is the sanctioned shape and matches Canon's
prior decision.

**Rejected: agents self-logging journal steps via MCP.** Capability exists (ToolSearch)
but it breaks standing doctrine, re-introduces the multi-writer race that F2 exists to
delete, and produces a worse audit trail than trace projection (no runId linkage).

**Rejected: rebuilding wave helpers on agent teams.** Teams are env-gated experimental;
the wave tooling was deliberately deleted (PR #167); Workflow's scheduler + concurrency
management is stable, journaled, and resumable. Teams remain the substrate for
`compete`/`debate` steps (orchestrator-driven rounds are genuinely adaptive — out of
compilation scope by philosophy).

**Sharpest rival criticisms, answered:**

1. *"You lose mid-flight adaptivity — a human can't redirect a 40-minute segment."*
   The user has live per-agent visibility and skip power in `/workflows`, TaskStop
   ends a segment at any moment with full resume, and every adaptive decision Canon's
   catalog actually defines happens at a gate we preserve. What is lost is the
   orchestrator's ability to improvise *off-catalog* mid-segment — which is precisely
   the drift class (forgotten renderers, skipped steps, phantom logging) this design
   exists to kill. The unforeseen still surfaces: early-return BLOCKED is the runner's
   answer to anything it cannot route.
2. *"Session-only resume undercuts the resilience story."* Within-session kills (the
   common case: TTL bugs, stalls, user stops) get prefix-cached resume. Cross-session,
   `compile_remainder` re-emits the un-executed suffix from the trace ledger — no
   cached prefix, but deterministic re-entry with zero re-implementation, strictly
   better than today's re-spawn enrichment prose.
3. *"The runner is a single point of failure."* It is small (interpreter over ~8 node
   kinds), pure-logic, unit-testable in Node with a mocked `agent()`, versioned, and
   schema-guarded on both input (IR) and output (SegmentResult). Canon has never had an
   orchestration component this testable — the current single point of failure is an
   LLM reading prose.
4. *"Schema returns will drift from on-disk artifacts."* F11 audits artifact existence
   at ingest; the reviewer's REVIEW.md remains the human/renderer source; schemas carry
   routing data only (verdict level, finding keys, status enums). Divergence is itself
   a detectable, deterministic check — today the same divergence (summary-vs-diff) is
   an advisory the orchestrator may forget.
5. *"Workflow itself could change under you."* True of every harness primitive Canon
   already uses (teams are worse: experimental + env-gated). Mitigation: the IR is
   substrate-neutral data; the interpretive fallback executes the same IR
   orchestrator-side; only the runner binds to Workflow APIs.

**Honest residual risks:** args-size ceiling is unspecified (mitigated by env-snapshot
indirection, §3.4); headless/cron runs may lack interactively-authenticated MCP servers
(F12 degrades: maintenance workflows check tool availability via a scout node and
early-return); `/workflows` skip mid-DAG can null a task another task depends on (the
scheduler handles it as `blocked_by_dependency` and early-returns — surfaced at the
gate, never silent).

---

## 7. Killer demo

**Build:** "Add a `get_flow_metrics` MCP tool + surface it in the drift report" —
feature tier, light-touch autonomy, 5-task DAG, the bread-and-butter Canon build.

1. **PM triage (unchanged, adaptive).** Requirements sharpened; `init_workspace`;
   PRD written; architect spawned.
2. **Architect (unchanged, adaptive).** DESIGN.md, 5 task plans, task-dag.yaml
   (schema → tool-impl → registration; docs ∥ tests), runbook with G1–G9 fields.
3. **Compile.** `compile_runbook` → 3 segments: seg-1 (nothing — design precedes the
   first gate), seg-2 (implement→verify→review→render), seg-3 (tail). Validation
   passes; design.html shows the segment plan and "Execution: compiled workflow".
4. **Gate: plan approval** (mandatory; doubles as Workflow consent). User approves.
5. **One tool call:** `Workflow({ name: 'canon-segment-runner', args: { ir: seg2, … } })`.
   Returns immediately; the user watches `/workflows`: phase *Implement* shows
   `schema-types` and `docs` running concurrently, `tool-impl` starting the moment
   `schema-types` completes (ready-set scheduler, not wave barriers). Each engineer
   builds in its own `canon-task/*` worktree, commits with trailers, returns a typed
   `TaskResult{status, commit_sha, criteria_coverage[]}`.
6. **Mid-build kill (the money moment).** The session dies at reviewer 2 of 3.
   Re-open; orchestrator finds the segment journal entry `started`, calls
   `Workflow({ scriptPath, resumeFromRunId })`: all 5 task agents, the merge agent,
   verify, and reviewer 1 replay **instantly from cache**; reviewers 2–3 run live.
   No re-spawn enrichment prose, no cliff HITL, no re-implementation. Total recovery
   cost: one tool call.
7. **In-segment loop.** Verdict computes to BLOCKING(2) in code from schema findings
   (one minority finding probed by a refuter — capped, `log()`ged). One fix iteration
   runs (bound 3); re-review returns WARNING. Renderer node writes review.html.
   Segment returns `{status:'SEGMENT_COMPLETE', verdicts:{review:'WARNING'}, step_trace:[…14 entries…]}`.
8. **Ingest + gate.** `ingest_segment_trace` writes 14 journal entries + provenance
   audit (trailers ✓, artifacts ✓, paths ⊆ declared ✓) in one transaction.
   Orchestrator presents the review-verdict gate with review.html (it cannot forget —
   the HTML already exists) and the WARNING close-out. User acknowledges; the answer
   becomes `args.hitl_answers['warning-closeout']` for seg-3 only.
9. **Tail segment.** scout-facts → scribe (commits docs on the build branch; trace
   carries the commit SHA — the post-scribe scope guard runs at ingest as a line-count
   check against the trace diff) → shipper (PR created) → learner. Structurally
   present; Stop-hook would refuse session end if it weren't.
10. **Finalize.** `finalize_workspace` verifies a journal with zero ghost steps, every
    skip carrying a vocabulary reason, every step carrying a `runId` — a build whose
    entire execution is replayable, auditable data.

Orchestrator messages for the whole build: roughly six (classification, two gate
presentations, two progress lines, completion summary) — versus ~40+ today. The
TTL-bug window never opens.

---

### Status

DONE

**Artifact:** `${WORKSPACE}/plans/${SLUG}/PROPOSAL-A.md` (this file)

**Summary:** Determinism-maximalist integration: a single hand-written, versioned
segment-runner workflow interprets per-build `WorkflowPlan` IR compiled by a pure
`compile_runbook` MCP tool from the architect's runbook + DAG; segment-at-gates from
tier; trace-ledger journal projection (single-writer — deletes the journal race);
schema-typed statuses; DAG scheduling on Workflow replacing experimental TeamCreate;
compiled review-fix/escalation/tail loops; resume-first recovery; three-channel opt-in;
A1/A2 probes with safe degradation; 7-increment migration each independently shippable.
