<!-- Persisted from .canon/history/fresh-architect-review-of-claude-code-workflow-tool — explore flow 2026-06-07; competition: 3 proposals, 3 judges, synthesis ratified at HITL -->
# PROPOSAL-C — Workflow-Native Rethink: One Trusted Runner, Compiled Segments, Gates Between

> Team C of 3. Design philosophy: design Canon as if the Workflow tool were its
> primary orchestration substrate from day one; then map back to a real,
> increment-by-increment migration. Sources: `research/workflow-tool-spec.md`
> (authoritative), `CAPABILITY-REVIEW.md` (shared fact base), Canon as-built
> (CLAUDE.md, references/, docs/supervised-build-quality.md §Deterministic Spine).

## ASSUMPTIONS

- A1/A2 from the capability review are inherited, NOT assumed resolved. This design
  ships its own probe (Feature F12, Migration M0) and includes contingency branches
  for both failure outcomes (§4.7).
- A3 (workflow-spawned agents are real agents with Bash/git) is load-bearing for the
  wave-execution design; the M0 probe verifies it alongside A1.
- The Workflow tool remains same-session-resume only; cross-session recovery stays
  artifact-grain (unchanged from today). No design element below depends on
  cross-session run resume.
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` may be withdrawn at any time; this design
  treats that as an expected event, not a risk.

---

## 1. Vision

**Today, Canon's orchestration engine is an LLM reading prose.** The DAG protocol,
the consolidation algorithm, the escalation cascade, the journal discipline, the
re-spawn enrichment recipe — each is a page of English that the orchestrator model
re-interprets on every build, with hooks as the only deterministic backstop. Every
one of those pages is a hand-rolled, drift-prone reimplementation of something the
Workflow tool now does natively: deterministic control flow, journaled execution,
prefix-cached resume, schema-validated agent results, managed concurrency,
structural single-task dispatch, live progress UI.

**End state.** A Canon build is a short sequence of Workflow invocations — typically
two to four **segments** — with HITL gates conducted between them, exactly where
Canon's gate catalog already says they belong. Every segment is executed by **one
permanently-trusted, hand-written, versioned runner script** (`canon-run`), which
interprets a compiled, schema-validated **SegmentPlan** passed as `args` — data, not
generated code. The orchestrator finally becomes what CLAUDE.md already declares it
to be: a Product Manager. It sharpens requirements, approves plans, conducts gates,
and reads structured segment results. It no longer hand-executes merge choreography,
greps SUMMARY files for the word "DONE", or counts fix-loop iterations in its head.

What the user sees: after plan approval, the build disappears into the background.
`/workflows` shows a live progress tree whose phase names ARE the runbook step IDs.
A notification arrives; `review.html` is already rendered (a renderer node was the
segment's last agent); the verdict gate is presented instantly. If the laptop lid
closes mid-wave, resume replays the finished prefix from cache in seconds and
continues from the exact `agent()` boundary where it died. The ~100-message
cache_control TTL failure mode that motivated Silent Dispatch stops being reachable,
because a 40-step build now costs the conversation four messages.

What survives untouched — because it is Canon's identity, not its plumbing:
principles enforcement, the PM/architect adaptive front, every mandatory HITL gate,
Canon-owned worktree discipline, commit provenance, artifact-on-disk auditability,
the mandatory tail, and the learner. The rethink eliminates accidental complexity;
it does not relocate judgment.

---

## 2. Feature inventory

Ranked by leverage. "Replaces/strengthens" references the S1–S19 surface map in the
capability review.

| # | Feature | What it does | Workflow primitive(s) | Replaces / strengthens | Effort | Leverage |
|---|---------|--------------|----------------------|------------------------|--------|----------|
| F1 | **`canon-run` generic runner** | One hand-written, versioned, permanently-trusted saved workflow that interprets a SegmentPlan passed via `args`. Zero per-build generated code. | `name`/`scriptPath` + verbatim `args`, `agent(agentType)`, `parallel`, `phase`, `log` | Replaces orchestrator-conducted step sequencing (S3 execution half, S18 recipe execution) | L | Very high |
| F2 | **Segment compiler (`compile_segments`)** | Pure MCP function: (runbook, task-dag.yaml, tier, frozen enrichment) → N validated SegmentPlan JSONs, split at firing-gate boundaries (G8 data). Extends `dag-validator.ts` lineage. | feeds F1 via `args` | Replaces prose runbook interpretation (S3); subsumes Deterministic Spine W1–W3 | M–L | Very high |
| F3 | **Schema-validated agent contracts** | JSON Schemas for StatusBlock, ReviewFindings, Verdict, GateReport, MergeReport, TailReport embedded in SegmentPlans; every in-workflow agent returns a validated object with tool-layer retry. | `agent(…, {schema})` | Replaces regex status-scan (S17 typed-status gap — lands the Memory-Integrity Tier-2 epic item natively); strengthens S6, S12 verdict routing | S | Very high |
| F4 | **Wave execution on `parallel()`** | DAG waves as structural code: one `agent()` per task (single-task guard becomes structural), runtime-managed concurrency, merge-agent node performing alphabetical `--no-ff` merges + per-file diff verification, conflict → early return → existing merge-conflict HITL. | `parallel`, `agent(agentType:'canon:engineer')`, null-semantics | **Replaces S5's TeamCreate dependency** (experimental, env-gated, wave tooling deleted in PR #167) | M | Very high |
| F5 | **Review consolidation as real code** | Blast-radius partition frozen into the plan; N reviewers fan out with `ReviewFindings` schema; dedup by (file, principle, line) is literal JS; minority findings get adversarial verification probe nodes (spec pattern 6); worst-case verdict computed, not narrated. | `parallel` (justified barrier: cross-item dedup), `agent({schema})` | Replaces S6 prose algorithm; strengthens minority-probe rigor | S–M | High |
| F6 | **Coded failure policy & escalation ladder** | Per-node-class `failure_policy` in the IR: retries, model escalation (`opts.model:'opus'`), scope-splitting (task file list halved — data operation), primer injection (text from plan), count-bounded (no clock); terminal → early return `BLOCKED` → gate. | `null`-return semantics, retry loops in runner | Replaces S9 in compiled regions (cascade survives orchestrator-side); defines null-policy per constraint ledger #6 | S | High |
| F7 | **Resume-native failure recovery** | Intra-segment crash/sleep/TaskStop recovery via `{scriptPath, resumeFromRunId}` prefix cache: same plan + same args = 100% prefix hit up to the failure point. | Journaled resume | **Largely obsoletes S10 re-spawn enrichment inside segments** (survives orchestrator-side); shrinks S8 cliff-detection workload | — (free with F1) | High |
| F8 | **`ingest_workflow_run` journal ingestion** | New MCP tool: at notification time the orchestrator passes the segment's structured return; the tool expands it into per-step `journal.json` entries + `orchestration.db` events, records `runId` cross-references, verifies `artifacts_expected` on disk. Single writer — dissolves the journal write race. | structured `return` value | Resolves HC-3; replaces per-spawn `log_step` choreography (S7) in compiled regions; fixes the supervised-build-quality.md:179 race precondition by construction | S–M | High |
| F9 | **In-workflow renderer nodes** | Renderer agents (haiku/sonnet per template) run as the final nodes of a segment; `design.html`/`review.html` exist before the notification fires; gate presentation is instant. Mechanizes the standing "always render at HITL" rule. | `agent(model:'haiku')` as terminal node | Strengthens S11 (obligation becomes structural) | S | Med–High |
| F10 | **Background builds + `/workflows` UX** | Inter-gate regions run as background tasks; conversation cost per build drops from ~dozens of messages to ~4; live progress phases mirror runbook step IDs (`opts.phase = step_id`). | background execution, `phase()`, `log()` | Largely obsoletes S19's motivation (TTL bug); strengthens observability (DoF 13) | — (free with F1) | Med–High |
| F11 | **`canon-tail` saved workflow** | context-sync → ship → learn as a saved, parameterized workflow; skip predicates evaluated as data (`skip_when` ports from runbook YAML); complements (does not replace) the X4 Stop-hook floor. | saved workflow + `args`, sequential `agent()` | Mechanizes S3/S16 mandatory tail (the most workflow-shaped region in Canon) | S | High |
| F12 | **`canon-probe` empirical harness** | Saved workflow that empirically answers A1 (hooks fire in workflow-spawned agents?), A2 (frontmatter allowlists honored?), A3 (Bash/git available?), returning a structured probe report. Re-runnable after every harness upgrade. | `agent(agentType)`, `schema` | De-risks constraint ledger #14; standing regression canary | S | Med (prerequisite) |
| F13 | **Adversarial-verify & loop-until-dry adoption** | Spec patterns 5–7 applied to Canon steps: security sweep as multi-modal + loop-until-dry (all-seen dedup); review minority findings as N-refuter majority-kill; `/canon:diagnose`-style saved diagnostic workflows users can invoke by name (itself an opt-in channel). | pipeline, adversarial patterns | Strengthens S6/security step; new user-facing entry points | S | Med |
| F14 | **G1–G9 runbook field enrichment** | The Deterministic Spine precursor, unchanged in spirit: loop bounds, exit predicates, failure-routing edges, evaluable skip predicates, merge strategy, tier→gate semantics (G8, load-bearing for F2). G5 per-node budget survives only as prompt-level turn budgets (HC-6); G6 width keeps a cost-control role only. | n/a (compiler input) | Converts runbook from document to specification (S3 authoring half) | S | High (prerequisite for F2) |
| F15 | **Scout-node enrichment** | Live state (git diff, completed files, current violations) fetched by a first-position scout `agent()` whose cached result deterministically reproduces all downstream prompts on resume. | journaled `agent()` results | Resolves HC-5's live-state half; replaces re-spawn enrichment's data-gathering | S | Med |

---

## 3. Architecture

### 3.1 The shape of a build

```
PM triage ──► architect (runbook + task-dag + G1–G9 fields)
                  │
                  ▼
        compile_segments (MCP, pure function)
                  │   tier × G8 → firing-gate set → segment boundaries
                  ▼
   SegmentPlan[1..N]  (JSON, schema-validated, stored in ${WORKSPACE}/plans/${slug}/segments/)
                  │
   ┌──────────────┴───────────────────────────────────────────┐
   │ for each segment:                                        │
   │   Workflow({ name:'canon-run', args:{ plan, frozen } })  │  ← background
   │   … <task-notification> …                                │
   │   ingest_workflow_run({ workspace, runId, result })      │  ← journal + artifact checks
   │   conduct gate (AskUserQuestion + present_artifact)      │  ← orchestrator-side HITL
   │   gate answer parameterizes NEXT segment's args          │
   └──────────────────────────────────────────────────────────┘
```

**Who authors what.** The runner (`canon-run`) and the special-purpose saved
workflows (`canon-tail`, `canon-probe`, diagnostic workflows) are hand-written,
code-reviewed once, versioned in the repo (proposed home: `skills/canon/workflows/`,
installed to `.claude/workflows/` at plugin install — same distribution path as
hooks). Nothing model-generated is ever executed as code. Per-build variation is
100% data: the SegmentPlan, compiled by a pure, unit-tested MCP function from
artifacts the architect already produces. This is the capability review's
"runner-plus-args" degree of freedom (§5.2) and the Deterministic Spine's "validated
IR, not generated source," given its native home.

**Resume vs gates — a clean separation.** Segments END at gates by construction, so
a gate answer never mutates a running script's prompts: it parameterizes the *next*
segment's `args`. `resumeFromRunId` is reserved exclusively for intra-segment
failure (crash, sleep, TaskStop, budget abort) where plan and args are unchanged —
the case with a guaranteed 100% prefix-cache hit up to the failure point. The two
mechanisms never interact, which keeps the cache-invalidation rules trivial to
reason about.

**The runner stays dumb.** `canon-run`'s `meta` is a pure literal with no `phases`
(per-plan phases can't be literal); each `agent()` call sets `opts.phase` to the
plan node's runbook `step_id`, so `/workflows` progress groups mirror the runbook
exactly without `meta.phases` matching. All schemas, prompts, primer text, trailer
blocks, and policies arrive inside the plan. The runner's only knowledge is the IR's
node grammar.

### 3.2 SegmentPlan IR (sketch)

```json
{
  "ir_version": 1,
  "runner_min_version": 1,
  "slug": "address-learner-proposals-x",
  "workspace": ".canon/workspaces/...",
  "worktree": ".canon/workspaces/.../worktree",
  "base_commit": "85b0056d",
  "invoked_at": "2026-06-07T18:02:11Z",
  "nodes": [
    { "id": "scout-state", "kind": "scout", "step_id": "implement",
      "prompt": "Report git status/diff summary for ${worktree} as structured data…",
      "schema": { "$ref": "#/schemas/ScoutReport" } },
    { "id": "wave-1", "kind": "wave", "step_id": "implement",
      "tasks": [
        { "task_id": "task-a", "agent_type": "canon:engineer",
          "prompt": "…plan text + preloads + trailers + turn_budget: 40…",
          "schema": { "$ref": "#/schemas/StatusBlock" },
          "failure_policy": { "retries": 1, "escalate_model": "opus", "then": "abort_segment" } }
      ],
      "merge": { "strategy": "alphabetical-no-ff", "agent_type": "canon:engineer",
                 "schema": { "$ref": "#/schemas/MergeReport" } } },
    { "id": "verify", "kind": "agent", "step_id": "verify", "…": "…" },
    { "id": "review", "kind": "review_fanout", "step_id": "review",
      "partitions": [ { "files": ["…"], "reviewer_no": 1 } ],
      "minority_probe": { "max": 5, "refuters": 3 } },
    { "id": "render-review", "kind": "agent", "step_id": "review",
      "model": "sonnet", "prompt": "…renderer-review template, filled…" }
  ],
  "ends_at_gate": "review_verdict",
  "schemas": { "StatusBlock": { "type": "object", "required": ["status"], "…": "…" } }
}
```

The compiler validates this against a JSON Schema (sibling of `dag-validator.ts`)
before any invocation; a plan that fails validation never reaches the harness.
Frozen enrichment (`resolve_agent_skills` preloads, `get_context` snapshots,
`base_commit`, `invoked_at`) is embedded at compile time — satisfying the
determinism ban with zero in-script fetching.

### 3.3 Illustrative runner (core mechanism)

A realistic excerpt of `canon-run` — plain JS, pure-literal meta, no clock, no fs,
null-policy explicit, no-silent-caps honored:

```js
export const meta = {
  name: 'canon-run',
  description: 'Canon segment runner: executes one compiled, schema-validated SegmentPlan (passed as args). Hand-written and versioned; never model-generated.',
  whenToUse: 'Invoked by the Canon orchestrator between HITL gates. Not for direct ad-hoc use.',
}

const plan = args.plan
if (!plan || plan.runner_min_version > 1) {
  return { status: 'INCOMPATIBLE_PLAN', runner_version: 1 }
}

const results = {}            // node_id -> structured result
let scoutData = null

async function runWithPolicy(node, promptExtra) {
  const policy = node.failure_policy || { retries: 0, then: 'abort_segment' }
  let attempt = 0
  while (true) {
    const opts = { label: node.id, phase: node.step_id, agentType: node.agent_type }
    if (node.schema) opts.schema = node.schema
    if (attempt > 0 && policy.escalate_model) opts.model = policy.escalate_model
    const prompt = node.prompt
      + (promptExtra || '')
      + (attempt > 0 ? `\n\nRETRY ${attempt}: prior attempt failed or was skipped. ${policy.retry_note || ''}` : '')
    const r = await agent(prompt, opts)        // never throws; null on skip/terminal failure
    if (r !== null) return r
    attempt += 1
    if (attempt > policy.retries) {
      log(`node ${node.id}: exhausted ${policy.retries} retries (null result)`)  // no-silent-caps
      return null
    }
  }
}

for (const node of plan.nodes) {
  phase(node.step_id)

  if (node.kind === 'scout') {
    scoutData = await runWithPolicy(node)      // cached on resume → downstream prompts deterministic
    results[node.id] = scoutData
    continue
  }

  if (node.kind === 'wave') {
    const taskResults = await parallel(node.tasks.map((t, i) => () =>
      runWithPolicy(t, scoutData ? `\n\nCurrent worktree state (scout):\n${JSON.stringify(scoutData)}` : '')
    ))
    const failed = node.tasks.filter((t, i) => taskResults[i] === null).map(t => t.task_id)
    if (failed.length) {
      log(`wave ${node.id}: ${failed.length} task(s) unrecoverable: ${failed.join(', ')}`)
      return { status: 'BLOCKED', at: node.id, failed_tasks: failed, results }
    }
    // merge is a barrier-justified sequential agent: needs ALL task branches
    const merge = await runWithPolicy({ ...node.merge, id: `${node.id}-merge`, step_id: node.step_id,
      prompt: node.merge.prompt + `\n\nTask branches to merge (alphabetical, --no-ff):\n`
        + node.tasks.map(t => `canon-task/${t.task_id}`).sort().join('\n') })
    if (merge === null || merge.conflicts?.length) {
      return { status: 'MERGE_CONFLICT', at: node.id, report: merge, results }
    }
    results[node.id] = { tasks: taskResults, merge }
    continue
  }

  if (node.kind === 'review_fanout') {
    const reviews = (await parallel(node.partitions.map(p => () =>
      runWithPolicy({ ...node, id: `review-${p.reviewer_no}`, kind: 'agent',
        prompt: node.prompt + `\nYou are reviewer ${p.reviewer_no} of ${node.partitions.length}. Files:\n` + p.files.join('\n') })
    ))).filter(Boolean)
    // Consolidation is literal code, not narrated protocol:
    const byKey = {}
    for (const r of reviews) for (const f of (r.findings || [])) {
      const k = `${f.file}|${f.principle}|${f.line}`
      ;(byKey[k] = byKey[k] || []).push(f)
    }
    const confirmed = [], minority = []
    for (const k of Object.keys(byKey)) (byKey[k].length >= 2 ? confirmed : minority).push(byKey[k][0])
    const probed = minority.slice(0, node.minority_probe.max)
    if (minority.length > node.minority_probe.max)
      log(`minority probe capped at ${node.minority_probe.max}; ${minority.length - node.minority_probe.max} logged unverified`) // no-silent-caps
    const verdicts = await parallel(probed.map((f, i) => () =>
      agent(`Adversarially verify (default refuted=true if uncertain): ${f.title} at ${f.file}:${f.line}`,
        { label: `probe-${i}`, phase: node.step_id, schema: plan.schemas.Verdict })))
    const verified = probed.filter((f, i) => verdicts[i] && !verdicts[i].refuted)
    const all = confirmed.concat(verified)
    const verdict = all.some(f => f.severity === 'BLOCKING') ? 'BLOCKING'
                  : all.some(f => f.severity === 'WARNING') ? 'WARNING' : 'CLEAN'
    results[node.id] = { verdict, confirmed, minority_verified: verified,
                         dismissed: probed.filter((f, i) => verdicts[i]?.refuted),
                         unverified: minority.slice(node.minority_probe.max) }
    continue
  }

  // plain agent node (verify, fix, render, tail steps…)
  const r = await runWithPolicy(node)
  if (r === null && (node.failure_policy?.then || 'abort_segment') === 'abort_segment') {
    return { status: 'BLOCKED', at: node.id, results }
  }
  results[node.id] = r
  if (r && r.status === 'HAS_QUESTIONS') {
    return { status: 'HAS_QUESTIONS', at: node.id, questions: r.questions, results }
  }
}

return { status: 'SEGMENT_COMPLETE', ends_at_gate: plan.ends_at_gate, results }
```

Real-world hardening (bounded loop nodes with G1/G2 contracts, budget guards
`budget.total && budget.remaining() < RESERVE` → graceful `BUDGET_ABORT` return,
per-node telemetry counters in the return value) is straightforward extension of
this grammar; the production runner is estimated under ~400 lines, unit-testable
node-grammar logic.

### 3.4 State: two journals, one writer each

| Store | Grain | Writer | Role |
|---|---|---|---|
| Workflow run journal (harness) | per-`agent()` call | harness, automatic | authoritative in-segment; powers resume |
| `journal.json` + `orchestration.db` | per-runbook-step | `ingest_workflow_run`, orchestrator-side, at notification time | authoritative build record; powers finalize, resume protocol, analytics |

`ingest_workflow_run` maps the segment's structured `results` (keyed by node id →
runbook `step_id`) into journal entries, attaches the `runId`, records
`record_agent_metrics`-equivalent telemetry, and runs the artifact-presence checks
that today happen per-spawn. One writer per store; the journal write race
(supervised-build-quality.md:179) is dissolved for compiled regions by construction
rather than by adding locks. Agents still never touch `journal.json` — doctrine
unchanged. For killed runs, `reconcile_workspace` gains one lookup: a segment step
with a `runId` but no ingestion → point the user at the run (resumable) instead of
generic cliff surfacing; `capture_transcript`'s fallback maps to the spec's own
`agent-<id>.jsonl` fallback.

### 3.5 Worktrees

Unchanged invariant: Canon owns the worktree lifecycle. `init_workspace` creates
`{workspace}/worktree` on `canon/{slug}` (with the known `test -d` verification).
Sequential nodes share the build worktree. Wave tasks: each engineer agent creates
its own `canon-task/{task_id}` worktree from `base_commit` via git commands
(worker-prompt pattern; A3) — the prohibition is on the `isolation:'worktree'`
*flag*, never on worktrees. Merging is a dedicated merge-agent node (it needs git;
the script has none) returning a structured `MergeReport` with per-file diff
verification results; conflicts early-return to the existing merge-conflict HITL.
Provenance trailers (Canon-Workflow/Agent/State/Task) ride in every prompt from the
plan; post-commit-trailers hook + `completion-verify.sh` remain the floor.

### 3.6 Opt-in (how the rule is satisfied)

Three sanctioned, layered channels:

1. **Skill instruction** — the Canon skill explicitly instructs Workflow use for
   compiled segments (the spec's own sanctioned channel; HC-4).
2. **Plan-approval consent** — the always-mandatory plan approval gate names the
   segments: "Segments 2–4 will execute as background workflows (visible in
   /workflows). Approve plan & execution?" Per-build, explicit, auditable, and free:
   the gate already exists at every tier.
3. **Named workflows** — `canon-tail`, diagnostic workflows, and `canon-run` itself
   are user-invocable saved workflows; direct invocation is opt-in by definition.

### 3.7 Survives vs replaced — verdict over the 19 mechanisms

| # | Mechanism | Verdict | Why |
|---|---|---|---|
| S1 | PM triage / Pre-Build Gate | **SURVIVES** | Adaptive, conversation-driven judgment. No Workflow primitive carries a requirements conversation; nothing here is drift-prone reimplementation. |
| S2 | Autonomy tier | **SURVIVES (promoted)** | Already a pure signal→tier function. Becomes a compiler *input* (G8): tier now mechanically determines segment boundaries instead of advising an LLM. |
| S3 | Runbook | **SPLIT** | Authoring half survives (architect judgment + closed vocabulary as the shape-agnosticity guard). Execution half **replaced**: prose-interpreted sequencing → compiled SegmentPlans (F2). |
| S4 | Task DAG + validator | **SURVIVES (absorbed)** | Pure data + pure validator — exactly the right shape already; becomes compiler input; validator lineage extends to `validateSegmentPlan`. |
| S5 | Team dispatch (TeamCreate DAG) | **REPLACED** (F4) | Hand-rolled reimplementation of managed fan-out on an experimental, env-gated substrate whose wave tooling was deleted (PR #167). `parallel()` + structural single-task + merge-agent node is stable and simpler. Degrade path: sequential single-worktree (today's live path). |
| S6 | Team review consolidation | **REPLACED** (F5) | A deterministic algorithm currently executed by narration. Becomes literal JS in the runner — dedup, minority probes, verdict computation as code. |
| S7 | Journal / step protocol | **SPLIT** | Stores and doctrine survive. Per-spawn `log_step` choreography in compiled regions **replaced** by notification-time ingestion (F8) — single writer, race dissolved. Orchestrator-side steps keep `log_step`. |
| S8 | Reconcile / cliff detection | **SURVIVES (shrunk)** | Still needed at workspace grain and for orchestrator-side steps. In-segment cliffs become `null`s (policy-handled in code) or resumable runs; reconcile gains a runId-aware path. |
| S9 | Escalation cascade | **SPLIT** | In compiled regions: **replaced** by coded `failure_policy` (count-bounded; the 2-min wall-clock bound is unimplementable in-script and unnecessary there). Orchestrator-side (architect/PM spawns, gate failures): survives. |
| S10 | Re-spawn enrichment | **LARGELY REPLACED in-segment** (F7, F15) | Existed because Canon lacked cheap resume. Prefix-cached resume + scout nodes cover the failure class losslessly within runs. Survives for orchestrator-spawned agents; stream-idle SendMessage resume stays orchestrator-scope. |
| S11 | Renderer protocol | **SURVIVES (strengthened)** | Templates and `present_artifact` unchanged; the spawn becomes a structural terminal node (F9) — the "always render" rule can no longer be forgotten. |
| S12 | HITL gates catalog | **SURVIVES — load-bearing** | The gate catalog *is* the segmentation function. Gains two user verbs: `/workflows` per-agent skip and TaskStop. Nothing compiled away; plan approval + initial review verdict remain mandatory at all tiers. |
| S13 | Worktree lifecycle | **SURVIVES — inviolate** | `isolation:'worktree'` stays prohibited. Agent-side git + merge-agent node preserve controlled merge, verification diffs, conflict HITL, provenance. |
| S14 | Hooks (L4) | **SURVIVES** | The only non-LLM enforcement layer; complementary regardless of substrate (A1 pending probe). X4 Stop-hook tail enforcement proceeds independently. |
| S15 | Finalize / completion checklist | **SURVIVES (simplified)** | Same checklist; many inputs arrive as structured segment results instead of grep output. Summary-vs-diff check becomes an in-segment verifier node option. |
| S16 | Learner loop | **SURVIVES (mechanized)** | Never skipped — now structurally: it is a node in `canon-tail`. Content stays fully adaptive. |
| S17 | Agent contracts | **SURVIVES (strengthened)** | Frontmatter allowlists (A2 pending probe), artifact-write-before-return, coverage tables all stay. Status protocol gains schema enforcement (F3) — the typed-status epic item lands natively. |
| S18 | Spawn enrichment | **SPLIT** | Recipe survives; *when* it runs moves to compile time (frozen into args) + scout nodes (HC-5). `resolve_agent_skills`/`get_context` unchanged as tools. |
| S19 | Silent dispatch | **MOSTLY OBSOLETED** | Background segments collapse N messages into ~4 per build; the TTL failure mode becomes unreachable. The allowlist survives for boundary moments. |

---

## 4. Conflict resolutions

### 4.1 HC-1 — `isolation:'worktree'` auto-merge vs Canon-owned lifecycle

Resolved by **never using the flag**. The conflict is with the opts flag's
auto-merge semantics, not with worktree isolation (capability review §3.2 HC-1).
Wave engineers create `canon-task/{task_id}` worktrees themselves via git
(worker-prompt pattern carries over verbatim; A3); a dedicated merge-agent node
executes the alphabetical `--no-ff` merge protocol with per-file diff verification
and returns a structured `MergeReport`; conflicts early-return the segment to the
existing merge-conflict HITL. The compiler lints plans: any node carrying
`isolation` is a validation error — the prohibition moves from prose rule to
schema-enforced impossibility.

### 4.2 HC-2 — No mid-run HITL vs the gate catalog

Resolved by **segment-at-gates with tier-driven boundaries** — embraced as the
design's spine, not worked around. `compile_segments` reads G8 (tier→gate
semantics) and splits at every firing gate: autonomous compiles to ~3 segments
around the two always-mandatory gates; light-touch similar; supervised — where
build-step checkpoints fire after every major step — compiles to near-degenerate
one-step segments, at which point compilation adds little, so **supervised keeps
the orchestrator-driven path for checkpointed regions** (consistent with the
epic's tier-gating; supervised still gets F5 review workflows and F11 tail, which
sit between checkpoints). Three native mechanisms are folded into the gate catalog
as new user verbs: `/workflows` per-agent skip (script sees `null` → failure
policy), TaskStop (→ later resume), and structured early-return soft gates
(`BLOCKED` / `HAS_QUESTIONS` / `MERGE_CONFLICT` results the orchestrator routes to
the corresponding existing HITL pattern). An agent that would have reported
HAS_QUESTIONS mid-build now ends its segment with that status — the question
reaches the user at most one node later than today, and the answered re-invocation
reuses the cached prefix.

### 4.3 HC-3 — Sandboxed script vs MCP/journal/filesystem

Resolved by a strict **capability split**: the script computes and routes; agents
touch the world; the orchestrator (via `ingest_workflow_run`) writes the build
record. The script never needs fs/MCP because (a) everything static is compiled
into `args`, (b) everything live is fetched by scout/verifier agent nodes, (c) all
bookkeeping is carried in the structured return and ingested at notification time
by a single writer. Doctrine ("agents must not write journal.json") is preserved
exactly; the known write race is dissolved rather than locked. Artifact-presence
verification moves to ingestion + optional in-segment verifier nodes.

### 4.4 HC-4 — Opt-in vs default-to-action

Resolved by the **three-channel consent story** (§3.6): skill instruction
(sanctioned by the spec's own list), explicit per-build consent line folded into
the always-mandatory plan-approval gate (zero added friction; auditable in the
gate record), and named-workflow invocation. If the user declines workflow
execution at plan approval, the orchestrator falls back to today's sequential
subagent path — the same runbook, conducted by hand. Opt-in is therefore a
per-build routing bit, not an architecture fork.

### 4.5 HC-5 — Resume determinism vs live enrichment

Resolved by **freeze-or-scout, decided per datum at compile time**. Frozen into
`args`: skill preloads, `get_context` snapshots, `base_commit`, `invoked_at`
timestamp, primer text, trailer blocks (stable within a segment by definition).
Scouted in-run: anything that legitimately changes during the segment (git state
between waves, current diff for fix prompts) — fetched by a scout node whose
journaled result reproduces downstream prompts exactly on resume. The compiler
enforces the discipline: prompts are validated to be pure functions of (plan,
scout results, prior node results); there is no third source. Re-spawn enrichment
survives only orchestrator-side, where its preconditions (no journaled resume)
still hold.

### 4.6 HC-6 — `budget` ownership/units vs turn budgets

Resolved by **keeping the two budget systems in their lanes**. Canon's per-node
pacing stays prompt-level `turn_budget` text carried in the IR (G5 survives only
in this form — the epic's per-node token budget is not expressible natively and we
do not fake it). The native token `budget` is used defensively and
opportunistically: every loop guards with `budget.total &&`; before expensive
nodes the runner checks `budget.total && budget.remaining() < RESERVE` and returns
a graceful `BUDGET_ABORT` (status-carrying, resumable) instead of letting
`agent()` throw mid-wave; FLEET-style width scaling activates only when the user
issues a "+N" directive. Escalation's `increase_budget` remains what it really
always was — a prompt-text doubling on retry.

### 4.7 A1/A2 unknowns — the probe and both contingency branches

**Probe (F12, runs in M0).** `canon-probe` is a saved workflow that spawns:
(1) `agentType:'canon:engineer'` instructed to attempt an `Edit` on a tracked repo
file with no `CANON_PARENT_WORKSPACE` set and report the exact tool response —
expected: `canon-workspace-check.sh` block (tests A1, and incidentally exercises
Bash/git for A3); (2) the same agent attempting a destructive-guard-matching
command — expected: block; (3) `agentType:'canon:evaluator'` (read-only
allowlist) instructed to attempt a `Write` — expected: tool unavailable/refused
(tests A2). Each returns a structured `{capability, attempted, blocked, evidence}`
report; the workflow returns the matrix. It is re-runnable after every harness
upgrade — a standing regression canary, not a one-shot.

**If A1 fails** (hooks don't fire inside workflow-spawned agents): the L4 floor is
absent in-workflow. Contingencies, in order: (a) code-writing nodes remain
restricted to worktree paths by prompt + schema-verified `MergeReport`/diff checks
(L2 enforcement); (b) the verify node asserts no tracked-file changes outside the
worktree (`git status` in the main tree); (c) regions where L4 is deemed
load-bearing (supervised tier) stay orchestrator-side until hook parity exists;
(d) file an upstream harness request — hook parity for `agent()` is the obvious
ask given registry parity.

**If A2 fails** (allowlists not honored): schema contracts still bound *outputs*,
but tool restriction is gone. Contingency: drop allowlist-dependent node types
(evaluator-style read-only roles) from plans; rely on L4 (if A1 holds) +
verify-node assertions; same upstream ask.

---

## 5. Migration path

Each increment ships alone and is valuable alone. Order is risk-ascending and
evidence-gated.

| Inc | Ships | Value standalone | Gate to next |
|---|---|---|---|
| **M0** | `canon-probe` + result-schema library (StatusBlock/Verdict/Findings/MergeReport as versioned JSON Schemas in `mcp-server/src/shared/schema/`) | Probe answers A1/A2/A3 empirically; schema library lands the typed-agent-status epic item even if no workflow ever runs (terminal-write tools adopt the enum) | Probe matrix green (or contingencies selected) |
| **M1** | `canon-tail` saved workflow + `ingest_workflow_run` v0 (single-segment ingestion) | Mandatory tail mechanized — the user's strongest standing rules (never-skip learner/context-sync) become structural; validates `agentType:'canon:*'` path, skip-predicate porting, in-workflow worktree git (scribe commit, shipper push), notification-time journaling. The committed W4 item, reshaped per the capability review's note: sequential awaits, not forced `pipeline()` | 3 green tail runs with clean journals |
| **M2** | `canon-review` workflow (F5): fan-out partitions, coded consolidation, minority adversarial probes, renderer terminal node | Read-mostly (lowest risk for highest pattern value); replaces the most algorithm-shaped prose in CLAUDE.md; review.html always ready at the verdict gate | Consolidated REVIEW.md parity vs current protocol on real builds |
| **M3** | Bounded review→fix→re-review loop segment (G1 cap = 3, G2 exit contract, G3 routing) for autonomous/light-touch | The highest-friction loop in supervised builds becomes deterministic where gates permit | Fix-loop convergence behavior matches HITL-pattern spec |
| **M4** | Wave execution (F4): `parallel()` waves + merge-agent node; TeamCreate demoted to non-default; explicit degrade path = sequential single-worktree | Removes the experimental env-gate dependency from Canon's parallel story; rebuilds the PR #167 gap on stable substrate; closes the standing degrade-to-sequential TODO | Multi-task DAG build merged clean end-to-end |
| **M5** | G1–G9 runbook enrichment (F14) + `compile_segments` (F2) + `canon-run` (F1); M1–M4's special-purpose workflows become compiler outputs / golden-test fixtures | The rethink proper: per-purpose workflows unify into runner+IR; tier-driven segmentation live for autonomous/light-touch | Compiler shape-agnosticity lint (no per-flow branching) + golden tests green |
| **M6** | Whole-build autonomous tier (W8 as reclassified): ~3 segments around the two mandatory gates; background-build UX as the default for autonomous | The end-state vision §1; conversation-TTL relief fully realized | — |

Rollback at every increment is trivial: each workflow has a documented
orchestrator-conducted equivalent (today's path), selected per-build at the
plan-approval consent bit.

---

## 6. Risks & rejected alternatives

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Per-build **generated workflow scripts** | Generated-code trust burden at the permission dialog; determinism audit per build; any prompt-affecting edit churns the resume cache; 512KB ceiling pressure. Runner+IR gets identical expressiveness with data-only variation. |
| **Agents self-log `log_step`** via MCP (ToolSearch makes it possible) | Violates standing doctrine (journal.json is harness-managed), and re-creates the journal write race at higher concurrency. Single-writer ingestion is strictly better. |
| **In-workflow HITL emulation** (polling agent watching for a user-written answer file) | No primitive exists (spec is explicit); an emulation burns an agent slot, has no timeout semantics, and hides a gate from the gate record. Segments-at-gates is the sanctioned shape. |
| **Compiling PM triage / architect design** into workflows | These are Canon's legitimate adaptivity — conversations, HAS_QUESTIONS loops, judgment. Workflow-native ≠ everything-in-workflows; it means *no prose reimplementations of code-shaped things*. |
| **Keeping TeamCreate as the primary parallel substrate** | Experimental, env-gated, wave tooling deleted (PR #167), single-worktree sequential is the actual live path — i.e., the current parallel story is already aspirational. Rebuild it once, on the stable primitive. **Exception**: `debate` steps need inter-agent messaging (SendMessage channels) which workflow agents lack — debate stays on teams; `compete` maps cleanly to the judge-panel pattern and migrates. |
| **`workflow()` nesting for waves** (parent segment calls child wave workflows) | 1-level nesting cap makes this a dead end the moment a child needs composition; a flat interpreter over IR has no such cliff. |

### Sharpest rival criticisms — and answers

1. **"You built an inner platform — a mini-language interpreted by a runner."**
   The IR is not a new language; it is the runbook + task-dag + G1–G9 fields Canon
   already authors, compiled by a pure function in the `dag-validator.ts` lineage,
   interpreted by a <400-line unit-tested runner. The status quo is the actual
   inner platform: an English-prose execution semantics interpreted by a
   stochastic model on every build. We are replacing the least reliable
   interpreter in the stack with the most reliable one available.
2. **"Resume is same-session only — most of your recovery story evaporates
   overnight."** Intra-session is where re-spawn enrichment burns turns today
   (stream-idle stalls, TTL kills, mid-wave deaths) — that class is covered
   losslessly. Cross-session recovery stays exactly what it is today:
   artifact-grain, journal-driven, segment re-invocation (cheap because segments
   are idempotent at artifact grain). Nothing regresses; one class improves.
3. **"Supervised tier — your flagship build mode — gains almost nothing."** By
   design and by arithmetic: supervised's gate density leaves no compiled region
   worth having (HC-2). Supervised still gains F3 schemas, F5 review workflows,
   F9 renderer nodes, F11 tail, F12 probes — every per-step mechanism. The
   segment machinery targets the tiers whose purpose is unattended execution.
4. **"The skill-instruction opt-in channel is a loophole you're driving a truck
   through."** Which is why consent is *also* collected per-build at the
   always-mandatory plan-approval gate, in plain language, recorded in the gate
   record, with a no-workflow fallback path. We use the sanctioned channel and
   then exceed it.
5. **"`agent()` returning `null` will silently eat failures."** Constraint ledger
   #6 is answered structurally: every node class carries an explicit
   `failure_policy`; the runner's `null` handling is exhaustive (retry → escalate
   → abort-with-status); every bound and drop is `log()`ged (no-silent-caps);
   wave failures enumerate failed task_ids in the return. Today's equivalent —
   an orchestrator noticing an agent died — is the weaker guarantee.
6. **"Runner version skew: an old plan meets a new runner."** `ir_version` /
   `runner_min_version` handshake (first lines of the runner); incompatible →
   structured `INCOMPATIBLE_PLAN` → orchestrator recompiles. Versioned like the
   runbook vocabulary, semver discipline included.
7. **"Two journals will drift."** They answer different questions (resume vs
   build record), have one writer each, and are cross-keyed by `runId`. Drift
   between them is detectable mechanically at ingestion (node count vs journal
   entries) — which is more reconciliation than today's single race-prone journal
   gets.

### Residual risks (owned, not argued away)

- **A1 failure would gut L4 inside workflows** — mitigations in §4.7 are L2/L3,
  weaker than hooks; supervised-tier compilation stays off until parity.
- **Harness evolution risk**: the Workflow tool is newer than TeamCreate is
  experimental; spec drift could invalidate runner assumptions. Mitigation:
  `canon-probe` as regression canary + the per-build fallback path keeps Canon
  fully operable with Workflow disabled.
- **Compiler correctness becomes load-bearing.** A wrong SegmentPlan misroutes a
  build deterministically. Mitigation: schema validation + golden-fixture tests
  (M1–M4 workflows become the fixtures) + shape-agnosticity lint; and every
  segment result still passes through gates and review.

---

## 7. Killer demo

**Build**: "Address 3 learner proposals (engineer summary paths, hook test gaps,
journal skip-reason vocabulary)" — a real, recurring Canon build type: multi-task,
cross-layer (hooks + mcp-server + references), light-touch tier.

1. **PM triage** (unchanged): sharpened request, scope check → non-trivial →
   architect. `init_workspace` creates worktree on `canon/address-learner-3`.
2. **Architect** (unchanged authority): DESIGN.md, three task plans, task-dag.yaml
   (task-a ∥ task-b, then task-c), runbook with G1–G9 fields. `compile_segments`
   reads tier=light-touch × G8 → firing gates = {plan approval, review verdict} →
   **two compiled segments** + tail.
3. **Plan approval gate**: design.html presented; approval text includes "Segments
   1–2 will run as background workflows (watch via /workflows)." User approves —
   consent recorded.
4. **Segment 1** (one Workflow call: `canon-run` + plan): scout node snapshots
   worktree state → wave 1: two `canon:engineer` agents in parallel, each creating
   its own `canon-task/` worktree, returning schema-validated StatusBlocks →
   merge-agent merges alphabetically `--no-ff`, MergeReport clean → task-c runs →
   verify node runs build/lint/test/hooks-lint, returns GateReport → review
   fan-out: 2 reviewers (blast-radius partition frozen in plan) → consolidation
   *in code*: 4 confirmed findings, 2 minority → 2 adversarial probe agents → 1
   verified, 1 dismissed-with-reason → verdict WARNING → renderer node writes
   review.html. Segment returns `SEGMENT_COMPLETE` with the full result tree.
   The conversation consumed: **one tool call**. `/workflows` showed phases
   `implement → verify → review` live the whole time.
5. **Mid-segment incident**: the laptop sleeps during task-c. On wake, the run is
   dead. Orchestrator relaunches `{scriptPath, resumeFromRunId}` — scout, wave 1,
   merge all replay instantly from the journal prefix; task-c re-executes live.
   No re-spawn enrichment prompt was composed; no completed work re-implemented.
6. **Notification → `ingest_workflow_run`**: journal.json gains implement/verify/
   review step entries with runId; artifacts verified on disk. **Review verdict
   gate**: review.html opens instantly (already rendered); verdict WARNING with 5
   findings, one tagged `[minority-verified]`, one dismissed with the refuter's
   reasoning attached.
7. User picks **Auto-fix**. Orchestrator compiles **Segment 2** parameterized by
   the gate answer: bounded fix→re-verify→re-review loop (G1 cap 3, exit contract
   `all_addressed && verdict != BLOCKING`). It converges on iteration 1, returns
   CLEAN. Light-touch: CLEAN-after-fix auto-proceeds.
8. **WARNING close-out** (advisory) conducted at the boundary; then **`canon-tail`**:
   scribe commits `docs(context-sync):` in the worktree, shipper pushes and opens
   the PR, learner writes proposals to `.canon/proposed-learnings/` — structurally
   unskippable, with skip predicates evaluated as data and every skip `log()`ged.
9. **Finalize**: journal complete (no ghost steps), runIds cross-referenced,
   provenance trailers verified, build digest written. Total conversation
   footprint: triage, plan approval, verdict gate, close-out, completion summary —
   **five visible moments**, everything else in `/workflows`.

The same build under today's Canon: ~30+ orchestrator messages, prose-conducted
merge choreography on an experimental teams substrate, a regex scan to learn the
engineer's status, a consolidation algorithm executed from memory, and a re-spawn
enrichment prompt hand-assembled after the laptop slept.

---

### Status

DONE

**Artifact**: `${WORKSPACE}/plans/${SLUG}/PROPOSAL-C.md` (this file)

**Summary**: Workflow-native rethink built on one permanently-trusted generic
runner (`canon-run`) interpreting compiled, schema-validated SegmentPlan IR passed
as `args` — segments split at HITL gates by tier (G8), structured-output schemas
replacing prose status/verdict parsing, `parallel()` waves + merge-agent replacing
the experimental TeamCreate dependency, notification-time single-writer journal
ingestion resolving HC-3 and the journal write race, and a six-increment migration
(probe → tail → review → fix-loop → waves → compiler → whole-build autonomous).
All 6 hard conflicts resolved explicitly; A1/A2 carry a concrete re-runnable probe
plus contingency branches for both failure outcomes. 11 of 19 Canon mechanisms
survive (several strengthened or promoted); 4 replaced; 4 split — every verdict
justified.
