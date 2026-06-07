<!-- Persisted from .canon/history/fresh-architect-review-of-claude-code-workflow-tool — explore flow 2026-06-07; competition: 3 proposals, 3 judges, synthesis ratified at HITL -->
# PROPOSAL-B — Leverage-per-Primitive Pragmatist

## Status: Complete

> Team B of 3. Design philosophy: attach each Workflow primitive to the Canon mechanism
> where it pays off most, WITHOUT restructuring Canon's core protocol. Portfolio of
> independently shippable features, each visibly better within weeks.

---

## 1. Vision

A Canon build a quarter from now looks almost exactly like a Canon build today — same PM
triage, same architect, same runbook vocabulary, same HITL gates, same journal, same
worktree lifecycle — except that **every place Canon currently does expensive, fragile,
or under-powered multi-agent choreography by hand, a named, versioned, hand-written
workflow from Canon's shipped library does it better**:

- The review step's minority-finding probe — today capped at top-5, sequentially probed
  by re-spawned reviewers — becomes an **adversarial verification pipeline** where *every*
  finding gets N independent refuters, schema-validated, in one background run.
- The design competition this very proposal was produced by — three teams, manually
  spawned, manually collected, manually judged by the orchestrator — becomes a one-call
  **judge-panel workflow** with parallel scoring judges and synthesis.
- `/canon:check`-style violation sweeps and learner mining — today single-agent,
  known-under-detecting (watch_WWWWWW1) — become **loop-until-dry multi-modal sweeps**
  that keep spawning finder rounds until coverage converges, with adversarial
  false-positive kills.
- The orchestrator's most fragile habit — **regex-scanning agent prose** for
  `DONE`/`BLOCKED`, parsing REVIEW.md verdicts, eyeballing coverage tables — is replaced
  inside workflow regions by `schema`-validated structured outputs with tool-layer
  retry-on-mismatch. The status signal becomes data.
- The mandatory tail (context-sync → ship → learn) — Canon's strongest standing rules,
  today behaviorally enforced — runs as a fixed saved workflow with skip predicates as
  data.
- Long fan-out phases run **in the background** with `/workflows` live progress,
  collapsing dozens of orchestrator messages into one invocation + one notification —
  directly relieving the ~100-message cache_control TTL failure mode that motivated
  Silent Dispatch.

There is **no transpiler, no IR, no compilation step, no new engine**. The library is
~8 hand-written, code-reviewed, plain-JS scripts in the plugin's `workflows/` directory
(installed to `.claude/workflows/`), each parameterized by a standard `args` envelope the
orchestrator freezes at invocation time. Every script is small enough to review like any
other PR. Every feature ships independently; killing any one of them leaves the others
standing. The orchestrator remains the control plane; gates remain exactly where the HITL
catalog puts them; workflows occupy only the gate-free regions between them — which is
the only shape the tool permits anyway.

The bet: **breadth of compounding quality wins** — each pattern (adversarial verify,
judge panel, loop-until-dry, multi-modal sweep, completeness critic) is a strict quality
upgrade over Canon's current hand-rolled equivalent, and the schema primitive quietly
fixes Canon's last stringly-typed boundary as a side effect.

---

## ASSUMPTIONS

- A1/A2 from the capability review (hooks fire for workflow-spawned subagents;
  frontmatter allowlists honored for `agentType: 'canon:*'`) are **probed in Increment 0
  before anything depends on them** (§4.7). Features are sequenced so the first three
  increments are safe even if A1 is false (no code-writing agents in workflows until the
  probe passes).
- A3 (workflow agents have Bash/git) is relied on for the tail, merge-agent, and
  migration features.
- A4 (`meta.phases` model field is display-only) — model routing is per-`agent()`
  `opts.model`.
- Saved workflows under `.claude/workflows/` are loadable by `name` with `args` exactly
  as the spec describes; the plugin install path can place files there (verified in
  Increment 0 alongside A1/A2).

---

## 2. Feature inventory

Ranked by leverage-per-effort. "Replaces/strengthens" names the Canon surface-map
mechanism (S-numbers from the capability review).

| # | Feature | What it does | Workflow primitives | Canon mechanism affected | Effort | Leverage |
|---|---------|--------------|---------------------|--------------------------|--------|----------|
| F1 | **Structured-output schema library** | JSON Schemas for agent status, review findings, verdicts, coverage tables, task results; used as `opts.schema` in all workflows AND as the contract for a typed `report_status` path orchestrator-side | `agent(…, {schema})` | S17 agent contracts, S6 consolidation, S12 verdict routing — kills the regex-scan-prose boundary | S | **Very high** |
| F2 | **`canon-review-verify`** — adversarial finding verification | Per-dimension reviewer fan-out → justified-barrier dedup → N refuters per finding (majority-kill) → consolidator node writes REVIEW.md via `write_review` MCP | `pipeline`, `parallel` (justified barrier), `schema`, `phase`/`log`, `agentType:'canon:reviewer'` | S6 team review consolidation — replaces top-5-capped minority probes with 100% adversarial coverage | M | **Very high** |
| F3 | **`canon-sweep`** — loop-until-dry violation/drift sweep | Multi-modal finder rounds (by-principle, by-layer, by-churn, by-hotspot lenses) until K dry rounds; dedup vs ALL-SEEN; adversarial verify kills false positives; completeness critic seeds final round | loop-until-dry, multi-modal sweep, adversarial verify, completeness critic, `log` (no-silent-caps) | `/canon:check`, drift report quality, watch_WWWWWW1 sweep under-detection | M | **Very high** |
| F4 | **`canon-tail`** — mandatory tail as saved workflow | context-sync → ship → learn as fixed sequential `agent()` chain; skip predicates evaluated on data passed in `args` (diff file list, build type); scribe-commit verification as a checker node | sequential `agent()`, `agentType:'canon:scribe|shipper|learner'`, structured return | S3/S16 mandatory tail — deterministic backstop for `never_skip_learner`/`never_skip_canon_steps`; W4 of the Deterministic Spine, kept | S | High |
| F5 | **`canon-compete`** — judge-panel design competition | N independent attempts (lens-framed via args, varied by index), parallel judges score against rubric schema, synthesizer combines winner + grafts | judge panel, `parallel`, `schema`, `opts.label` | S3 `compete`/`debate` steps — replaces manual orchestrator-driven team rounds (this very session, done by hand) | M | High |
| F6 | **`canon-security-audit`** | Multi-modal sweep (taint, secrets, authz, dependency lenses) → perspective-diverse verify (correctness/exploitability/repro lenses, not N identical refuters) → completeness critic → consolidator writes report | multi-modal sweep, perspective-diverse verify, completeness critic | S3 `security` step — single security agent becomes a harness | M | High |
| F7 | **`canon-migrate`** — codebase-wide migration harness | Discover sites (multi-modal) → `pipeline(sites, transform, verify)` with engineer agents in agent-managed `canon-task/` worktrees (worker-prompt pattern, NOT `opts.isolation`) → merge-agent node runs the existing merge protocol → post-merge per-file diff verification node | `pipeline`, `agentType:'canon:engineer'`, merge-agent node, `log` | S5 DAG dispatch for the migration build class — stable substitute for the experimental agent-teams substrate whose wave tooling was deleted (PR #167) | L | High |
| F8 | **`canon-rereview`** — adversarial re-review of CLEAN verdicts | N skeptics prompted to REFUTE the CLEAN verdict (default-refuted-if-uncertain), majority semantics; replaces the supervised-tier single adversarial re-reviewer | adversarial verify, `schema` | S12 adversarial re-review gate (post-CLEAN, supervised) — strictly stronger skeptic pool | S | Med-High |
| F9 | **`canon-learn-mine`** — learner mining harness | Loop-until-dry pattern mining across recent builds/journals; judge panel scores proposals against promotion rubric before they enter `.canon/proposed-learnings/` | loop-until-dry, judge panel, `schema` | S16 learner loop — deeper mining, pre-scored proposals | M | Med |
| F10 | **Background fan-out + `/workflows` UX** | All library workflows run backgrounded; orchestrator gets one notification per region; user watches live progress in `/workflows`; per-agent skip becomes a new user verb in the HITL catalog | background execution, task notifications, `/workflows`, per-agent skip | S19 Silent Dispatch / TTL-bug relief; S12 gains "skip agent" + "TaskStop" user verbs | S (doc + protocol) | Med-High |
| F11 | **`canon-flaky-hunt`** + **`canon-diagnose`** — user-invocable diagnostics | Saved, named workflows users invoke directly (itself an opt-in channel): flaky-test finder (the spec's own canonical example) and a multi-modal repo health sweep backing `/canon:diagnose` | loop-until-count, multi-modal sweep, saved-workflow registry | `/canon:diagnose` command; standalone utility | S | Med |
| F12 | **Run-journal cross-referencing** | `log_step` outcome gains `workflow_run_id` + `node_log[]` (from each workflow's structured return); resume-from-runId becomes the first recovery option for killed workflow regions, ahead of re-spawn enrichment | journaled resume, structured return | S7 journal (coarse-grain mapping, no doctrine change), S8 cliff detection, S10 re-spawn enrichment (superseded within workflow regions) | S | Med |
| F13 | **Nightly maintenance workflows** (flagged, last) | `canon-sweep` + wiki-lint remediation on CronCreate schedule; degrades gracefully when interactively-authed MCP absent (constraint 11) | CronCreate + saved workflows | Janitor/maintenance adjacency | S | Low-Med |

Not in the portfolio (deliberately): runbook→IR transpiler, whole-build compilation,
generated per-build scripts. See §6.

---

## 3. Architecture

### 3.1 Who authors, who invokes

- **Authorship is static and human.** All workflows are hand-written plain-JS files in
  the Canon plugin repo at `workflows/*.workflow.js`, code-reviewed like any source file,
  with a CI parse/lint gate (`node --check` + a meta-literal lint + a banned-API lint for
  `Date.now`/`Math.random`/`new Date()`/TS syntax). Plugin install copies them to
  `.claude/workflows/` so they are invocable by `name`.
- **Invocation is orchestrator-only**, at runbook-step granularity: when an approved
  runbook step is backed by a library workflow, the orchestrator calls
  `Workflow({ name: 'canon-review-verify', args: <envelope> })` instead of spawning the
  step's agents by hand. The runbook gains one additive field (vocabulary minor bump):
  `engine: workflow:<name>` on steps where the architect selects it. Steps without the
  field execute exactly as today — **the entire portfolio is opt-out by omission**.
- **The LLM never writes workflow code at build time.** Per-build variation flows through
  `args` (data), never through script text. This dissolves generated-code trust and
  maximizes resume prefix reuse (same script + same args → 100% cache hit).

### 3.2 The standard `args` envelope (HC-5 enforcement point)

Every library workflow takes one envelope, frozen by the orchestrator at invocation
(hybrid scouting: scout inline, freeze, invoke):

```json
{
  "canon": {
    "workspace": "...", "worktree_path": "...", "slug": "...",
    "base_commit": "abc123", "invoked_at": "2026-06-07T18:00:00Z",
    "tier": "light-touch", "turn_budget": 30
  },
  "preloads": { "reviewer": "<resolve_agent_skills preload verbatim>", "...": "..." },
  "context": { "changed_files": ["..."], "principles_digest": "..." },
  "params": { "refuters_per_finding": 3, "max_rounds": 5, "dry_rounds_to_converge": 2 }
}
```

Everything time- or state-dependent enters here (timestamps, git state, preloads,
`get_context` snapshots). Where freshness matters mid-run (e.g., live `git diff` inside
`canon-migrate`), a **scout `agent()` node** fetches it — deterministic on replay because
the scout's cached result reproduces downstream prompts exactly.

### 3.3 Node contract: agents do everything the sandbox can't

The script is pure choreography. Every effect lives in an agent node:

- **Artifact writes**: each workflow ends with a **consolidator node** — an agent that
  calls the existing MCP write tools (`write_review`, `write_test_report`,
  `write_implementation_summary`) so artifacts-on-disk, renderers, `finalize_workspace`,
  and humans see exactly the same files as today. The script's structured `return` is for
  routing; the disk artifact is the record. (Workflow agents reach all session MCP tools
  via ToolSearch — capability confirmed by spec; doctrine unchanged because journal/db
  writes still go through harness tools only.)
- **Git operations**: merge-agent nodes (A3) execute the existing merge protocol verbatim
  (alphabetical `--no-ff`, post-merge per-file diff verification, abort→report on
  conflict).
- **Provenance**: code-writing nodes receive the commit-trailer block via `args`
  (Canon-Workflow/Agent/State/Task) — unchanged.

### 3.4 Null-policy per node class (constraint 6)

| Node class | On `null` (skip/terminal failure) |
|---|---|
| Finder / reviewer dimension | Drop + `log()` the dropped lens (no-silent-caps) |
| Refuter / judge | Abstain — finding keeps `verified: false`, surfaces at the gate; never silently counts as refuted or confirmed |
| Code-writer (migrate/fix) | Collected into `failures[]` in the structured return; orchestrator routes to the existing escalation cascade / retry protocol at the boundary |
| Consolidator | Workflow returns `{ status: 'consolidation_failed', partials: [...] }`; orchestrator consolidates inline (today's behavior) as fallback |

In-script retry ladder for transient nulls (count-based, since scripts have no clock):
retry once same-model → once with `opts.model: 'opus'` → `failures[]`. This carries
add_primer/escalate_model/narrow_scope semantics into code; `hitl` remains terminal and
orchestrator-side, exactly as the cascade defines.

### 3.5 State flow: two journals, one grain each

- **journal.json / orchestration.db remain authoritative at runbook-step grain.** One
  `log_step(started)` before each Workflow invocation, one `log_step(completed)` at
  notification, with `outcome: { workflow_run_id, node_log: [...] }` where `node_log` is
  the per-agent summary array from the workflow's structured return (label, agentType,
  model, status, key metrics). No agent self-logging; no doctrine change; no new write
  path into the db — which also keeps us clear of the known journal write-race until it's
  fixed.
- **The Workflow run journal (runId) is authoritative at intra-run grain** and is the
  recovery substrate: killed run → `{scriptPath, resumeFromRunId}` replays the cached
  prefix. `reconcile_workspace` keeps workspace-grain cliff detection for non-workflow
  steps; for workflow steps the cliff entry carries the runId so the surfaced HITL offers
  "resume run" as the first disposition. `capture_transcript`'s fallback maps to the
  spec's own `agent-<id>.jsonl` fallback.

### 3.6 HITL: gates between invocations, by construction

Each library workflow is, by design, **one gate-free region** of the HITL catalog. The
orchestrator conducts every gate exactly as today (AskUserQuestion + mandatory renderer
HTML), between invocations:

```
plan approval ──▶ [canon-migrate or implement step] ──▶ verify ──▶ [canon-review-verify]
      ▲                                                                  │ returns verdict object
      │                                                  review-verdict gate (mandatory, all tiers)
      │                                                                  │
      └── consent line lives here                          fix loop ◀────┘ (≤3, then HITL)
                                                                  │
                                                       [canon-rereview] ──▶ WARNING close-out
                                                                  │
                                                            [canon-tail]
```

The fix loop deliberately stays **orchestrator-driven across iterations** (each iteration
is a small workflow or plain spawn): the verdict gate sits inside the loop, so folding
the whole loop into one run would violate HC-2. New user verbs added to the HITL catalog:
**skip agent** (via `/workflows`; script sees `null`, null-policy applies) and **stop
run** (TaskStop; resume later). Tier mapping is untouched: supervised builds simply have
more, shorter regions; autonomous builds have longer ones. Nothing is compiled away —
plan approval and initial review verdict remain hard boundaries at every tier.

### 3.7 Worktrees (HC-1 enforcement point)

`opts.isolation: 'worktree'` is **banned in the library** (CI lint greps for it). Three
sanctioned shapes:

1. **Read-only fan-outs** (review, sweep, audit, judges): agents read the build worktree
   path from `args`; no isolation needed.
2. **Sequential code-writers** (tail scribe, fix nodes): share the single build worktree,
   exactly like today's live sequential path.
3. **Parallel code-writers** (`canon-migrate` only): worker-prompt pattern — each
   engineer creates its own `canon-task/{site_id}` worktree from `base_commit` via git
   (A3), then a **merge-agent node** executes the existing merge protocol into the build
   worktree. Canon owns the merge lifecycle end-to-end; the harness's auto-merge is never
   engaged.

### 3.8 Opt-in (HC-4 enforcement point)

Three sanctioned channels, stacked:

1. **Skill instruction** — the Canon skill explicitly instructs Workflow use for
   `engine: workflow:*` runbook steps (the spec lists "a skill instructs it" as a
   sanctioned channel).
2. **Plan approval as per-build consent** — the always-mandatory plan-approval gate
   presents workflow-backed steps with a `⚙ background workflow` marker and a standing
   sentence: *"Marked steps run as background workflows (live progress in /workflows);
   reply 'no workflows' or 'supervised mode' to run them as plain agent spawns."* Consent
   is therefore explicit, per-build, and revocable — and costs zero extra round-trips.
3. **Named invocation** — `canon-diagnose`/`canon-flaky-hunt` invoked by the user are
   opt-in by definition.

### 3.9 Budget (HC-6)

Per-node pacing stays prompt-level (`turn_budget` text via `args` — unchanged semantics).
Loop bounds are count-based `params` (max_rounds, dry_rounds, refuters_per_finding) —
never wall-clock (scripts have no clock). When the user gives a "+N" token directive, the
library scales fleet sizes with the spec's static-scaling idiom, always guarded with
`budget.total &&`.

### 3.10 Illustrative script — `workflows/canon-review-verify.workflow.js`

The core mechanism end-to-end (plain JS, pure-literal meta, schema outputs, justified
barrier, adversarial verify, no-silent-caps, consolidator node, structured return):

```js
export const meta = {
  name: 'canon-review-verify',
  description: 'Canon principle review: per-dimension reviewers, dedup, adversarial verification of every finding, consolidated REVIEW.md',
  whenToUse: 'Backing the runbook review step when the build diff warrants team review',
  phases: [
    { title: 'Review', detail: 'one reviewer per partition/dimension' },
    { title: 'Verify', detail: 'N adversarial refuters per finding' },
    { title: 'Consolidate', detail: 'write REVIEW.md via MCP' },
  ],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      file: { type: 'string' }, line: { type: 'number' },
      principle_id: { type: 'string' },
      severity: { enum: ['BLOCKING', 'WARNING', 'INFO'] },
      title: { type: 'string' }, evidence: { type: 'string' },
    }, required: ['file', 'principle_id', 'severity', 'title', 'evidence'] } },
    honored: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'honored'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason'],
}

const c = args.canon
const partitions = args.params.partitions // [{ id, files: [...], dimensions: '...' }]

// Phase 1+2 as a pipeline: a partition whose review is done proceeds to
// verification without waiting for slower partitions (no false barrier).
const results = await pipeline(
  partitions,
  (p) => agent(
    `${args.preloads.reviewer}\n\nWORKSPACE=${c.workspace}\n` +
    `Diff against ${c.base_commit}: git diff ${c.base_commit}..HEAD\n` +
    `Worktree: ${c.worktree_path}\nReview ONLY these files: ${p.files.join(', ')}\n` +
    `Focus dimensions: ${p.dimensions}\nturn_budget: ${c.turn_budget}\n` +
    `Return findings + honored principles as structured output.`,
    { agentType: 'canon:reviewer', schema: FINDINGS_SCHEMA,
      label: `review:${p.id}`, phase: 'Review' }
  ),
  (review, p) => {
    if (!review) { log(`partition ${p.id} reviewer failed — coverage gap surfaced at gate`); return null }
    return parallel(review.findings.map((f, i) => () =>
      parallel(Array.from({ length: args.params.refuters_per_finding }, (_, k) => () =>
        agent(
          `You are skeptic ${k + 1}. Adversarially try to REFUTE this review finding. ` +
          `Default to refuted=true if uncertain. Read the code yourself.\n` +
          `Worktree: ${c.worktree_path}\nFinding: ${JSON.stringify(f)}`,
          { schema: VERDICT_SCHEMA, label: `verify:${p.id}:${i}`, phase: 'Verify' }
        )
      )).then((votes) => {
        const cast = votes.filter(Boolean)
        if (cast.length === 0) return { ...f, verified: false, abstained: true } // null-policy: abstain, never silently kill
        const refuted = cast.filter((v) => v.refuted).length > cast.length / 2
        return refuted ? null : { ...f, verified: true, votes: cast.length }
      })
    )).then((fs) => ({ partition: p.id, honored: review.honored, findings: fs.filter(Boolean) }))
  }
)

const ok = results.filter(Boolean)
if (ok.length < partitions.length)
  log(`${partitions.length - ok.length} partition(s) dropped — listed in return for gate`)

// Justified barrier: consolidation needs cross-partition context (dedup by
// file+principle+line, worst-case verdict) — the spec's own justified case.
phase('Consolidate')
const consolidated = await agent(
  `Consolidate these verified review results into REVIEW.md for workspace ${c.workspace} ` +
  `using the write_review MCP tool (dedup by file+principle_id+line; verdict = worst ` +
  `severity present; include abstained findings under 'Unverified'). ` +
  `Results: ${JSON.stringify(ok)}`,
  { agentType: 'canon:reviewer', phase: 'Consolidate', label: 'consolidate',
    schema: { type: 'object', properties: {
      verdict: { enum: ['CLEAN', 'WARNING', 'BLOCKING'] },
      blocking: { type: 'number' }, warning: { type: 'number' },
      review_path: { type: 'string' } },
      required: ['verdict', 'blocking', 'warning', 'review_path'] } }
)

return {
  status: consolidated ? 'ok' : 'consolidation_failed',
  verdict: consolidated && consolidated.verdict,
  counts: consolidated && { blocking: consolidated.blocking, warning: consolidated.warning },
  dropped_partitions: partitions.length - ok.length,
  node_log: ok.map((r) => ({ partition: r.partition, findings: r.findings.length })),
}
```

The orchestrator reads `verdict` from the return (validated data, not parsed markdown),
spawns the renderer on the REVIEW.md the consolidator wrote, and conducts the mandatory
verdict gate — unchanged ceremony, radically stronger inputs.

---

## 4. Conflict resolutions

### 4.1 HC-1 — `isolation:'worktree'` auto-merge vs Canon-owned worktrees

Resolved by **never engaging the flag** (CI lint bans it in `workflows/`) and using the
three sanctioned shapes in §3.7. Parallel code-writing exists only in `canon-migrate`,
which reuses the already-documented worker-prompt pattern (agent-created
`canon-task/{id}` worktrees from `base_commit`) plus a merge-agent node running the
existing merge protocol with post-merge per-file diff verification. Merge conflicts
abort and surface in `failures[]` → existing merge-conflict HITL at the boundary. Canon
owns every merge.

### 4.2 HC-2 — No mid-run HITL vs the gate catalog

Resolved by **scoping, not segmentation machinery**: each library workflow is authored
to fit inside one inter-gate region of the existing catalog. No gate is moved, removed,
or softened; mandatory gates (plan approval, initial review verdict) are physically
between invocations. The review-fix loop keeps its per-iteration verdict gate by staying
orchestrator-driven across iterations. Tier-dependence is handled naturally: supervised
builds invoke more, smaller workflows; autonomous builds may run longer regions (e.g.,
implement→verify as one region) — but that is an architect runbook decision per build,
not a compiler. `/workflows` skip and TaskStop are added to the HITL catalog as user
verbs with defined semantics (null-policy §3.4; resume §3.5).

### 4.3 HC-3 — Sandboxed script vs MCP/journal/filesystem

Resolved by the **node contract** (§3.3): scripts choreograph; agents effect. Artifacts
are written by consolidator nodes through the existing typed MCP write tools, so disk
state is bit-identical in shape to today. Journals: coarse-grain `log_step` per
invocation with `workflow_run_id` + `node_log` in `outcome` (§3.5) — journal.json and
orchestration.db remain harness-tool-managed only, per doctrine; the Workflow run
journal owns intra-run grain. No double bookkeeping: the two journals never record the
same grain.

### 4.4 HC-4 — Opt-in vs default-to-action

Three stacked sanctioned channels (§3.8): skill instruction (spec-sanctioned), plan
approval as explicit per-build consent (free — the gate is mandatory anyway, and
`meta.description` additionally appears in the harness permission dialog), and
user-named invocation for the diagnostic workflows. "Supervised mode"/"no workflows"
degrades every `engine: workflow:*` step to today's plain spawns — the portfolio is
opt-out by a single sentence.

### 4.5 HC-5 — Resume determinism vs live-state prompt composition

Resolved by the **frozen args envelope + scout nodes** (§3.2). The static-library
authorship choice is itself the strongest mitigation: script text never varies per
build, so resume prefix-matching depends only on args stability, and a mid-run resume
with unchanged args replays at 100% cache hit up to the failure point. Re-spawn
enrichment (S10) remains for non-workflow steps; within workflow regions, resume
supersedes it (F12) — the standing stream-idle resume-first rule stays
orchestrator-scope.

### 4.6 HC-6 — `budget` ownership/units vs turn budgets

Accepted as-is: token budget stays a user-directive affordance (guarded
`budget.total &&` scaling only); Canon's cost governance remains prompt-level
turn_budget + per-node `opts.model` + count-based loop bounds in `params`. The
escalation cascade's 2-minute wall-clock bound becomes a count bound in-script; the
orchestrator-side cascade tool is untouched for non-workflow steps.

### 4.7 A1/A2 unknowns — the Increment-0 probe

A single disposable probe workflow, run once in a scratch workspace, settles both
empirically (per the empirical-candidate-comparison discipline — measure, don't argue):

- **A1 (hooks)**: an `agentType: 'canon:engineer'` node attempts (1) an `Edit` to a
  tracked file with no active workspace env, expecting the L4 workspace-check block;
  (2) a destructive-guard-triggering Bash string, expecting a block. Record
  blocked/allowed for each.
- **A2 (allowlists)**: a `canon:scribe`-typed node attempts a tool outside its
  frontmatter allowlist; a `canon:reviewer`-typed node verifies its allowed MCP tools
  resolve via ToolSearch. Record honored/ignored.
- Also verifies: plugin-installed `.claude/workflows/` name resolution, `schema` +
  `agentType` composition, and structured-return readability.

Decision table: **A1 true** → full portfolio. **A1 false** → code-writing nodes
(F4 tail commit nodes, F7 migrate) are deferred or wrapped with explicit
prompt-level guards + post-hoc `completion-verify`-style checks; read-only features
(F1, F2, F3, F5, F6, F8, F9, F11) proceed regardless — they never needed L4. **A2
false** → `agentType` nodes get explicit tool-restriction prompt text and the probe
result is filed as a harness issue; schema validation still holds (it is tool-layer,
not allowlist-layer).

---

## 5. Migration path

Each increment independently valuable; no increment depends on a later one.

| # | Increment | Ships | Value if we stop here |
|---|---|---|---|
| 0 | **Probe** (§4.7) + CI lint for `workflows/` (parse, meta-literal, banned APIs, no `isolation:`) | probe report in `docs/` | A1/A2 settled for everyone; lint reusable |
| 1 | **F1 schema library** — `workflows/schemas/` JSON Schema modules for status/findings/verdicts/coverage; orchestrator-side: fold required `status` enum into the typed terminal-write tools | schemas + typed status | Kills the regex-scan-prose boundary even if no workflow ever runs (Tier-2 epic item, independently decided) |
| 2 | **F4 `canon-tail`** + F12 journal cross-ref | first live workflow on the lowest-risk, most-rigid region | Deterministic mandatory-tail backstop; validates `agentType` path, MCP-from-agent, A3 git access, notification-time journaling |
| 3 | **F2 `canon-review-verify`** + F10 background UX + HITL-catalog verbs | the flagship | 100% adversarial finding verification replaces top-5 probe cap; verdict as data; TTL relief on the chattiest phase |
| 4 | **F3 `canon-sweep`** (+ wire to `/canon:check`) and **F11 diagnostics** | sweeps | Fixes known sweep under-detection; user-invocable workflows open the named-invocation opt-in channel |
| 5 | **F8 `canon-rereview`**, **F5 `canon-compete`** | quality + competition | Supervised-tier re-review hardened; compete/debate steps get a deterministic backend |
| 6 | **F6 `canon-security-audit`**, **F9 `canon-learn-mine`** | harnesses | Security and learner steps become multi-stage harnesses |
| 7 | **F7 `canon-migrate`** (gated on Probe A1-true + Increment 2 merge-agent validation) | parallel code-writing | First stable parallel implement substrate since PR #167 deleted the wave tooling — without the experimental agent-teams dependency |
| 8 | **F13 scheduled maintenance** (optional) | cron sweeps | Background hygiene |

Rollback story per increment: delete the `engine: workflow:<name>` mapping → Canon
behaves exactly as today. No state migration, no schema migration, no protocol version
bump beyond one additive runbook field (vocabulary 1.2, minor).

---

## 6. Risks & rejected alternatives

### Rejected alternatives

- **Runbook→IR transpiler / compiled whole-build workflows** (the Deterministic Spine
  W-ladder beyond W4). Rejected *for this horizon*, extended where cheap: we keep W4
  (as F4) and X4 Stop-hook (orthogonal, still recommended). Reasons: (1) the transpiler
  is a Large bet whose payoff concentrates in the autonomous tier, which has the least
  usage today; (2) every quality pattern in this portfolio is reachable with zero
  compiler risk; (3) the static-library + args-envelope shape is itself the "validated
  data, not generated source" insight the epic wanted — we get the trust property
  without building the compiler. The portfolio is a strict superset of the transpiler's
  *near-term* value and leaves the transpiler open as a later consumer of the same
  library (compiled plans could invoke library workflows via `workflow()` — one nesting
  level is exactly enough for runner→library).
- **Per-build LLM-generated scripts.** Rejected: generated-code trust burden, resume
  cache thrash (every build a new script), review burden at plan approval. Args-as-data
  achieves per-build variation.
- **Agents self-logging `log_step` from inside workflows.** Rejected: contradicts the
  harness-managed-journal doctrine and walks into the known journal write-race.
  Coarse-grain mapping (§3.5) gets full fidelity without either.
- **Replacing agent teams everywhere.** Rejected: `compete`/`debate` *orchestrator-led
  rounds with convergence detection* need mid-round adaptivity; teams stay. We replace
  only the fan-out shapes that are deterministic choreography.
- **In-workflow HITL emulation** (polling gate-files, early-return micro-segments).
  Rejected: no primitive exists; micro-segmentation would shred resume caches and
  reintroduce orchestrator chatter — the catalog's gates stay where they are.

### Sharpest rival criticisms, answered

1. *"A grab-bag, not an architecture."* The architecture is thin but real and singular:
   one args envelope, one schema library, one node contract, one journal mapping, one
   null-policy table — every feature is the same five decisions reapplied. Thinness is
   the point: nothing here can fail in a way that takes Canon down with it.
2. *"Saved workflows will drift from the evolving protocol."* They are repo files,
   code-reviewed, CI-linted, and exercised on every build that opts in; the scripts are
   deliberately thin (choreography only) while judgment lives in agent prompts/preloads
   that flow through `args` and update without touching script text — which also
   protects resume caches.
3. *"Resume is same-session only — you oversold recovery."* F12 treats resume as the
   *first* option, not the only one: cliff surfacing, transcript harvest, and re-spawn
   enrichment all remain. Within-session kills (the common case: TaskStop at a gate,
   user edits params, resume) are where the prefix cache pays.
4. *"Adversarial verification triples review cost."* Refuter count is a `params` knob
   per tier (1 refuter at autonomous spot-check scale, 3–5 for "thoroughly audit" —
   the spec's own scale-to-the-ask guidance), runs on the session model by default, and
   replaces the current *re-spawned sequential* probe agents — measured wall-clock
   should drop while coverage goes from top-5 to 100%. Increment 3 ships with a
   before/after probe table (cost, wall-clock, findings survived) per the
   empirical-comparison discipline.
5. *"You didn't fix supervised-tier chattiness."* Correct and deliberate: supervised
   tier's gate density is a user-chosen property, not a defect. We shrink message count
   per region (F10) without touching gate count.

### Residual risks

- **A1-false world** degrades F4/F7 (mitigations in §4.7); the read-only majority of the
  portfolio is unaffected.
- **Harness evolution risk**: the Workflow tool is new; the library couples to its
  surface. Mitigated by thin scripts and by the opt-out-by-omission runbook field.
- **Schema rigidity**: over-strict schemas cause retry loops. Mitigated by starting
  permissive (required core fields only) and tightening with observed data.

---

## 7. Killer demo

**Build: "Migrate all 14 hook scripts to source `hooks/lib/canon-hook-lib.sh` helpers
and remove their inlined JSON-extraction copies"** — a real Canon backlog-shaped,
codebase-wide migration touching `hooks/*.sh` with a shared-library dependency, the
exact class the deleted wave tooling used to serve.

1. **PM triage** → non-trivial → architect. Architect's runbook marks three steps
   `engine: workflow:*`: discovery (`canon-sweep` in discovery mode), implement
   (`canon-migrate`), review (`canon-review-verify`). Plan-approval HITL renders
   design.html and carries the consent line: *"3 steps run as background workflows —
   watch /workflows; reply 'no workflows' to disable."* User approves. **Opt-in
   satisfied; gate unchanged.**
2. **Discovery** — orchestrator freezes the envelope (base_commit, worktree path,
   hook-lib function inventory scouted inline) and invokes `canon-sweep`. Four lenses
   fan out (by-file, by-helper-function, by-call-pattern, by-test-coverage); rounds
   continue until 2 dry rounds; a completeness critic asks "which hooks did every lens
   miss?" and finds `session-start` suite edge cases. Return: 14 sites + 3 shared-risk
   notes, schema-validated. One orchestrator message total. `/workflows` showed ~20
   agents live.
3. **Implement** — `canon-migrate` pipelines the 14 sites: each engineer node creates
   `canon-task/hook-{name}` from base_commit (worker-prompt pattern), migrates one
   script, runs `bash hooks/tests/...` for it, commits with provenance trailers.
   Pipeline means site 12 is transforming while site 3 is already verifying — no
   barrier. Two nodes return null (one transient API death). In-script ladder retries
   one successfully on opus; the other lands in `failures[]`. The merge-agent node
   merges 13 branches alphabetically `--no-ff`, runs per-file diff verification, returns
   merge report. **Mid-merge, the user TaskStops to leave for lunch** — on return,
   `resumeFromRunId` replays the 13 cached transform results instantly and continues at
   the merge node. Orchestrator logs one journal step with runId + 14-entry node_log,
   then surfaces the single failure through the existing retry/escalation protocol —
   one plain engineer spawn fixes it.
4. **Verify** — unchanged inline gates (build/lint/test/hooks-lint).
5. **Review** — `canon-review-verify` partitions by directory, reviews, dedups at the
   justified barrier, and sends **all 9 findings** (not top-5) through 3 refuters each:
   5 survive verified, 3 are majority-refuted (two were the classic
   quoted-string-vs-token false positives that destructive-guard reviews keep
   producing), 1 abstains (a refuter was skipped by the user from /workflows) and
   surfaces as Unverified. Consolidator writes REVIEW.md via `write_review`; renderer
   builds review.html; **mandatory verdict gate** presents WARNING with verified-only
   counts. One fix iteration (orchestrator-driven, gate honored), then `canon-rereview`
   sends 3 skeptics at the CLEAN — it holds.
6. **Tail** — `canon-tail`: scribe syncs hooks CLAUDE.md (commit verified by checker
   node), shipper opens the PR, learner mines — and proposes promoting the
   "quoted-string false positive" pattern it saw refuted twice, pre-scored by the F9
   judge rubric. `finalize_workspace` finds every step, every artifact, every trailer —
   bit-identical record shape to a hand-driven build.

Total orchestrator messages across the whole build: roughly a dozen — triage, two gate
ceremonies, one failure surfacing, completion. Today the same build would be 60+
messages, top-5-capped review verification, no mid-merge resume, and a regex hunting
for the word DONE.

---

## SUMMARY

### Status
DONE

### Artifact
`${WORKSPACE}/plans/fresh-architect-review-of-claude-code-workflow-tool/PROPOSAL-B.md`

### Headline
A portfolio of 13 independently shippable features built on a hand-written, CI-linted,
args-parameterized saved-workflow library (`.claude/workflows/`), unified by five thin
contracts (args envelope, schema library, node contract, coarse-grain journal mapping,
null-policy table). No transpiler, no protocol restructure; all 6 hard conflicts
resolved within existing Canon doctrine; A1/A2 settled by an Increment-0 probe that
gates only the code-writing features.
