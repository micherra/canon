# Learner Dimension Specifications

Reference material for `learner`. Contains dimension specs, report template, and learning log schema.

---

## Dimension: principle-health

**Goal**: Use review history to suggest severity promotions, demotions, scope revisions, and removal of dead principles.

### Data source

Call the `get_drift_report` MCP tool to get baseline stats: per-principle compliance rates, violation counts, trend, never-triggered list, violation file_paths, and hotspot directories.

For verdict-impact weighting, weight violations by their review verdict:
- Violations in BLOCKING reviews count 2x for severity analysis (they stopped builds)
- Violations in WARNING reviews count 1x (normal weight)
- A principle violated 3 times in BLOCKING reviews has the same signal as one violated 6 times in WARNING reviews

**Minimum threshold**: 10 reviews required for any suggestion. Below threshold → note "Skipped: principle-health — requires 10 reviews, have {current}."

### Promotion rules

| Signal | Threshold | Suggestion |
|--------|-----------|------------|
| High compliance, strong-opinion | >= 95% compliance across >= 10 reviews, 0 intentional deviations | Promote to rule |
| High compliance, convention | >= 95% compliance across >= 10 reviews | Promote to strong-opinion |

### Demotion rules

Demotions are as important as promotions — a principle at the wrong severity creates noise that erodes trust in the entire system.

| Signal | Threshold | Suggestion |
|--------|-----------|------------|
| Rule with frequent violations | < 80% compliance across >= 10 reviews for a rule | Demote to strong-opinion — if a rule is routinely broken, it's not functioning as a hard constraint |
| Rule with justified overrides | >= 3 intentional deviations for a rule | Demote to strong-opinion — rules should have zero legitimate exceptions; if exceptions exist, it's an opinion |
| Strong-opinion with low compliance | < 50% compliance across >= 10 reviews | Demote to convention — the team doesn't follow this as a default path |
| Strong-opinion ignored in practice | < 30% compliance across >= 15 reviews, no intentional deviations logged | Demote to convention or flag for removal — not even tracked as intentional |
| Convention never honored | < 20% compliance across >= 10 reviews | Flag for removal — this convention doesn't match how the team works |

### Other signals

| Signal | Threshold | Suggestion |
|--------|-----------|------------|
| Low compliance, any severity | < 50% compliance across >= 10 reviews | Revise: too strict, unclear, or wrong scope |
| Frequent justified overrides | >= 5 intentional deviations with similar justifications | Add exception or narrow scope |
| Never triggered | 0 appearances across >= 10 reviews | Flag as potentially dead — too narrow or irrelevant |
| Violations concentrated in one directory | >= 70% of violation file_paths in same directory/layer | Suggest narrowing scope — principle may be too broad for its actual applicability |

### Demotion safety

- **Never demote security-tagged rules** (check `tags:` in frontmatter). If a security rule has low compliance, suggest "investigate why" instead.
- **Minimum data**: 10 reviews for any suggestion, 15 for rule demotions. Below threshold → "insufficient data."
- Include `CAUTION: Demoting a rule means pre-commit hooks will no longer block this violation.` in any rule demotion suggestion.

### Output per suggestion

```
**{principle-id}** (current: {severity} → suggested: {new severity})
{compliance_rate}% compliance across {N} reviews, {M} intentional deviations
Suggest: {promote to X | demote to Y — reason | revise — reason | add exception for Z | flag as dead | narrow scope to {pattern}}
{CAUTION note if demoting a rule}
```

---

## Dimension: codebase-patterns

**Goal**: Detect consistent coding patterns in the live codebase that should be formalized as conventions or principles.

### Data source

Scan the codebase directly using **Grep** and **Glob** tools only. Do NOT use any MCP pattern tool. Scan these categories:

- Error handling (try/catch, Result types, error propagation patterns)
- Validation (schema libraries, guard clauses, input checks)
- Naming (file naming conventions, variable conventions, export patterns)
- Imports (barrel files, path aliases, import ordering)
- Testing (test file location, mock patterns, assertion style)
- API (HTTP handler structure, middleware patterns, response shapes)
- Types (type vs interface, generics, utility type usage)

For each category, identify the dominant pattern and count how many files use it vs. competing patterns.

**Minimum threshold**: Pattern must appear in >= 5 files with >= 70% consistency across relevant files.

### Cross-checks before suggesting

- Check against `.canon/CONVENTIONS.md` — skip if already a project convention
- Check against principle index — skip if already covered by a principle
- Only suggest patterns that are stable (not in recently modified files only)

### Output per suggestion

```
**{Pattern category}** ({N} files, {consistency}% consistent)
Pattern: "{description of the dominant pattern}"
Evidence: {file-1}, {file-2}, {file-3} (and {N-3} more)
Suggest: Add to CONVENTIONS.md — "{convention text}"
```

---

## Dimension: convention-lifecycle

**Goal**: Track the full lifecycle of conventions — from task-level patterns to project conventions to formal principles, and flag stale conventions.

This dimension merges four analyses:

### Sub-analysis A: Task convention promotion

**Data source**: `.canon/plans/*/CONVENTIONS.md` — task conventions created by the architect agent during builds.

1. Read all task convention files
2. Extract each convention line (bullets starting with `- **`)
3. Group semantically similar conventions (same category and similar pattern)
4. Call `get_cross_run_analysis` (pass `project_dir`); use `recurring_violations[].weighted_instance_count` for the weighted >= 3 promotion threshold (neutral-weight fallback when outcome signals are absent). This field is computed by summing `computeOutcomeWeight(OutcomeSignals)` across all observed instances (`mcp-server/src/features/history/services/judge-weight.ts`).

**Weighting semantics**: Builds with CLEAN or low-fix-iteration outcomes contribute confirming signal above neutral weight (> 1.0). Builds with BLOCKING verdicts or high rework contribute below neutral weight (< 1.0). WARNING outcomes approximate neutral. When outcome signals are absent (drift-only entries with no `RunSummary`), the weight falls back to **1.0** (neutral) — preserving the existing count-based behavior.

**Suggestion rule**: Pattern must reach a **weighted instance count >= 3** to suggest promotion. Cross-check against `.canon/CONVENTIONS.md` and principle index before suggesting.

**Minimum threshold**: Weighted count >= 3. Below → note "Skipped: convention promotion — weighted instance count {current} < 3."

**Output per suggestion**:
```
**{Pattern category}** (weighted instance count: {W}, raw builds: {N})
Pattern: "{the convention text}"
Builds: {slug-1}, {slug-2}, {slug-3}
Suggest: Add to CONVENTIONS.md — "{convention text}"
```

### Sub-analysis B: Convention graduation

**Goal**: Identify conventions in `.canon/CONVENTIONS.md` ready to become formal principles.

1. Read `.canon/CONVENTIONS.md` — extract each convention
2. For each convention, check:
   - **Age**: Check `git log --diff-filter=A -p .canon/CONVENTIONS.md` to find when it was added. Conventions added in the last build are too new.
   - **Codebase adherence**: Use Grep/Glob to verify the pattern holds. Threshold: >= 80% consistency across relevant files.
   - **Build survival**: Has this convention appeared as a task convention in multiple builds? Check `.canon/plans/*/CONVENTIONS.md` for overlap.
   - **No violations**: Has this convention ever been contradicted in review data?

**Graduation criteria** (all must be true):
- Convention has existed for >= 5 builds or been in `CONVENTIONS.md` for a meaningful period
- Codebase adherence >= 80% across relevant files
- Convention has never been contradicted in review or decision data

**Output per suggestion**:
```
**{Convention text}** (ready for graduation)
Age: Present since {date or build count}
Adherence: {N}% across {M} files
Suggest: Ask Canon to create a new principle — starts an interactive interview to build a formal principle with rationale and examples
Proposed severity: {convention or strong-opinion based on whether it affects correctness}
```

### Sub-analysis C: Convention staleness detection

**Goal**: Identify conventions in `CONVENTIONS.md` that the codebase no longer follows.

1. Read `.canon/CONVENTIONS.md` — extract each convention
2. For each convention, determine what codebase pattern it describes
3. Use Grep/Glob to check if the pattern still holds:
   - Search for the pattern the convention describes
   - Search for contradicting patterns (e.g., if convention says "Use Zod", search for competing validation libraries)
4. Calculate current adherence

**Staleness criteria** (any one sufficient):
- Adherence has dropped below 50% across relevant files
- A competing pattern has emerged with higher adoption than the convention's pattern
- The convention references a tool/library/pattern that no longer exists in the codebase

**Output per suggestion**:
```
**{Convention text}** (stale)
Current adherence: {N}% across {M} files
Competing pattern: {what the codebase actually does now, if applicable}
Suggest: {update convention to match current practice | remove convention | investigate divergence}
```

### Sub-analysis D: CONSOLIDATE (staleness decay + archival) <!-- last-updated: 2026-06-04 -->

**Goal**: Decay confidence on stale watch proposals; flag archival candidates; reinforce and exempt confirmed/promoted items. Runs as part of every per-build `learn` step — incremental and cheap.

**Scope: `.canon/proposed-learnings/` only. This pass NEVER reads or writes `~/.claude/MEMORY.md` or any user memory store.**

**Data source**: Each watch file under `.canon/proposed-learnings/`.

**Algorithm**:

1. For each watch file, extract `days_since_last_instance` and `confirming_instances` (from the file's frontmatter or structured fields).
2. Construct a `WatchStalenessSignals` object and call `computeWatchConfidence(signals)` (`mcp-server/src/platform/storage/drift/watch-staleness-adapter.ts`) to get a `ConfidenceAnnotation`. This function delegates to the shared `computeConfidenceAnnotation` engine — there is no second decay implementation.
3. Pass the `WatchState` and the `ConfidenceAnnotation` to `decideWatchDisposition(watch, confidence)` (`mcp-server/src/features/history/services/consolidate-policy.ts`). `watch` is a `WatchState` object (with `status`, `days_since_last_instance`, `confirming_instances`); `confidence` is the `ConfidenceAnnotation` returned by `computeWatchConfidence`. The function returns one of four `WatchDisposition` values:
   - `"exempt"` — status is `promoted` or `confirmed`; item is never decayed. No write needed.
   - `"reinforce"` — recent confirming instance detected; annotate with reinforcement note.
   - `"decay"` — confidence has fallen; annotate the watch file with reduced confidence marker.
   - `"archive"` — confidence is below archive threshold; mark the watch file for removal.
4. Write the disposition result back into the watch file in `.canon/proposed-learnings/`. No writes outside `.canon/`.

**Fail-safe**: Non-finite or negative `days_since_last_instance` values are treated as maximally stale (conservative guard). Status comparison is case-insensitive so `"Promoted"`, `"PROMOTED"`, and `"promoted"` all resolve to `exempt`.

**Runs inside the per-build `learn` step**: no separate scheduler; no parallel decay engine.

**Output per watch processed**:
```
**{watch-id}** → disposition: {exempt|reinforce|decay|archive}
days_since_last_instance: {D}, confirming_instances: {C}
confidence: {score:.2f} ({label})
Action: {no write needed | annotated with reinforcement | annotated with decay marker | marked for archival}
```

### Sub-analysis E: Success-pattern mining <!-- last-updated: 2026-07-01 -->

**Goal**: Mine the clean-build corpus for recurring elegant resolutions and propose them as conventions. Positive-signal source; surface-only.

**Data source**: the auto-memory build-digest corpus — resolve the memory dir from `project_dir` by replacing `/` with `-` (mirror `resolveAutoMemoryDir` in `mcp-server/src/features/orchestration/services/digest-writer.ts`), then read `~/.claude/projects/<dashed>/memory/build-digest-*.md`. Read PRIOR builds' digests (the current build's digest is written at finalize, after the learn step) — this is what makes recurrence cross-independent-build by construction.

**Clean-build filter**: a digest qualifies iff its "Build Metrics" show `Violations found: 0` AND `Fix iterations: 0` (parse both numbers from the digest body). `Review verdict ∈ {clean, approve, none}` corroborates but is not required.

**Algorithm**:
1. Collect clean digests (per the filter above).
2. Grep each for the literal `**Notable resolution**:` line, skip digests with no such line.
3. Group semantically-similar resolutions (same as Sub-analysis A step 3 groups task-convention bullets).
4. A group is promotable only when it recurs across **≥3 distinct clean builds (distinct slugs)**.

**Weighting note**: Because the corpus is pre-filtered to clean outcomes, every member's `computeOutcomeWeight` sits at the uplift band (CLEAN/approve = 1.15, `mcp-server/src/features/history/services/judge-weight.ts` lines 52-57), so 3 distinct clean builds always clears the existing weighted-≥3 promotion bar (Sub-analysis A) while 2 do not. Sub-analysis E inherits that bar; it does NOT re-use `recurring_violations[].weighted_instance_count` (violation-keyed — no rows for clean builds).

**Cross-checks before surfacing** (guardrail b): skip any candidate already in `.canon/CONVENTIONS.md` or already covered by a principle (`list_principles` index) — identical to `codebase-patterns` and Sub-analysis A.

**Cooling-off** (reuse): first qualifying learn run writes a `success-pattern-watch` (`status: watch`, `evidence_count: 1`, `watch_threshold: 2`) to `.canon/proposed-learnings/`; a second independent learn run that re-confirms promotes it to a surfaced `success-pattern-candidate` (`status: candidate`, `evidence_count: 2`). Decays/archives via the existing CONSOLIDATE Sub-analysis D + `computeWatchConfidence` — no new decay engine.

**Surface-only** (guardrail c): output is a proposal file only; acceptance routes PM → writer (`references/content-flow.md`). The learner has no edit capability over CONVENTIONS.md/principles.

**Enrichment-only** (guardrail d): NEVER promote from a single digest's `**Notable resolution**:` line; the ≥3-build recurrence + cross-check + cooling-off are prerequisites.

**Minimum threshold**: below 3 distinct clean builds carrying a matching resolution → note "Skipped: success-pattern — {N} < 3 distinct clean builds."

**Output schema**:
```
---
id: success_{deterministic_hash}
type: success-pattern          # success-pattern-watch on first obs; success-pattern-candidate after cooling-off
dimension: convention-lifecycle
target: {proposed convention text}
status: watch                  # watch -> candidate (after 2-run cooling-off)
evidence_count: {1..}          # cooling-off observation count (learn runs)
watch_threshold: 2
confidence: {low|medium|high}
created: {YYYY-MM-DD}
last_updated: {YYYY-MM-DD}
origin_builds: [{slug-1}, {slug-2}, {slug-3}]   # the ≥3 distinct clean builds
---

## Observation
{grouped notableResolution, with the ≥3 distinct clean build slugs and weighted count}

## Proposed Change
Add to CONVENTIONS.md — "{convention text}"

## Evidence
- Clean builds: {slug-1}, {slug-2}, {slug-3} (0 violations, 0 fix each)
- Weighted recurrence: {W} across {N} distinct clean builds
- Notable-resolution lines: "{line-1}" / "{line-2}" / "{line-3}"

## Cross-check
- Not already in .canon/CONVENTIONS.md: {confirmed}
- Not already covered by a principle: {confirmed, principle index checked}
```

---

## Dimension: artifact-retirement <!-- last-updated: 2026-06-12 -->

**Goal**: Survey the live guardrail corpus (principles across all three tiers, conventions, agent-rules) and emit evidence-backed, cooling-off-gated, HITL-gated retirement proposals for dead-weight artifacts. Propose-only; never delete.

**Non-overlap note**: This dimension is distinct from two adjacent passes:
- `principle-health` *demotion* downgrades severity (rule → strong-opinion → convention) on a still-useful-but-mis-tiered principle. `artifact-retirement` proposes *removal* of a principle that is dead weight at any tier. A principle can be a demotion candidate (low compliance, still firing) without being a prune candidate (never firing at all). The prune dimension's gate explicitly DEFERS to demotion: if a principle is firing (non-zero honored or violation count), it is NOT a prune candidate.
- `convention-lifecycle` Sub-analysis C (*staleness*) proposes "update / remove / investigate" for a convention whose codebase pattern drifted. `artifact-retirement` reuses the same adherence scan, but adds the cooling-off and never-pruneable gating and routes the result into the unified prune proposal schema. To avoid double-emission, the prune dimension only surfaces a convention that Sub-analysis C has ALREADY flagged "remove" across the cooling-off window — it is the multi-observation aggregator on top of C, not a second scanner.
- `convention-lifecycle` Sub-analysis D (CONSOLIDATE) decays *pending* watch proposals. `artifact-retirement` operates only on *live, promoted* artifacts. Disjoint inputs.

### Data source

All sources are existing stores — no new producer (AC#6; empirically confirmed in PROBE-FINDINGS.md):

1. `get_drift_report` → `never_triggered: string[]` — principles never honored or violated across reviews; computed in `mcp-server/src/platform/storage/drift/analyzer.ts` at line 260. Primary deadness signal for principles.
2. `get_drift_report` → `most_violated[]` + per-principle compliance — used as a **NEGATIVE gate**: a principle still firing is NOT a prune candidate (may be a demotion case instead).
3. `get_drift_report` → `reviews.honored[]` aggregation — per-principle citation count, confirming firing or silence.
4. Grep/Glob adherence scan + `git log` age — for conventions and agent-rules (which never appear in review `honored`/`violations` signals, as reviews are principle-id keyed), reusing `convention-lifecycle` Sub-analysis C's method.
5. `.canon/proposed-learnings/` — read prior prune-candidate observations to apply the cooling-off (N-of-M) count across learn runs.

**Minimum threshold**: Principle path requires ≥ 10 reviews (inherits `principle-health` minimum). Below threshold → emit "Skipped: artifact-retirement (principles) — requires 10 reviews, have {current}." Convention/agent-rule adherence path has no review-count floor but still requires the 2-run cooling-off.

### Prune-candidate signals

Any one of the following makes an artifact a candidate; the cooling-off threshold then gates whether it is surfaced as a proposal:

| Signal | Applies to | Evidence bar |
|--------|-----------|--------------|
| never-triggered | principle (any tier) | appears in `never_triggered` across ≥ 10 reviews (inherits principle-health minimum) |
| superseded-by | any artifact | another live artifact demonstrably covers the same scope (explicit `supersedes`/overlap link); REQUIRED for rule-tier |
| dead-pattern | convention, agent-rule | Sub-analysis C flagged "remove" (referenced tool/pattern absent from codebase, or adherence not measurable because the pattern no longer exists) |
| never-cited | convention, agent-rule | adherence scan finds zero current instances AND no contradicting pattern (the guardrail guards nothing) |

### Cooling-off threshold

A candidate is only SURFACED as a proposal after it has been independently observed as a candidate in **≥ 2 distinct learn runs** (`watch_threshold: 2` — symmetric with the proposed-learnings promotion discipline), OR — for the strongest single signal — when a valid `superseded-by` link exists (a superseded artifact needs no cooling-off because the evidence is structural, not statistical).

**Lifecycle**: First observation writes a `prune-watch` entry (`status: watch`, `evidence_count: 1`). The second confirming observation promotes it to a surfaced `prune-candidate` proposal (`evidence_count: 2`, `status: candidate`). This reuses the exact watch→promote lifecycle and `computeWatchConfidence` decay already in the CONSOLIDATE pass (`mcp-server/src/platform/storage/drift/watch-staleness-adapter.ts`) — a `prune-watch` that stops recurring decays and archives like any other watch.

### Safety gates

All five gates must pass before a candidate is surfaced:

1. **Never-pruneable allowlist** — NEVER propose retiring any of the following:
   - Security-tagged rule-tier principles: `fail-closed-by-default`, `hooks-fail-closed`, `least-privilege-access`, `secrets-never-in-code`, `validate-at-trust-boundaries` (5 of 7 rules; frontmatter `tags:` contains `security`). Mirrors the existing `principle-health` "never demote security-tagged rules" safety.
   - Any artifact tagged `security` at any tier.
   - Always-on pipeline-integrity agent-rules: `agent-artifact-write-before-return` and `agent-template-required` class — these guard the artifact lifecycle and must never be silenced.

2. **Rule-tier requires superseded-by** — a `rule`-severity principle is a candidate ONLY if a valid, explicit `superseded-by` link to another live artifact exists. Never on `never-triggered` alone; a rule may be silent precisely because it is working (pre-commit hooks block the violation before review). Include `CAUTION: retiring a rule removes a hard constraint; pre-commit hooks will no longer block this violation.` in any rule-tier prune proposal.

3. **Never-auto-act** — output is a proposal only. The learner has no delete or edit capability over the guardrail corpus and this design adds none. Acceptance routes through the PM → writer content flow. This invariant is non-negotiable.

4. **Defer-to-demotion** — if a principle is still firing (non-zero honored or violation count), it is NOT a prune candidate. Route to `principle-health` demotion instead. Deadness requires zero firing across the review corpus.

5. **Minimum data** — the principle `never-triggered` path requires ≥ 10 reviews. Below threshold → emit the explicit skip line, never a speculative retirement. Absence of evidence below threshold is NOT evidence of deadness. The convention/agent-rule adherence path has no review-count floor, but the 2-run cooling-off still applies.

### Output per suggestion

Proposal files are written to `.canon/proposed-learnings/` (for the N-of-M cooling-off count) AND summarized in the `### Prune Candidates (artifact-retirement)` section of `.canon/LEARNING-REPORT.md`. The frontmatter reuses the existing proposed-learnings shape:

```
---
id: prune_{deterministic_hash}
type: prune-candidate          # prune-watch on first observation; prune-candidate after cooling-off
dimension: artifact-retirement
target: {principle-id | convention text | agent-rule-id}
artifact_tier: {rule | strong-opinion | convention | agent-rule}
status: candidate              # watch -> candidate (after cooling-off)
confidence: {high | medium}
evidence_count: {2..}          # cooling-off observation count
watch_threshold: 2
superseded_by: {artifact-id | null}   # REQUIRED non-null for rule-tier
created: {YYYY-MM-DD}
last_updated: {YYYY-MM-DD}
consolidate_disposition: {reinforce | decay | archive}
---

# prune_{hash} — Retire {target}

## Signal
{which prune-candidate signal(s) fired}

## Evidence
- never_triggered across {N} reviews / adherence {A}% across {M} files / superseded by {artifact}
- observed as prune candidate in {evidence_count} learn runs: {run-id-1}, {run-id-2}

## Safety gates passed
- never-pruneable allowlist: PASS (not security-tagged / not on allowlist)
- rule-tier superseded-by: {N/A | satisfied by {artifact}}
- defer-to-demotion: PASS (zero firing)

## Proposed action
Retire {target} via PM -> writer flow. {CAUTION note if rule-tier.}
```

---

## Dimension: process-health

**Goal**: Detect flow execution problems — churn, duration outliers, skipped states, and declining pass rates — that suggest principles or flow definitions need revision.

### Data source

Call the `get_history` MCP tool to retrieve recent builds from the drift database. Each entry includes flow name, completion timestamp, and associated decisions. For state-level iteration data, read workspace journals from `.canon/workspaces/*/journal.json`.

The `get_build_history` MCP tool provides archived build metadata (branch, flow, archived artifacts). Use it to supplement `get_history` when analyzing trends across many builds.

**Minimum threshold**: 5 builds required for any suggestion. Below → note "Skipped: process-health — requires 5 builds, have {current}."

### Signals to analyze

| Signal | Threshold | Suggestion |
|--------|-----------|------------|
| High iteration count on a state | Average iterations >= 3 across >= 5 runs | Review→fix churn — suggest examining the principle or engineer prompt for that state |
| Declining pass rates | Gate/postcondition pass rate trending down across recent 5 runs | Principles may be becoming harder to satisfy — review recently changed principles |
| Duration outlier by tier | A small-tier flow taking as long as a large-tier flow across >= 3 runs | Flow definition may have unnecessary states for this tier |
| Frequently skipped states | Same state skipped in >= 60% of runs | Flow definition may need trimming — this state adds little value |
| Rising violation count | Total violations per run trending up across recent 5 runs | Principles may need revision or scope narrowing |

### Cognitive Load Signals

**Goal**: Detect builds showing signs of cognitive overload — excessive retries, duration outliers relative to tier, or high skip rates — that suggest the system is struggling with a specific area.

**Formula**:

```
overload_score = (checkpoint_iters × 2) + (verify_iters × 3) + (skipped_count) + duration_outlier_factor
```

Where:
- `checkpoint_iters`: total retry iterations across all states in the build
- `verify_iters`: number of verify step re-runs (weighted higher — verify failures indicate deeper issues)
- `skipped_count`: number of states skipped during execution
- `duration_outlier_factor`: `max(0, (actual_duration - tier_mean) / tier_stddev - 1)` — only contributes when duration exceeds 1 stddev above tier mean

**Threshold**: builds scoring >= 6 are flagged.

| Score Range | Signal |
|-------------|--------|
| 0–2 | Normal — no action |
| 3–5 | Elevated — note in report, no flag |
| >= 6 | Investigate: cognitive overload pattern detected |

**Output per flagged build**:

```
**Cognitive overload detected** (score: {score}, tier: {tier})
Build: {slug} ({flow_name}, {date})
Breakdown: checkpoint_iters={N}×2, verify_iters={M}×3, skipped={S}, duration_outlier={D:.1f}
Primary contributor: {highest scoring component}
Suggest: Investigate {area} — {specific recommendation based on primary contributor}
```

**Tier baselines** (update as data accumulates):
- small: mean=43m, stddev=30m
- medium: mean=120m, stddev=60m
- large: mean=300m, stddev=120m

### Output per suggestion

```
**{state-name or flow-name}** ({signal type})
Evidence: {specific numbers — average iterations, pass rate trend, duration comparison}
Runs analyzed: {N}
Suggest: {specific action — examine principle X | trim state Y from flow | review engineer prompt for state Z}
```

---

## Dimension: agent-effectiveness

**Goal**: Analyze agent transcripts from completed flows to detect behavioral inefficiencies, tool misuse, role violations, and iteration waste — producing actionable suggestions for agent rule changes, principle proposals, and convention updates.

### Data source

- Read workspace journals (`journal.json`) to discover steps with `transcript_path` entries
- Call `get_transcript` MCP tool with `{workspace, state_id}` for each step
- Use `summary` mode first for pattern scanning, `full` mode for detailed analysis of flagged steps
- The `get_transcript` tool returns `TranscriptEntry[]` with fields: `role` ("system"|"user"|"assistant"|"tool_use"|"tool_result"), `content`, `tool_name?`, `tokens?`, `cumulative_tokens?`, `turn_number`, `timestamp`
- Note: `logStep` writes `transcript_path` to both the journal and the execution store, so `get_transcript` will find it. The recommended workflow is: discover steps with transcripts from the journal (where `transcript_path` is recorded), then call `get_transcript` which reads from the execution store (where the path was also persisted).

**Minimum threshold**: 3 completed flows with transcripts required. Below → note "Skipped: agent-effectiveness — requires 3 flows with transcripts, have {current}."

### Signals to analyze

| Signal | How to detect | Threshold | Suggestion |
|--------|--------------|-----------|------------|
| Tool retry churn | Same `tool_name` called 3+ times in sequence with `role: "tool_result"` containing error indicators between calls | >= 3 retries of same tool in a single step, observed in >= 2 flows | Agent rule change: add pre-validation or error-handling guidance for that tool |
| Excessive iteration | `turn_number` exceeds 2x the median for that `agent_type` across sampled flows | Step `turn_number` max >= 2x median for agent type, in >= 2 flows | Investigate: check if the agent's instructions are unclear or the task plan was underspecified |
| Role boundary violation | Entries with `role: "tool_use"` whose `tool_name` is not in the agent's declared `tools:` list, OR assistant entries performing work described in another agent type's definition | >= 1 occurrence in any flow | Agent rule change: add explicit boundary constraint to the violating agent's rules |
| Unused available tools | Agent's declared `tools:` list includes a tool that would have been appropriate for observed work, but the agent used `Bash` or manual approaches instead | Pattern observed in >= 2 flows for the same agent type | Agent rule change: add tool preference guidance (similar to learner's existing "Tool Preference" section) |
| Token cost outlier | `cumulative_tokens` for a step exceeds 3x the median for that `agent_type` and step type | Observed in >= 2 flows | Investigate: check if the agent is reading unnecessarily large files or receiving bloated context |
| Error recovery anti-pattern | Agent encounters an error (`tool_result` with error), then repeats the exact same approach without adapting (same tool, same or similar arguments) | >= 2 identical retry attempts after error, in >= 2 flows | Agent rule change: add error-recovery guidance — "on failure, diagnose before retrying" |

### Output per suggestion

```
**{agent_type}: {signal name}** ({N} occurrences across {M} flows)
Evidence: {step_id} in {flow_slug} — {tool_name} retried {count} times / turn_number {actual} vs median {expected} / etc.
Transcript: {workspace}/transcripts/{relevant_file}
Suggest: {agent rule change: "{exact text}" | principle proposal: "{description}" | convention update: "{text}"}
Artifact: {rules/{agent_type}.md | principles/{severity}/{slug}.md | .canon/CONVENTIONS.md}
```

---

## Dimension: agent-effectiveness

**Goal**: Analyze agent transcripts from completed flows to detect behavioral inefficiencies, tool misuse, role violations, and iteration waste — producing actionable suggestions for agent rule changes, principle proposals, and convention updates.

### Data source

- Read workspace journals (`journal.json`) to discover steps with `transcript_path` entries
- Call `get_transcript` MCP tool with `{workspace, state_id}` for each step
- Use `summary` mode first for pattern scanning, `full` mode for detailed analysis of flagged steps
- The `get_transcript` tool returns `TranscriptEntry[]` with fields: `role` ("system"|"user"|"assistant"|"tool_use"|"tool_result"), `content`, `tool_name?`, `tokens?`, `cumulative_tokens?`, `turn_number`

**Minimum threshold**: 3 completed flows with transcripts required. Below → note "Skipped: agent-effectiveness — requires 3 flows with transcripts, have {current}."

### Signals to analyze

| Signal | How to detect | Threshold | Suggestion |
|--------|--------------|-----------|------------|
| Tool retry churn | Same `tool_name` called 3+ times in sequence with `role: "tool_result"` containing error indicators between calls | >= 3 retries of same tool in a single step, observed in >= 2 flows | Agent rule change: add pre-validation or error-handling guidance for that tool |
| Excessive iteration | `turn_number` exceeds 2x the median for that `agent_type` across sampled flows | Step `turn_number` max >= 2x median for agent type, in >= 2 flows | Investigate: check if the agent's instructions are unclear or the task plan was underspecified |
| Role boundary violation | Agent with `role: "assistant"` generating `tool_use` entries for tools outside its declared `tools:` list, OR performing work described in another agent type's definition | >= 1 occurrence in any flow | Agent rule change: add explicit boundary constraint to the violating agent's rules |
| Unused available tools | Agent's declared `tools:` list includes a tool that would have been appropriate for observed work, but the agent used `Bash` or manual approaches instead | Pattern observed in >= 2 flows for the same agent type | Agent rule change: add tool preference guidance (similar to learner's existing "Tool Preference" section) |
| Token cost outlier | `cumulative_tokens` for a step exceeds 3x the median for that `agent_type` and step type | Observed in >= 2 flows | Investigate: check if the agent is reading unnecessarily large files or receiving bloated context |
| Error recovery anti-pattern | Agent encounters an error (`tool_result` with error), then repeats the exact same approach without adapting (same tool, same or similar arguments) | >= 2 identical retry attempts after error, in >= 2 flows | Agent rule change: add error-recovery guidance — "on failure, diagnose before retrying" |

### Output per suggestion

```
**{agent_type}: {signal name}** ({N} occurrences across {M} flows)
Evidence: {step_id} in {flow_slug} — {tool_name} retried {count} times / turn_number {actual} vs median {expected} / etc.
Transcript: {workspace}/transcripts/{relevant_file}
Suggest: {agent rule change: "{exact text}" | principle proposal: "{description}" | convention update: "{text}"}
Artifact: {rules/{agent_type}.md | principles/{severity}/{slug}.md | .canon/CONVENTIONS.md}
```

---

## Dimension: agent-effectiveness

**Goal**: Analyze agent transcripts from completed flows to detect behavioral inefficiencies, tool misuse, role violations, and iteration waste — producing actionable suggestions for agent rule changes, principle proposals, and convention updates.

### Data source

- Read workspace journals (`journal.json`) to discover steps with `transcript_path` entries
- Call `get_transcript` MCP tool with `{workspace, state_id}` for each step
- Use `summary` mode first for pattern scanning, `full` mode for detailed analysis of flagged steps
- The `get_transcript` tool returns `TranscriptEntry[]` with fields: `role` ("system"|"user"|"assistant"|"tool_use"|"tool_result"), `content`, `tool_name?`, `tokens?`, `cumulative_tokens?`, `turn_number`, `timestamp`

**Minimum threshold**: 3 completed flows with transcripts required. Below → note "Skipped: agent-effectiveness — requires 3 flows with transcripts, have {current}."

### Signals to analyze

| Signal | How to detect | Threshold | Suggestion |
|--------|--------------|-----------|------------|
| Tool retry churn | Same `tool_name` called 3+ times in sequence with `role: "tool_result"` containing error indicators between calls | >= 3 retries of same tool in a single step, observed in >= 2 flows | Agent rule change: add pre-validation or error-handling guidance for that tool |
| Excessive iteration | `turn_number` exceeds 2x the median for that `agent_type` across sampled flows | Step `turn_number` max >= 2x median for agent type, in >= 2 flows | Investigate: check if the agent's instructions are unclear or the task plan was underspecified |
| Role boundary violation | Agent with `role: "assistant"` generating `tool_use` entries for tools outside its declared `tools:` list, OR performing work described in another agent type's definition | >= 1 occurrence in any flow | Agent rule change: add explicit boundary constraint to the violating agent's rules |
| Unused available tools | Agent's declared `tools:` list includes a tool that would have been appropriate for observed work, but the agent used `Bash` or manual approaches instead | Pattern observed in >= 2 flows for the same agent type | Agent rule change: add tool preference guidance (similar to learner's existing "Tool Preference" section) |
| Token cost outlier | `cumulative_tokens` for a step exceeds 3x the median for that `agent_type` and step type | Observed in >= 2 flows | Investigate: check if the agent is reading unnecessarily large files or receiving bloated context |
| Error recovery anti-pattern | Agent encounters an error (`tool_result` with error), then repeats the exact same approach without adapting (same tool, same or similar arguments) | >= 2 identical retry attempts after error, in >= 2 flows | Agent rule change: add error-recovery guidance — "on failure, diagnose before retrying" |

### Output per suggestion

```
**{agent_type}: {signal name}** ({N} occurrences across {M} flows)
Evidence: {step_id} in {flow_slug} — {tool_name} retried {count} times / turn_number {actual} vs median {expected} / etc.
Transcript: {workspace}/transcripts/{relevant_file}
Suggest: {agent rule change: "{exact text}" | principle proposal: "{description}" | convention update: "{text}"}
Artifact: {rules/{agent_type}.md | principles/{severity}/{slug}.md | .canon/CONVENTIONS.md}
```

---

## Dimension: retrieval-effectiveness

**Goal**: Measure whether agents select the optimal retrieval tool for each search task, detect anti-patterns in tool selection, and track improvement over time as retrieval guidance (primer, model-conditioned steering) takes effect.

### Data source

Agent transcripts via `get_transcript` MCP tool (same pipeline as `agent-effectiveness`). Parse entries where `tool_name` is one of: `Grep`, `Glob`, `semantic_search`, `graph_query`, `get_file_context`.

Classify each search query by shape:
- **identifier**: camelCase, PascalCase, snake_case tokens, or strings containing `.`/`/` path separators
- **conceptual**: natural language phrases (3+ words without identifier patterns)
- **pattern**: glob-like patterns containing `*`, `?`, or `**`
- **structural**: queries asking about callers, callees, imports, dependencies, blast radius

**Minimum threshold**: 3 completed flows with transcripts required. Below threshold → note "Skipped: retrieval-effectiveness — requires 3 flows with transcripts, have {current}."

### Signals to analyze

| Signal | How to detect | Threshold | Suggestion |
|--------|--------------|-----------|------------|
| semantic_search for identifiers | `tool_name: "semantic_search"` where query classifies as `identifier` | >= 3 occurrences across >= 2 flows | Primer update: strengthen "Use Grep for exact identifiers" guidance |
| Grep for conceptual queries | `tool_name: "Grep"` where query classifies as `conceptual` | >= 3 occurrences across >= 2 flows | Primer update: strengthen "Use semantic_search for conceptual queries" guidance |
| Repeated search refinement | Same `tool_name` called 3+ times in sequence with progressively narrowing/shifting queries | >= 2 occurrences per flow, >= 2 flows | Investigate: initial search strategy may need improvement; primer may need "one search then act" emphasis |
| Tool switch after failure | Search tool A returns no/empty results, then search tool B called with semantically similar query | >= 2 occurrences across >= 2 flows | Track: positive if grep→semantic or semantic→grep (adaptive behavior); negative if circular (A→B→A) |
| Grep dominance ratio | Count Grep calls / total search calls, per agent_type and model | Report metric, no threshold | Baseline: track over time to measure Wave 1-3 effectiveness; expect ratio to increase for sonnet/haiku |

### Cross-checks

- Compare against the `agent-effectiveness` dimension's "Unused available tools" signal -- if agents have `semantic_search` available but never use it, that's different from using Grep instead (intentional per primer guidance vs ignorance).
- When `tool_switch_after_failure` is detected, check if the switch direction aligns with the retrieval-strategy primer's decision framework. Aligned switches suggest the primer is working; misaligned switches suggest a gap.

### Output per suggestion

```
**{agent_type}: {signal name}** ({N} occurrences across {M} flows)
Evidence: {step_id} in {flow_slug} -- {tool_name} called with query "{query}" (classified: {identifier|conceptual|pattern|structural})
Suggest: {primer update: "{specific text change}" | investigate: "{description}" | baseline metric: {current value}}
```

---

## Dimension: rule-compliance-measurement

**Goal**: Measure whether agent-behavior rules earn their keep in the preload context window. Identify rules that agents naturally follow (retirement candidates -- they waste context), rules with low compliance despite loading (investment candidates -- they need clearer wording or examples), and the marginal compliance impact of rule presence.

### Data source

Cross-reference two data sources:

1. **Agent preload manifests**: Read `agents/*.md` frontmatter `rules:` fields to determine which rules each agent type receives.
2. **Build transcripts**: Call `get_transcript` MCP tool for completed builds. For each agent invocation, determine:
   - Which rules were in the agent's preload (`rules:` field from its agent definition)
   - Whether the agent's behavior complied with each loaded rule (analyze transcript for rule adherence)
   - Whether the agent complied with rules it did NOT have loaded (natural compliance)

For compliance scoring, classify each rule-agent pairing per build as:
- **compliant**: agent followed the rule
- **violated**: agent broke the rule
- **n/a**: rule was not applicable to the work performed

**Minimum threshold**: 10 completed builds with transcripts required. Below threshold → note "Skipped: rule-compliance-measurement — requires 10 builds with transcripts, have {current}."

### Signals to analyze

| Signal | How to detect | Threshold | Suggestion |
|--------|--------------|-----------|------------|
| Natural compliance (retirement candidate) | Rule has >= 95% compliance across agents that do NOT have it preloaded, across >= 10 builds | >= 95% natural compliance | Rule may be redundant -- agents follow it without loading. Consider removing from preload to save context tokens. CAUTION: do not retire security-tagged rules. |
| Low compliance despite loading (investment candidate) | Rule has < 60% compliance across agents that DO have it preloaded, across >= 10 builds | < 60% loaded compliance | Rule needs investment -- rewrite for clarity, add examples, or add anti-rationalization table. Current wording is not effective. |
| High-value rule (keep) | Rule has >= 80% loaded compliance AND < 50% natural compliance, across >= 10 builds | Loaded >= 80%, natural < 50% | Rule is earning its keep -- compliance improves significantly when loaded. Protect from retirement. |
| Context cost outlier | Rule file exceeds 80 lines AND compliance improvement (loaded vs natural) is < 10 percentage points | File size > 80 lines, delta < 10pp | Rule is expensive (many context tokens) with low marginal value. Consider compressing or splitting. |
| Cross-agent compliance variance | Same rule has > 30pp compliance variance across different agent types that load it | Variance > 30pp across >= 3 agent types | Rule may need agent-specific wording or should be split into agent-specific variants. |

### Compliance scoring methodology

For each rule-agent-build triple, the learner examines the transcript to score compliance:

1. **Identify applicability**: Did the agent perform work where the rule would apply? (e.g., `agent-tdd-required` only applies when the agent writes code, not when it reads files)
2. **Score compliance**: If applicable, did the agent follow the rule?
   - For process rules (TDD, structured triage): check transcript for evidence of the process steps
   - For constraint rules (fresh context, workspace scoping): check for violations
   - For output rules (template required, artifact write): check for required outputs
3. **Natural compliance baseline**: Compare compliance of agents that have the rule loaded vs agents that perform similar work but do NOT have the rule loaded

### Output per suggestion

```
**{rule-id}** (current: loaded by {N} agents, {compliance_rate}% loaded compliance, {natural_rate}% natural compliance)
Delta: {loaded - natural}pp marginal compliance improvement
Context cost: {line_count} lines in {N} agent preloads = ~{token_estimate} tokens/build
Signal: {retirement candidate | investment candidate | high-value | context cost outlier | variance outlier}
Suggest: {retire from preload | rewrite for clarity | keep -- high value | compress to {N} lines | split into agent-specific variants}
{CAUTION note if rule has security tag}
```

---

## Dimension: cliff-rate <!-- last-updated: 2026-06-07 -->

**Goal**: Observe write-cliff telemetry — steps that are detected as started but never finished — to identify systemic reliability problems in the build pipeline and prompt targeted pattern watches.

### Data source

Call `mcp__canon__get_cross_run_analysis` (pass `project_dir`) and read the `cliff_events` field on the result.

- **Storage**: `cliff_events` table in `drift.db` (central aggregation, survives workspace archival).
- **Feed path**: `reconcile_workspace` dual-writes each detected cliff at emit time; `get_cross_run_analysis` runs `sweepCliffEvents` before analysis to backfill any events from live workspace DBs not yet in `drift.db` and refresh `recovery_outcome` from `journal.json`.
- **TypeScript type**: `CliffEventsDimension` on `CrossRunAnalysisResult.cliff_events`.

### Sparse-data contract

| Event count | `status` | `confidence.tier` | Permitted analysis |
|-------------|----------|-------------------|--------------------|
| 0 | `"no_data"` | `"insufficient"` | Report "no cliff events observed" — normal, not an error |
| 1–4 | `"observed"` | `"insufficient"` | Report counts verbatim; NO rates, trends, or promotion proposals |
| 5+ | `"observed"` | `"high"` | May propose pattern watches (see below); full rate and trend analysis permitted |

**Implementation note**: `confidence.tier` is determined by `deriveTier(score, sampleSize)`. The cliff-events dimension passes `value: 1` (direct observations, not inferences), so `score = 1.0`. Because `deriveTier` returns `"high"` for `score >= 0.7`, the tier is `"high"` for any sample size ≥ 5. The `"low"` and `"medium"` tiers are unreachable in this dimension — they would only apply if the score were below 0.7, which the current implementation never produces. The dimension reports counts only (no fabricated rates).

**No-rates-under-insufficient rule**: When `confidence.tier` is `"insufficient"`, never compute or report cliff rates (cliffs-per-build, recovery rates, etc.). Report counts and buckets only — rates over small samples fabricate signal.

### Fields to report

From `cliff_events` when `status === "observed"`:

| Field | Report as |
|-------|-----------|
| `total_cliffs` | Total write-cliff events detected |
| `workspaces_affected` | Distinct workspace slugs affected |
| `by_step_id` | Top buckets (step types that cliff most often) |
| `by_agent_type` | Top buckets (agent types present at cliff time) |
| `recovery_outcomes` | Breakdown: `recovered` / `abandoned` / `unresolved` / `unknown` |
| `confidence.tier` | Data quality annotation |

### Pattern watch proposals (tier `"high"` only)

At `"high"` tier, propose a pattern watch when:
- The same `step_id` appears in 3+ distinct workspaces (systemic step failure, not one-off).
- `recovery_outcomes.unresolved` > 0 (steps never recovered — silent data loss risk).
- `by_agent_type` shows one agent type dominating (agent-specific reliability signal).

### Output format

```
### Write-Cliff Telemetry

Status: {no_data | observed} | Confidence: {tier}
Total cliffs: {N} | Workspaces affected: {M}

{If status === "no_data":}
No cliff events observed — all tracked steps completed or were recovered/abandoned normally.

{If status === "observed" and tier === "insufficient":}
Observed counts (insufficient data for rate analysis):
- By step: {top buckets}
- By agent: {top buckets}
- Outcomes: recovered={N}, abandoned={N}, unresolved={N}, unknown={N}

{If tier >= "high":}
Top cliffing steps: {step_id}={count}, ...
Top cliffing agents: {agent_type}={count}, ...
Recovery: {recovered}% recovered, {abandoned}% abandoned, {unresolved}% unresolved
{Proposed watches if threshold met}
```

---

## Report Template

Combine all suggestions into `.canon/LEARNING-REPORT.md`:

```markdown
## Canon Learning Report
Generated: {YYYY-MM-DD} | Reviews analyzed: {N} | Source files scanned: {N} | Builds analyzed: {N}

### Principle Health (from review history)

#### Promotions
{principle-health promotion suggestions, or "No promotions suggested." if none}

#### Demotions
{principle-health demotion suggestions, or "No demotions suggested." if none}

#### Scope / Revision
{principle-health scope and revision suggestions, or "No scope revisions suggested." if none}

### Codebase Patterns (from live scan)
{codebase-patterns suggestions, or "No new patterns found meeting threshold (5+ files, 70%+ consistency)." if none}

### Convention Lifecycle

#### Task Convention Promotions
{convention-lifecycle sub-A suggestions, or "No recurring task conventions found (need 3+ builds)." if none}

#### Convention Graduation Candidates
{convention-lifecycle sub-B suggestions, or "No conventions ready for graduation." if none}

#### Stale Conventions
{convention-lifecycle sub-C suggestions, or "All conventions are current." if none}

### Process Health (from build history)
{process-health suggestions, or "No process health issues detected." if none}

### Agent Effectiveness (from agent transcripts)
{agent-effectiveness suggestions, or "No agent effectiveness issues detected." if none}

Each suggestion follows this format:
**{agent_type}: {signal name}** ({N} occurrences across {M} flows)
Evidence: {step_id} in {flow_slug} — {specific metric details}
Transcript: {workspace}/transcripts/{relevant_file}
Suggest: {agent rule change: "{exact text}" | principle proposal: "{description}" | convention update: "{text}"}
Artifact: {rules/{agent_type}.md | principles/{severity}/{slug}.md | .canon/CONVENTIONS.md}

### Retrieval Effectiveness (from search tool analysis)
{retrieval-effectiveness suggestions, or "No retrieval effectiveness issues detected." if none}

Each suggestion follows this format:
**{agent_type}: {signal name}** ({N} occurrences across {M} flows)
Evidence: {step_id} in {flow_slug} -- {tool_name} called with query "{query}" (classified: {query_shape})
Suggest: {primer update: "{text}" | investigate: "{description}" | baseline: {value}}

### Rule Compliance Measurement (from preload analysis)
{rule-compliance-measurement suggestions, or "No rule compliance issues detected." if none}

Each suggestion follows this format:
**{rule-id}** (loaded by {N} agents, {compliance_rate}% loaded, {natural_rate}% natural)
Delta: {delta}pp | Context cost: {lines} lines, ~{tokens} tokens/build
Signal: {signal type}
Suggest: {action}

### Prune Candidates (artifact-retirement)
{prune-candidate proposals, or "No retirement candidates meet the cooling-off threshold." if none}

### Recurring Suggestions
{Suggestions that appeared in 3+ previous learning runs but were never acted on — flag these prominently}

### No Action Needed
- {N} principles have healthy compliance (>80%) with sufficient data
- {M} conventions are well-established in the codebase
- Next learning run recommended after {threshold} more reviews
```

If a dimension was not requested (flags), omit its section entirely.

---

## Learning Log Schema

After writing the report, call the `append_learning_record` MCP tool — the sanctioned append
path for `.canon/learning.jsonl` (ADR-0056). Pass `project_dir` and a `record` argument built
to the field shape below; the tool serializes and newline-terminates it, so you hand over a
structured object and never touch bytes:

**Do not append by hand.** Shell redirection (`>>`, `echo`, `printf`, `tee`) or the `Write`
tool against `.canon/learning.jsonl` is not permitted: a record written without a trailing
newline silently merges with the next append — the tool exists precisely to make that
impossible. See ADR-0056.

The `record` object's fields (not bytes to write — the tool formats them):

```json
{
  "run_id": "learn_{YYYYMMDD}_{random_hex}",
  "timestamp": "{ISO-8601}",
  "dimensions": ["principle-health", "codebase-patterns", "convention-lifecycle", "artifact-retirement", "process-health", "agent-effectiveness", "retrieval-effectiveness", "rule-compliance-measurement", "cliff-rate"],
  "data_summary": {
    "reviews_analyzed": 0,
    "source_files_scanned": 0,
    "task_conventions_read": 0,
    "builds_analyzed": 0
  },
  "suggestions": [
    {
      "id": "sug_{deterministic_hash}",
      "dimension": "principle-health",
      "type": "promote|demote|revise|narrow-scope|flag-dead|promote-convention|graduate|stale|churn|pass-rate|duration|skipped-state|violation-trend|tool-retry-pattern|iteration-outlier|role-boundary-violation|unused-tool|token-cost-outlier|error-recovery-anti-pattern|semantic-for-identifier|grep-for-conceptual|search-refinement-chain|tool-switch-pattern|grep-dominance-ratio|retirement-candidate|investment-candidate|high-value-rule|context-cost-outlier|compliance-variance|prune-watch|prune-candidate",
      "target": "principle-id or convention text or state name",
      "summary": "One-line description of what's suggested",
      "confidence": "high|medium",
      "action": "suggested"
    }
  ]
}
```

### Suggestion ID generation

IDs must be **deterministic** so the same suggestion across runs produces the same ID. This is critical for history dedup and suppression.

Generate the ID by concatenating `dimension + type + target` and taking the first 8 characters of a simple hash:

```
id = "sug_" + first8chars(lowercase(dimension + ":" + type + ":" + target))
```

For example:
- Principle health promotion of `validate-at-trust-boundaries` → `sug_principle-health:promote:validate-at-trust-boundaries` → take first 8 hex chars of a hash
- New codebase pattern about Zod validation → `sug_codebase-patterns:promote-convention:zod-validation-at-api-boundaries` → take first 8

In bash (portable): `echo -n "principle-health:promote:validate-at-trust-boundaries" | md5sum | head -c 8`
(On macOS use `md5 -q` instead of `md5sum` if `md5sum` is unavailable.)

The key property: **the same suggestion always gets the same ID**, regardless of when or how many times the learner runs.

The `action` field starts as `"suggested"`. When the user acts on or dismisses a suggestion via `--apply`, the orchestrator updates it to `"applied"` or `"dismissed"`.

This log enables:
- Detecting recurring suggestions across runs
- Suppressing dismissed suggestions
- Tracking which suggestions were acted on
