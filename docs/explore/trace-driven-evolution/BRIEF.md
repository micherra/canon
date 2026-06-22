# Trace-Driven Evolution for the Canon Learner — Exploration Design Brief

## Status: Complete (exploration) — v2, all 4 decisions resolved

> Decision-quality exploration brief. Not a buildable runbook. No code, no worktree.
> Origin: adaptation of NousResearch `hermes-agent-self-evolution` (DSPy + GEPA) to Canon's
> actual subsystems. Every "Canon does X today" claim cites a verified file path.
>
> **v2 re-architecture (all open decisions now locked):** engine = Canon-native loop; eval data =
> mine-then-curate; cadence = offline batch on the `loops/` framework; **Phase-1 target =
> trace-led / no-fixed-target** (evolve whatever artifact class the diagnosed failure points at —
> rule, agent definition, primer, tool description). Decision #4 is the consequential one: it
> **inverts v1's risk framing.** v1 confined Phase 1 to agent rules *specifically because* the
> artifact-attribution gap made higher-blast-radius targets unsafe. Trace-led targeting means that
> gap can no longer be deferred — closing it becomes **Phase 1's foundational deliverable (step 0)**.
> You cannot "evolve whatever the failure points at" until traces record *which artifact wording was
> in the agent's context at the moment of failure*, across all artifact classes. The brief below is
> re-sequenced around that inversion.

---

## 1. Problem / Gap

Canon already has a closed feedback loop — but it is an **open-loop** loop in control-theory
terms: it observes, it proposes, but it never *tests the proposed change against a frozen
benchmark before accepting it.*

What exists today, concretely:

- The **learner** (`agents/learner.md`) mines four trace surfaces — review history, build
  execution data, codebase patterns, task conventions — and emits structured suggestions. Its
  promotion logic is threshold-based: a pattern becomes a convention proposal once it reaches a
  **weighted instance count ≥ 3** across builds (`references/learner-dimensions.md` §convention-lifecycle
  Sub-analysis A, lines 121–123), where the weight is `computeOutcomeWeight(OutcomeSignals)`
  summed across instances (`mcp-server/src/features/history/services/judge-weight.ts`).
- Accepted proposals flow through `content-flow/learn-apply` → **writer** edits the artifact →
  **reviewer** checks compliance → **HITL** approval (`references/content-flow.md` lines 20,
  94–100). Content lands directly — the content flow omits the ship step (no PR; direct landing).
  Human HITL approval is mandatory.
- The watch→convention lifecycle decays/reinforces/archives stale proposals via the CONSOLIDATE
  pass (`references/learner-dimensions.md` Sub-analysis D, `consolidate-policy.ts`).

**What is missing — precisely:** the learner proposes an artifact change based on the
*frequency and outcome-weight of a pattern in past traces*, but it **never instantiates the
candidate artifact and runs it against a held-out task suite to confirm the change is actually
an improvement and does not regress existing behavior.** Promotion is justified by "this pattern
recurred 3+ times with good outcomes," not by "the rewritten rule scores higher on a frozen eval
set and regresses nothing." There is no candidate-vs-baseline bake-off, no regression gate, and
no before/after score attached to the PR.

The Hermes insight Canon lacks is **trace-driven reflection with a benchmark hard-gate**:
diagnose *why* a run failed from its execution trace, mutate the artifact toward a fix, then
*prove the mutation is non-regressive* against a frozen suite before it is allowed near a human.
Canon has the traces. Canon has a benchmark-shaped suite. The two have never been wired into a
generate→score→reject-on-regression loop.

This brief proposes wiring them.

---

## 2. Prior Art — Hermes self-evolution (DSPy + GEPA)

Brief, for context — adapted, not copied.

- **GEPA** (reflective prompt evolution, in DSPy) reads *execution traces* to diagnose the cause
  of a failure (not merely that it failed), then mutates the target artifact toward a fix. Works
  with as few as 3 examples — relevant to Canon's chronically low-N regime.
- **Loop:** read target artifact → generate eval dataset → optimize (mutate) → run candidates →
  score against traces → constraint gates → best variant → PR (human merge). One git branch per
  run: `evolve/<target>-<timestamp>`.
- **Eval dataset sources:** (1) **synthetic** — strong model reads the artifact and generates
  15–30 `(input, expected_behavior)` pairs, split 10 train / 5 val / 5–10 holdout,
  **rubric-scored, not exact-match**; (2) **mined** from real session history (`(task, response)`
  → LLM-as-judge → good vs failure cases); (3) **hand-curated golden JSONL**.
- **Layered gates, cheap→expensive, fail-fast:** unit tests 100% → fast benchmark subset → full
  benchmark (≤2% regression allowed) → multi-turn coherence check → PR with before/after
  train/val/holdout scores.
- **The load-bearing design choice:** benchmarks are **hard gates, not fitness terms.** A variant
  that improves the behavioral score but regresses the benchmark is *rejected*, not averaged into
  a blended score.
- **Size budgets are first-class fitness penalties** — verbose artifacts get skipped by the model,
  so length caps are baked into the fitness function.
- **Improvement targets, phased by risk:** skill/instruction files first → tool descriptions →
  system-prompt sections → implementation code (highest risk, deferred last).

---

## 3. Canon Subsystem Mapping

### 3.1 Trace source — the `trajectory.py` equivalent

Canon already captures a rich per-build trace. There is **no single `trajectory` object**, but
the union of these surfaces is the equivalent — and is **sufficient to diagnose *why*, not just
*that*, a build went wrong**:

| Hermes trace need | Canon source (verified) |
|---|---|
| Structured per-run record | `RunSummary` (`mcp-server/src/features/history/history-types.ts`): `planner_context`, `step_outcomes[]`, `review_results[]`, `artifact_inventory`, durations |
| Per-violation detail (the "why") | `ReviewViolation { principle_id, severity, file_path, message }` inside `review_results[].violations` |
| Cross-run aggregation | `CrossRunAnalysisResult` (`get_cross_run_analysis`): `recurring_violations[]` (with `weighted_instance_count`), `fix_cycle_patterns[]`, `agent_performance_trends[]`, `cliff_events`, `craft_drift` |
| Raw agent reasoning trace | `capture_transcript` / `get_transcript` (`mcp-server/src/features/orchestration/tools/`) — full Claude Code agent JSONL, transformed |
| Drift / compliance signal | `get_drift_report` → `pr_reviews[]`, verdicts, honored vs violated principles |
| Build outcome history | `get_build_history` → archived `RunSummary` manifest |

**Diagnosis capability check:** the failure-localization Hermes does from traces is achievable
here. `review_results[].violations[]` already pins *which principle* failed on *which file* with a
*message*; `fix_cycle_patterns` tells you *how many rework cycles* a violation class costs; the
transcript gives the agent's actual reasoning at the point of failure. A reflection step can read
`(target artifact) × (the violations attributed to that artifact's domain) × (the transcript
excerpt where the agent applied or ignored it)` and form a causal hypothesis.

**Capture gap — now Phase 1's foundational deliverable (step 0).** Canon's trace is
*outcome-attributed*, not *artifact-attributed*. A `ReviewViolation` records `principle_id` (which
principle was violated), but Canon does **not** record which agent-rule wording, which agent-definition
section, or which primer paragraph was *in the agent's spawn context* when it produced the violation.
There is no "this artifact's phrasing was assembled into the prompt and the agent still got it wrong"
link. In v1, with Phase 1 confined to agent rules, this was a deferrable gap (a rule maps 1:1 to an
agent, so the link could be *inferred*). **Decision #4 (trace-led, no fixed target) removes that
escape hatch:** to evolve *whatever artifact class the failure points at*, reflection must read the
attribution from the trace, not infer it — inference does not scale across rules, agent defs, primers,
references, and tool descriptions simultaneously. So provenance instrumentation is no longer "nice
before moving up the ladder"; it is the **prerequisite that gates the entire trace-led loop.**

#### Provenance instrumentation design (Phase 1, step 0)

**What gets recorded — a `ContextProvenanceRecord` per agent spawn:**

```
ContextProvenanceRecord {
  workspace, step_id, agent_type, agent_name,        // identity at emit time (agent_id not yet available)
  agent_id?,                                         // back-filled by log_step after spawn (see timing note)
  spawned_at,
  assembled_artifacts: [                              // every artifact assembled into the spawn prompt
    { kind: "rule"|"ref"|"primer"|"template"|"agent-def"|"tool-desc",
      id, path,
      content_hash,                                   // sha256 of the exact wording in-context
      section_anchors?: [<heading or line-range>],    // sub-artifact granularity where available
      char_span: [start, end] }                       // location within the assembled preload_prompt
  ],
  preload_prompt_hash                                 // hash of the full assembled context
}
```

**Progressive disclosure and span validity.** `resolveAgentSkills` passes its result through
`applyAgentSkillsDisclosure` (`resolve-agent-skills-disclosure.ts`, lines 37–73) before returning.
When `preload_prompt` exceeds the 12k-char threshold, disclosure fires: skill `content` fields are
blanked, and `preload_prompt` is replaced with a slim summary plus a file-pointer line such as
`"Full preload content at: .canon/artifacts/agent-skills-<hash>.json"`. In that scenario `char_span`
values computed during `formatPreloadPrompt` composition point into text that is **not** in the
actual spawn prompt — the exact wording lives only in the sidecar file the agent reads later.

The design must therefore enforce two rules:

1. **Record spans post-disclosure.** The `context_provenance` event must be appended *after*
   `applyAgentSkillsDisclosure` returns, not during composition. The `char_span` for each artifact
   is computed against the **final `preload_prompt`** string that is actually placed in the spawn
   prompt. For artifacts whose `content` was blanked by disclosure, `char_span` should be `null`
   (the text is absent from the spawn prompt).

2. **Model sidecar provenance explicitly.** When `full_data_path` is set on the returned result,
   each `assembled_artifacts` entry that was blanked must carry `source: "sidecar"` and
   `sidecar_path: full_data_path` rather than a `char_span`. At attribution time the learner treats
   a sidecar-sourced artifact as "present but deferred" — it was available to the agent as a
   readable file, not as inline text, and the transcript join must account for this: the agent's
   Read-tool calls (if any) of the sidecar path are the evidence of engagement, not a text span.

This is a Phase 1 implementation constraint, not a schema change: the `ContextProvenanceRecord`
fields shown above already accommodate `char_span: null` and can carry `source` and `sidecar_path`
as optional extensions per artifact entry.

**Where it's captured — a two-step protocol keyed by `step_id`.**

`resolveAgentSkills` is called *before* the Agent tool is invoked, so `agent_id` — which the Agent
tool returns after spawn — is not yet available. The design therefore splits the emit into two steps:

1. **`resolveAgentSkills` emits a provisional `context_provenance` record** keyed by
   `(workspace, step_id, agent_name)` but with `agent_id: null`. It receives `step_id` via the
   existing optional `options` parameter (the same path already used for `workspace` and
   `filePaths`). The provisional record carries the full `assembled_artifacts` array, hashes, and
   spans — everything that is knowable before spawn. The `step_id` is the durable join key for
   the back-fill step below.

2. **`log_step` back-fills `agent_id`** when the orchestrator calls it post-spawn with
   `status: "completed"` and `agent_id`. `log_step` already receives `agent_id` from the Agent
   tool result (this is the existing journal protocol, CLAUDE.md §Journal Protocol). The back-fill
   is a single UPDATE-by-`step_id` on the `context_provenance` event row — since events are keyed
   on `(workspace, type, correlationId)` where `correlationId = step_id`, the back-fill can use
   `appendEvent("context_provenance_agent_id", { step_id, agent_id })` or an explicit update path
   on the execution store. The learner joins on `step_id` first; it never needs `agent_id` to
   locate the provenance record, only to correlate with transcript data.

`resolveAgentSkills` is otherwise already 90% of the way there
(`mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts`). That function *already*:
- resolves each `rules:`/`references:`/`primers:`/`templates:` frontmatter entry to a concrete
  `ResolvedSkill { id, kind, path, content }` (lines 61–68, `resolveSkills` L233–251);
- assembles them into the single `preload_prompt` string via `formatPreloadPrompt` (L126–136); and
- **already writes audit events to the execution store** — `pitfall_injected` and
  `area_enrichment_injected` via `store.appendEvent(...)` (L142–156, L177–189).

The instrumentation is therefore *additive, not invasive*: compute `content_hash` per `ResolvedSkill`,
then — *after* `applyAgentSkillsDisclosure` returns — compute each section's `char_span` against the
**final** `preload_prompt` and append one `context_provenance` event (see Progressive disclosure rule
above: spans must target the text that actually enters the spawn prompt, not the pre-disclosure draft).
The new input needed: `step_id` added to `ResolveAgentSkillsOptions` (the optional `options` struct
that already carries `workspace` and `filePaths`); no change to the existing required inputs.

The two enrichment classes the agent does NOT get from
`resolveAgentSkills` — the **agent definition body** itself and **MCP tool descriptions** — are
assembled by the orchestrator's spawn-prompt construction and by the MCP `register-*.ts` tool
registration respectively; covering them is exactly what the §5 attribution-coverage ladder rolls out
incrementally (rules/refs/primers/templates land in Phase 1 because `resolveAgentSkills` already sees
them; agent-def and tool-desc coverage follow).

**Where it's stored — extend the existing event store, do not invent a parallel store.** The execution
store already exposes `appendEvent(type, payload, correlationId?)` and
`getEventsByType(type)` (`mcp-server/src/domains/workspaces/execution-store.ts` L267–288). A
`context_provenance` event type fits the existing pattern, is queryable by the learner at batch time,
and is captured into the per-build archive alongside `RunSummary`. For cross-build durability the
record should also be summarized into the `RunSummary` (a new `context_provenance` array) so
`get_build_history` / `get_cross_run_analysis` can join provenance to violations across runs — that is
the surface the offline-batch learner reads.

**How reflection consumes it — the attribution join.** At batch time the learner joins on `step_id`
as the primary durable key — it is present in the provisional provenance record at emit time and in the
journal entry at completion time. After `log_step` back-fills `agent_id`, the full triple
`(workspace, step_id, agent_id)` is available for the transcript join (transcripts are keyed by
`agent_id` in the transcript store):
`ReviewViolation (principle_id, file, message)` ⋈ `ContextProvenanceRecord (assembled_artifacts[])` ⋈
`transcript (the agent's reasoning at the failure point)`. The join answers the question v1 could only
infer: *"when this violation occurred, artifact X (hash H, section S) was in context — and the
transcript shows the agent either ignored S or applied it wrongly."* That tuple — `(violation, exact
artifact wording in-context, agent reasoning)` — is the diagnosed cause, and it points directly at the
**specific artifact + section** to mutate, regardless of artifact class. This is what makes targeting
*trace-led* rather than *fixed*.

**Honesty on residual inference.** Provenance proves *presence in context* (the wording was there), not
*causation* (the wording caused the failure). The transcript narrows causation but does not prove it;
the **eval hard-gate (§7) is what converts a causal *hypothesis* into a *validated* change** — a
mutation must strictly improve the holdout to be accepted, no matter how confident the attribution.
Attribution + transcript propose; the gate disposes. This is the safety chain that makes trace-led
targeting tractable without perfect causal traces.

> **External corroboration (2026-06-22):** The agentic-RL literature independently validates that
> credit-assignment/provenance plumbing — not the mutation/evolution engine — is the load-bearing
> component. Cameron Wolfe's survey "Agentic RL: Frameworks and Best Practices"
> (https://cameronrwolfe.substack.com/p/agentic-rl) describes "step-level trajectory representation +
> action masking" as the mechanism by which a training system knows *which tokens the agent produced*
> versus *which the environment injected* — the direct analogue of recording which artifact wording
> (hash + span) was assembled into each agent's spawn prompt so a failure can be attributed to the
> specific section in context. The survey's central thesis — that trajectory-handling and
> infrastructure choices dominate the optimizer choice — is a second, independent argument for funding
> the provenance plumbing (Phase-1 step 0) before the mutation engine.

### 3.2 Fitness gate — the held-out benchmark

The analogue to Hermes's TBLite already exists: **`skills/canon/evals/`**.

- **`eval-set.json`** — 15 cases today (verified `jq '.evals | length'` → 15), two `type`s:
  `trigger` (did the skill activate?) and `quality` (did it classify intent / flag the right
  principle / produce the right verdict?). Cases carry `prompt`, `expected_output` (a
  natural-language rubric), and optional `files[]` fixtures.
- **`run-evals.sh`** — already a working **rubric-scored, LLM-as-judge harness**: it runs each
  case via `claude -p`, truncates output, and a **haiku judge** returns PASS/FAIL against the
  `expected_output` rubric (lines 176–259). It is **not exact-match** — exactly the property
  Hermes requires. It supports `--filter` (subset runs), `--parallel`, and `--structured-judge`
  (JSON verdicts). Exit code is non-zero if any case fails (line 360) — i.e. it already behaves
  like a gate.

**What's missing to make it a regression gate:**

1. **A frozen baseline score.** The harness runs and reports pass/fail counts, but nothing
   captures "baseline = N/15 passing on `main`" to diff a candidate against. There is no
   `baseline.json` artifact.
2. **A candidate-injection mechanism.** Today the harness exercises the *installed* Canon. To
   score a *candidate artifact* (a mutated rule), the harness must run with the candidate file
   swapped in — i.e. run inside the `evolve/<target>` worktree, not against the live plugin.
3. **A regression-tolerance threshold.** Hermes allows ≤2% benchmark regression. Canon's posture
   is stricter (see §7): the eval gate should be **zero-regression on the holdout split** for
   rule/principle targets. There is no policy encoded today.
4. **Train/val/holdout splits.** The 15 cases are one undifferentiated set. Evolution needs a
   split so mutation cannot overfit to cases it can see. The existing `type`/`id` structure
   supports adding a `split: "train"|"val"|"holdout"` field per case without schema disruption.
5. **Behavioral signal separate from the gate.** The eval suite measures *correctness*. The
   *behavioral improvement* a candidate claims (e.g. "fewer false-positive review findings") needs
   its own metric drawn from `cross-run-analysis`. The gate and the fitness signal must stay
   distinct (see §7) — `run-evals.sh` is the gate; cross-run deltas are the fitness signal.

The harness is ~80% of a regression gate already. The missing 20% is baseline-freezing, candidate
injection, splits, and a regression policy.

### 3.3 Evolution targets — Canon's artifact classes (attribution-coverage order, not target restriction)

Under trace-led targeting (Decision #4) there is **no fixed target class** — the diagnosed failure
chooses the target. What *is* phased is **attribution coverage**: which classes the provenance
instrumentation (§3.1) can record and which the eval suite can score. The table below is therefore the
order in which a class becomes *evolvable* (provenance + gate available), not a restriction on what may
be targeted within a phase.

| Class | Path | Blast radius | Provenance source | Eval-suite verifiability |
|---|---|---|---|---|
| Agent rules | `rules/<name>.md` | Low — one agent's prompt | `resolveAgentSkills` (already resolves `rules:`) | Medium — only partially exercised |
| References / primers / templates | `references/<name>.md`, `primers/<name>.md`, `templates/*.md` | Medium — protocol/output fragments | `resolveAgentSkills` (already resolves all three) | Low — not directly evaluable |
| A single principle's wording | `principles/{rules,strong-opinions,conventions}/<name>.md` | Low-medium — matcher + reviewer | violation `principle_id` names it directly | **High** — `matching-*` / `review-verdict-*` cases exercise it |
| Agent definitions (behavior) | `agents/<name>.md` body | Medium-high — whole agent persona | orchestrator spawn-prompt construction (NOT yet captured) | Medium — via the agent's eval-visible outputs |
| Tool descriptions | MCP `register-*.ts` strings | Medium-high | MCP tool registration (NOT yet captured) | Low |
| Implementation code | `mcp-server/src/**` | High | n/a (code, not prompt context) | High (real unit tests) but highest risk |

Two facts drive the phasing in §5: (1) the **first two rows are provenance-ready in Phase 1** because
`resolveAgentSkills` already resolves `rule`, `ref`, `primer`, and `template` kinds with concrete paths
and content — instrumenting them is the additive hook described in §3.1; (2) **principle wording, agent
definitions, and tool descriptions need new or absent capture seams**: principle wording is not resolved
by `resolveAgentSkills` (it reaches agents via `get_principles` MCP calls, a different path with no
existing provenance seam), so it joins the loop in Phase 2 alongside agent definitions and tool
descriptions (the agent-def body is assembled by the orchestrator's spawn construction; tool
descriptions live in `register-*.ts`). The user's explicit ask — "evolve
agent *behavior*, not just doc wording" — lands squarely on the *agent definitions* row, which is the
headline Phase-2 deliverable precisely because it is the first row requiring a new provenance seam.

---

## 4. Proposed Mechanism — reflection → candidate → gate

**Engine = Canon-native (Decision #1, locked).** No DSPy/GEPA dependency. The hard-gate value lives
in the *gate*, which Canon already has ~80% of (`run-evals.sh`); GEPA's mutation engine is
approximated by an inline learner (sonnet) rewrite. Rationale carried from §8.1.

**Cadence = offline batch on the `loops/` framework (Decision #3, locked).** The evolve loop does not
run per-build — it is a Canon-authored loop (`loops/evolve.md`) dispatched by the orchestrator via
`CronCreate` at a lifecycle moment, exactly as `loops/ship-watch.md` is (verified: ship-watch is the
first real loop, `firing_posture` + `schedule.interval` + workspace-scoped state). Evolution is
expensive (multiple `run-evals.sh` passes per candidate), so it belongs off the build hot path.

**Recommendation: extend the learner with ONE new MCP tool, no new agent.** Rationale after the loop.

### The loop (Canon-native, trace-led, offline)

```
0. ATTRIBUTE       [Phase-1 step 0 — the new foundation] join ReviewViolation ⋈
                   ContextProvenanceRecord ⋈ transcript on (workspace,step_id)
                   primary; agent_id back-filled by log_step for transcript correlation
                   → the diagnosed cause names a SPECIFIC artifact + section + hash,
                   of WHATEVER class the failure points at (rule | primer | agent-def
                   | tool-desc | principle). No fixed target. (§3.1)
1. SELECT TARGET   among attributed failures, pick those whose violation class recurs
                   (recurring_violations[] weighted_instance_count ≥ 3) — reuses the
                   EXISTING promotion trigger as the recurrence filter.
2. DIAGNOSE        from the attribution tuple, form a causal hypothesis: "section S of
                   artifact X (hash H) was in context and the agent mis-applied it."
3. FREEZE BASELINE run run-evals.sh on the unmodified artifact (current main) →
                   baseline score per split. Persist as baseline.json.
4. MUTATE          learner generates 1–3 candidate rewrites of section S that address
                   the diagnosed cause, each respecting a size budget (§5).
5. SCORE           for each candidate: swap it into the evolve/<target> worktree,
                   run run-evals.sh → candidate score per split (via evaluate_candidate).
6. HARD GATE       reject any candidate that does not strictly improve the holdout split
                   vs baseline (§7): "unchanged" is a rejection, not a pass. Among
                   survivors, pick the best behavioral delta.
7. PROPOSE         emit the surviving candidate to .canon/proposed-learnings/, carrying
                   {diagnosed_cause, attribution, before/after per-split scores, size
                   delta} into the EXISTING watch→writer→reviewer→HITL pipeline (§6).
```

Step 0 is what Decision #4 adds and what the entire loop now stands on: without the attribution join,
steps 1–2 cannot name a *trace-led* target — they could only fall back to v1's principle-only
inference. Branch (`evolve/<target>-<timestamp>`) per run, Hermes-style.

### Why extend the learner, not add an agent or a standalone tool

- The learner **already** owns recurrence detection (the `weighted_instance_count ≥ 3` trigger,
  `references/learner-dimensions.md` §convention-lifecycle A) and **already** writes proposals to
  `.canon/proposed-learnings/`. Steps 1, 2, 7 are the learner's existing job; step 0 is a new query
  it runs against the provenance event store.
- Steps 3–6 (freeze, score, gate) are **deterministic harness work**, not a new persona. One new MCP
  tool — `evaluate_candidate({ target_path, candidate_text, splits })` — runs `run-evals.sh` against a
  candidate-injected worktree and returns `{ baseline_score, candidate_score, regressed: bool,
  per_split: {...}, size_delta }`. The learner calls it once per generated candidate.
- The **mutation** (step 4) is the only generative step. The learner (sonnet) generates candidate
  rewrites inline — it already reads artifacts and writes exact proposed text (`agents/learner.md`:
  "Every suggestion includes the exact text to add/change"). No new agent, no DSPy.

So the mechanism is: **provenance instrumentation (step 0 foundation) + 1 MCP tool
(`evaluate_candidate`) + learner instructions + eval-set splits/baseline + the `loops/evolve.md` host.**
No new agent. This is the lowest-blast-radius shape that delivers a *trace-led* hard gate.

---

## 5. Phasing — re-sequenced around trace-led targeting

The phasing is no longer "which target class is safe first" (that was v1's question, mooted by
Decision #4). It is now **"in what order does each capability that the trace-led loop depends on come
online."** The artifact-class ladder (§3.3) is folded in as *attribution-coverage rollout*, not target
restriction.

**Phase 1 — the foundation: make trace-led evolution possible at all.** Deliverables:
1. **Provenance instrumentation (step 0)** — `ContextProvenanceRecord` emitted from `resolveAgentSkills`,
   stored as a `context_provenance` event + summarized into `RunSummary`. Covers the
   provenance-ready classes the resolver already sees: **rules, references, primers, templates** (§3.3
   rows 1–2). This is the load-bearing deliverable; everything downstream joins on it.
2. **`evaluate_candidate` MCP tool** — candidate-injected `run-evals.sh` runner returning per-split
   scores + improvement flag (pass = strict improvement over baseline; fail = unchanged or worse).
3. **Eval-harness baseline + splits** — `baseline.json` freeze; add `split: train|val|holdout` to
   `eval-set.json`; encode the strict-holdout-improvement policy (§7).
4. **The offline Loop host** — `loops/evolve.md` (interval/self-paced, opt-in under supervised tier).
5. **The hard-gate (§7)** wired into the learner before proposal-write.

Phase 1 deliberately spans *all four provenance-ready classes at once* rather than one rule — because
trace-led targeting means the loop must be able to land on whichever of {rule, ref, primer, template}
the failure points at from day one. The eval suite's weaker coverage of refs/primers is acceptable in
Phase 1 because the gate's Phase-1 job is **regression prevention** ("the rewrite didn't break the
holdout"), not improvement proof.

**Phase 2 — agent-behavior evolution (the user's headline ask).** Add the provenance seam for the
**agent-definition body** (`agents/<name>.md`) — captured at the orchestrator's spawn-prompt
construction, the one assembly point `resolveAgentSkills` does not own — plus the **principle-wording**
class (already attributable via `violation.principle_id`, and the highest eval-suite verifiability).
This is the phase that delivers "evolve agent *behavior*, not just doc wording": once an agent def's
body sections carry provenance, a diagnosed behavioral failure can target the exact persona instruction
that produced it. Guardrail: never mutate a rule's `severity` or a principle's `scope.layers`/`scope.tags`
(matcher-load-bearing; `wiki_lint`-validated).

**Phase 3 — tool descriptions.** Add the provenance seam for MCP tool-description strings
(`register-*.ts`). Lower verifiability; needs eval cases that exercise tool-selection behavior.

**Phase 4 (deferred, highest risk) — implementation code.** Real unit tests are a stronger gate than
rubric eval, but mutation risk and blast radius are highest. Deferred exactly as Hermes defers it, and
out of scope for the trace-led prompt-context loop (code is not assembled into a spawn prompt, so the
provenance mechanism does not apply — a different gate).

### Size budgets as first-class fitness penalties — mapped to Canon's existing concerns

Canon **already** treats verbosity as a defect, which makes this a natural fit rather than a new
concept:

- **`doc-trim-fact-preservation`** (`principles/conventions/doc-trim-fact-preservation.md`) —
  trimming must preserve facts; a candidate that bloats an artifact to pass cases violates the
  spirit of this convention.
- **`line-limit-split-into-siblings`** (`principles/conventions/`) and the Biome
  `noExcessiveLinesPerFile` 600-line cap — hard length ceilings already enforced in CI.
- **CLAUDE.md byte budgets** — the orchestrator already tracks headroom (memory notes record
  "mcp-server CLAUDE.md at 16-byte headroom"). Agent-rule and principle files load into prompt
  context; bloat directly costs tokens.

**The fitness penalty:** a candidate's score is penalized by `length(candidate) − length(baseline)`
when positive. A candidate that improves behavioral score *only by getting longer* is treated as a
near-tie with baseline and loses to any equal-scoring shorter variant. This bakes Canon's existing
"verbose artifacts get skipped / cost tokens" intuition into the selection function — exactly
Hermes's design, expressed in Canon's own conventions.

---

## 6. Promotion Integration

The evolved candidate slots into the **existing** pipeline with one insertion:

```
learner (with evaluate_candidate hard-gate)  ← NEW gate runs HERE, pre-proposal
   → .canon/proposed-learnings/<id>.md        (existing watch lifecycle)
       carries: diagnosed cause, before/after per-split scores, size delta
   → watch → convention threshold (existing weighted_instance_count ≥ 3)
   → user accepts proposal
   → content-flow/learn-apply → writer applies edit (existing)
   → reviewer compliance check (existing)
   → HITL approval (existing, MANDATORY)
   → [NEW] PR → human merge (NEW gate this design adds for trace-led mutations)
```

> **Note on the PR gate:** The existing `content-flow/learn-apply` chain omits the ship step — content
> lands directly after HITL approval (`references/content-flow.md` ship-step row: "Omitted (no PR;
> content lands directly)"). The `→ PR → human merge` step shown above is a **new addition this design
> proposes** for the trace-led evolution path, on the grounds that self-generated mutations on
> governing artifacts carry higher risk than human-authored proposals. Whether to add this gate is a
> decision for the architect/greenlit build phase — it is not inherited from the existing chain.

Key placement rule: **the eval hard-gate runs inside the learner, *before* the proposal is ever
written** (step 6 of §4). By the time a candidate reaches `.canon/proposed-learnings/`, it has
*already* passed the improvement gate. A candidate that fails to strictly improve the holdout is
**never proposed** — it does not reach the watch lifecycle, the writer, the reviewer, or HITL.
This is the "hard-gate-before-HITL" requirement: the gate is upstream of every human touchpoint,
so humans only ever review candidates that demonstrably improve behavior on the holdout.

The proposal file gains three fields the writer and reviewer surface at HITL:
`diagnosed_cause`, `eval_delta` (before/after per split), `size_delta`. The reviewer's existing
verification-command discipline (`agents/writer.md` lines 107, 112–116) extends naturally: the
reviewer can **re-run `run-evals.sh` on the candidate** as its functional verification, matching
the `feedback_reviewer_must_build` posture (reviewer functionally verifies new behavior).

No new flow, no new agent in the promotion path — the evolution loop *feeds* the existing path.

---

## 7. The Hard-Gate Invariant

State this as a Canon invariant, in the project's own regression-intolerant idiom:

> **`evolution-hard-gate` (proposed invariant):** An evolved artifact is accepted only if it
> **strictly improves the holdout split** relative to baseline — a measurable increase in holdout
> pass count (or average rubric score). The eval suite is a hard gate, not a fitness term. A
> candidate that fails to improve the holdout is discarded regardless of how much it improves
> cross-run behavioral metrics — "unchanged holdout" is a rejection, not a pass. There is no
> blended score in which unchanged or regressing eval results can be "bought" by a behavioral gain.

This is the direct expression of two existing Canon postures:

- **`feedback_no_preexisting_failures`** ("ALL pre-existing failures must be fixed, never
  dismissed") and **`feedback_never_override_linter_to_fit_change`** ("never loosen a rule to fit a
  change — refactor to comply"). Canon already refuses to trade away a passing gate for
  convenience. The hard-gate invariant is the *self-evolution* corollary: Canon refuses to trade
  away a passing eval for a behavioral win.
- The reviewer's worst-case-verdict consolidation (CLAUDE.md: "Take worst-case verdict across all
  reviewers") — Canon already composes quality signals by *worst-case*, not by *average*. The
  hard gate is the same operator applied to candidate selection: failure to strictly improve
  the holdout is a BLOCKING verdict on the candidate, and BLOCKING is terminal.

Tolerance: for all text-artifact targets, the gate requires a **strict holdout improvement** —
at least one additional passing case (or a measurable rubric-score increase) vs baseline. This is
stricter than Hermes's ≤2% regression allowance and also closes the wrong-target gap: a
mis-targeted rewrite that leaves holdout performance unchanged is rejected (see §9 risk
"provenance correctness"). Canon's N is small enough that a 2% regression allowance is one case
and unchanged performance is indistinguishable from noise. Revisit the tolerance only if the
holdout grows past ~30 cases.

---

## 8. Resolved Decisions

All four are locked. Rationale retained for the eventual architect runbook.

**8.1 — Engine = Canon-native loop (NOT DSPy/GEPA).** The hard-gate value is in the *gate*, which
Canon already has ~80% of (`run-evals.sh` is a working rubric-scored LLM-judge harness). GEPA's
reflective-mutation engine is approximated by an inline learner (sonnet) rewrite at far lower
integration cost than bolting a Python/DSPy runtime onto a TypeScript/MCP codebase. Consequence:
**no new runtime dependency; full observability** (every step runs through Canon's own tools/store).

**8.2 — Eval data = mine-then-curate.** Mine real session history first (`get_build_history` /
`get_transcript` → `(task, verdict)` pairs, LLM-as-judge → good vs failure cases), then hand-curate
for quality. **Synthetic backfill only for holdout depth** when mining volume is too low to fill the
holdout split. Rationale: Canon's traces are real and already captured, so mined cases carry less
hallucination risk than synthetic ones — and because the holdout *is* the safety property (§9), its
provenance must be as trustworthy as possible. Mining is now doubly justified: Phase-1 provenance
instrumentation (§3.1) makes mined cases *attributable*, sharpening their value as eval material.

> **External corroboration — AutoForge as the named synthetic-backfill method (2026-06-22):**
> When mined-case volume is too low to fill the holdout split, the concrete method for synthetic
> backfill is **AutoForge** (described in Cameron Wolfe's "Agentic RL: Frameworks and Best Practices",
> https://cameronrwolfe.substack.com/p/agentic-rl). AutoForge generates eval tasks by random-walking
> a tool-dependency graph and executing a golden final state for ground-truth verification — exactly
> the kind of `(task, expected)` pair the holdout split needs. Canon already owns the required graph
> (`codebase_graph` / `graph_query`), so AutoForge-style graph-walk synthesis is the named method for
> generating synthetic holdout cases when mined volume falls short. This is a reference for *when* to
> use it, not a near-term build item.

**8.3 — Cadence = offline batch, hosted by the `loops/` framework.** Not per-build. A Canon-authored
`loops/evolve.md` dispatched via `CronCreate` at a lifecycle moment (modeled on `loops/ship-watch.md`).
Evolution is expensive (multiple `run-evals.sh` passes per candidate) and must stay off the build hot
path. Opt-in under the supervised tier; auto under autonomous/light-touch, matching ship-watch's
`firing_posture`.

**8.4 — Phase 1 target = trace-led, no fixed target.** The reflection step evolves whatever artifact
class the diagnosed failure points at (rule, ref, primer, template in Phase 1; agent definition and
tool description as their provenance seams come online). This is the maximally ambitious option, chosen
over v1's single-agent-rule safe start. The user's framing — "push beyond principles and rules and have
Canon learn to be better … evolve agent *behavior*, not just doc wording" — is the explicit mandate.
**This decision is why §3.1's attribution instrumentation is Phase 1's foundation rather than a
deferred nicety** (see §9 for the new risk it introduces).

---

## 9. Risks & Non-Goals

**Non-goals (explicit):**
- **NOT auto-merging self-modification.** Human oversight stays mandatory. The loop ends at a
  *proposal*. The existing `content-flow/learn-apply` chain (writer → reviewer → HITL) lands
  content directly — no PR in the existing path. This design proposes adding a PR/human-merge
  gate on top of that chain for trace-led mutations (see §6 note), but in either form nothing
  writes to `principles/`, `rules/`, or `agents/` without a human.
- **NOT a fitness-averaged optimizer.** The eval suite is a hard gate, never a weighted term (§7).
- **NOT code-evolution first.** Implementation-code evolution (Phase 4) is deferred and out of scope
  for the trace-led prompt-context loop; Phases 1–3 are text artifacts assembled into spawn prompts.
- **NOT per-build.** Evolution is an offline batch loop (Decision #3), never on the build hot path.

**Risks:**
- **Meta-risk — Canon evolving its own governing artifacts is a feedback loop that can drift.** A
  learner that rewrites the rules/agent-defs it is itself governed by can ratchet toward local optima
  that satisfy the eval suite while drifting from intent. **Bound:** the eval suite is *frozen* ground
  truth — hand/human-curated, and **not itself an evolution target** (measuring stick, not measured).
  Drift is bounded by what the holdout encodes, so *holdout quality is the safety property* — which is
  exactly why Decision #2 (mine-then-curate) is a **safety** decision, not just coverage.
- **NEW (introduced by Decision #4) — provenance correctness is now load-bearing for safety.** In v1,
  a wrong attribution inference merely produced a weak proposal that the gate would likely reject. Under
  trace-led targeting the attribution *chooses the target*, so a **wrong `ContextProvenanceRecord`
  points the mutation at the wrong artifact entirely** — e.g. a hash mismatch or stale `char_span`
  attributes a failure to a section that was not actually in context. The blast radius of an
  attribution bug is therefore larger than in v1. Mitigations: (a) `content_hash` lets the learner
  *verify* the wording it's about to mutate is byte-identical to what was in-context, refusing to
  mutate on mismatch; (b) the eval hard-gate catches a mis-targeted mutation downstream — but only
  if the gate requires a **strict improvement on the targeted holdout slice**, not merely
  non-regression. A wrong-target rewrite that leaves the holdout *unchanged* still passes a
  non-regression gate; the gate must require the candidate to **raise the holdout pass count
  above baseline** (or improve the average rubric score above baseline) to be accepted, not just
  avoid lowering it. This makes "unchanged holdout" a rejection, which is the correct outcome for
  a mis-targeted rewrite. The `evolution-hard-gate` invariant (§7) is strengthened accordingly:
  acceptance requires a measurable holdout improvement, not merely absence of regression;
  (c) treat provenance instrumentation as the highest-test-coverage component of the Phase-1 build.
- **NEW — trace-led scope creep across artifact classes.** "Evolve whatever the failure points at"
  can spread thin: one batch run might surface candidate targets across rules, primers, and agent defs
  simultaneously. Without a cap, the loop generates many low-confidence proposals. Mitigation: keep the
  existing `weighted_instance_count ≥ 3` recurrence filter as the *gate on which attributed failures
  are even eligible*, and cap proposals-per-batch. Recurrence filtering is what keeps trace-led from
  becoming trace-greedy.
- **NEW — provenance-store growth.** One `context_provenance` event per agent spawn, each listing every
  assembled artifact with hashes/spans, is materially larger than the existing `pitfall_injected` /
  `area_enrichment_injected` events. Over many builds this grows the execution store and the archived
  `RunSummary`. Mitigation: store hashes + spans (not full content — content is recoverable from the
  artifact at `path`+`content_hash`); apply the same JSONL auto-rotation already used for `.canon/`
  stores; summarize into `RunSummary` rather than embedding raw events in the archive.
- **NEW — attribution ≠ causation (residual, named in §3.1).** Provenance proves the wording was *in
  context*, not that it *caused* the failure. The transcript narrows but does not prove causation. The
  eval hard-gate is the causation arbiter: a mutation must strictly improve the holdout to be
  accepted — "unchanged" is a rejection. Do not let the precision of a hash-level attribution
  create false confidence that the diagnosed cause is correct — the gate, not the attribution, is
  the source of truth.
- **Overfitting to visible splits.** Without train/val/holdout separation, mutation overfits. Mitigated
  by the split (§3.2 item 4) and by gating on **holdout only**.
- **Eval-suite cost.** Each candidate requires a `run-evals.sh` pass (15 `claude -p` calls + judge).
  The layered cheap→expensive ordering (`--filter` fast subset first, full suite only on survivors)
  controls this — `run-evals.sh` already supports `--filter` and `--parallel`. Offline cadence
  (Decision #3) keeps this cost off every build.
- **Judge non-determinism.** The haiku judge is itself an LLM; a flaky verdict could spuriously reject a
  good candidate or admit a regressive one. Mitigate with `--structured-judge` (JSON verdicts) and, for
  gate decisions, majority-of-N judging on the holdout.

---

## 10. Phase 1 build surface (for an architect runbook, if greenlit)

Concrete new/changed components, so this brief can become a build next. Grouped by the five Phase-1
deliverables (§5).

**1. Provenance instrumentation (foundation)**
- `mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts` — *change*: add `step_id?`
  to `ResolveAgentSkillsOptions` (the existing optional struct that already carries `workspace` and
  `filePaths`); compute `content_hash` per `ResolvedSkill`; after `applyAgentSkillsDisclosure` returns,
  compute `char_span` per section against the final `preload_prompt` (not the pre-disclosure draft);
  append a provisional `context_provenance` event with `agent_id: null`, keyed by `step_id`
  (mirror the existing `appendEvent` pattern, L142–156). When `step_id` is absent, the event is
  emitted without a join key — provenance is degraded, not blocked (fail-open, matching the existing
  pitfall audit convention).
- `mcp-server/src/features/orchestration/tools/orchestration-journal.ts` (`log_step`) — *change*:
  when completing a step with `agent_id`, back-fill the matching `context_provenance` event row by
  appending a `context_provenance_agent_id` event (or a dedicated store update) for the same `step_id`.
  This is a single additive write; the back-fill uses the `step_id` already present in every
  `log_step` call.
- `mcp-server/src/domains/workspaces/execution-store.ts` — *reuse*: `appendEvent("context_provenance", …)`
  + `getEventsByType("context_provenance")` (already exist, L267–288). No schema change if stored as an
  event; optional new column only if indexed querying is needed.
- `mcp-server/src/features/history/history-types.ts` — *change*: add `context_provenance` to `RunSummary`
  so cross-build joins survive archiving; extend the run-summary builder
  (`features/history/services/run-summary-builder.ts`). The `agent_id` field in summarized records
  is populated from the back-filled event (present at archive time, since `log_step` completion
  runs before finalize).
- New shared type `ContextProvenanceRecord` (shape in §3.1) — likely `mcp-server/src/shared/lib/` or a
  new `features/orchestration/` type module.

**2. `evaluate_candidate` MCP tool**
- New `mcp-server/src/features/diagnostics/tools/evaluate-candidate.ts` (or a new `evolution/` feature) —
  injects `candidate_text` at `target_path` in an `evolve/<target>` worktree, runs `run-evals.sh` per
  split, returns `{ baseline_score, candidate_score, per_split, regressed, size_delta }`. Registered in
  `mcp-server/src/app/register-*.ts`. Uses the existing subprocess adapter
  (`platform/adapters/process-adapter.ts`) — must not import `node:child_process` directly (ADR-002).

**3. Eval-harness baseline + splits**
- `skills/canon/evals/eval-set.json` — *change*: add `split: "train"|"val"|"holdout"` per case; expand
  beyond 15 cases via mine-then-curate (Decision #2).
- `skills/canon/evals/run-evals.sh` — *change*: accept `--split <name>`; emit a machine-readable
  per-split score artifact (`baseline.json`) alongside the human summary.
- Encode the strict-holdout-improvement policy (the §7 invariant) in the gate path.

**4. Offline Loop host**
- New `loops/evolve.md` — frontmatter modeled on `loops/ship-watch.md` (`status`, `trigger.lifecycle_hook`,
  `firing_posture` {autonomous:auto, light-touch:auto, supervised:opt-in}, `schedule.interval`,
  workspace-scoped `state`). Body = the action-prompt that runs the §4 loop. Registered via `list_loops`.

**5. Learner extension + hard-gate**
- `agents/learner.md` — *change*: add the trace-led evolve procedure (step 0 attribution join → diagnose
  → mutate → call `evaluate_candidate` → hard-gate → write proposal). Add `evaluate_candidate` to the
  `tools:` allowlist.
- `references/learner-dimensions.md` — *change*: add an "evolution" dimension spec (the loop + the
  strict-holdout-improvement gate placement before proposal-write).
- `.canon/proposed-learnings/<id>.md` proposal format — *change*: add `diagnosed_cause`, `attribution`,
  `eval_delta`, `size_delta` fields the writer/reviewer surface at HITL (§6).

**Promotion path (§6): one possible new component** — reuses `content-flow/learn-apply` → writer →
reviewer → HITL (all existing). The optional PR/human-merge gate at the end is a new addition this
design proposes; it is not part of the existing content flow (see §6 note on PR gate).

**Sequencing note for the architect:** deliverable 1 (provenance) is the hard dependency for the
trace-led loop and should be its own wave with the highest test coverage; deliverables 2–4 can proceed
in parallel once the `ContextProvenanceRecord` type is fixed; deliverable 5 wires them together last.

---

## Appendix — verified file references

| Claim | File |
|---|---|
| Learner mines 4 surfaces; read-only; writes proposals | `agents/learner.md` |
| Promotion trigger: weighted instance count ≥ 3 | `references/learner-dimensions.md` §convention-lifecycle A (L121–123); `mcp-server/src/features/history/services/judge-weight.ts` |
| Watch lifecycle: exempt/reinforce/decay/archive | `references/learner-dimensions.md` Sub-analysis D; `mcp-server/src/features/history/services/consolidate-policy.ts` |
| Eval suite: 15 cases, trigger + quality, rubric-scored | `skills/canon/evals/eval-set.json` |
| Eval harness: claude -p + haiku judge, PASS/FAIL, exit 1 on fail | `skills/canon/evals/run-evals.sh` |
| RunSummary / ReviewViolation trace shape | `mcp-server/src/features/history/history-types.ts` |
| Cross-run analysis (recurring violations, fix cycles, cliffs) | `mcp-server/src/features/history/tools/get-cross-run-analysis.ts` |
| Transcript capture / retrieval | `mcp-server/src/features/orchestration/tools/{capture,get}-transcript.ts` |
| Drift report shape | `mcp-server/src/features/diagnostics/tools/get-drift-report.ts` |
| **Provenance hook**: skill resolution → preload_prompt, resolves rules/refs/primers/templates with path+content, already appends audit events | `mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts` (resolveSkills L233–251; formatPreloadPrompt L126–136; appendEvent L142–156, L177–189; compose L289–297) |
| **Provenance store**: `appendEvent(type,payload,correlationId?)` + `getEventsByType(type)` | `mcp-server/src/domains/workspaces/execution-store.ts` (L267–288) |
| **Offline-batch host** pattern (firing_posture, schedule.interval, workspace state) | `loops/ship-watch.md`; `mcp-server/src/features/loops/` |
| ADR-002 subprocess adapter (evaluate_candidate must use it) | `mcp-server/src/platform/adapters/process-adapter.ts` |
| Promotion path: writer → reviewer → HITL | `references/content-flow.md` (L19–20, 94–100) |
| Size-budget conventions | `principles/conventions/doc-trim-fact-preservation.md`, `principles/conventions/line-limit-split-into-siblings.md` |
| Regression-intolerance posture | memory `feedback_no_preexisting_failures`, `feedback_never_override_linter_to_fit_change` |
