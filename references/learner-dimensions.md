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

This dimension merges three analyses:

### Sub-analysis A: Task convention promotion

**Data source**: `.canon/plans/*/CONVENTIONS.md` — task conventions created by the architect agent during builds.

1. Read all task convention files
2. Extract each convention line (bullets starting with `- **`)
3. Group semantically similar conventions (same category and similar pattern)
4. Count the **weighted instance count** for each pattern using the cross-run analyzer's `weighted_instance_count` field on `RecurringViolation`, which sums `computeOutcomeWeight(OutcomeSignals)` across all observed instances (`mcp-server/src/features/history/services/judge-weight.ts`).

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
3. Pass the annotation and the watch's current `status` to `decideWatchDisposition(annotation, status)` (`mcp-server/src/features/history/services/consolidate-policy.ts`). The function returns one of four `WatchDisposition` values:
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

After writing the report, append a structured entry to `.canon/learning.jsonl`:

```json
{
  "run_id": "learn_{YYYYMMDD}_{random_hex}",
  "timestamp": "{ISO-8601}",
  "dimensions": ["principle-health", "codebase-patterns", "convention-lifecycle", "process-health", "agent-effectiveness", "retrieval-effectiveness", "rule-compliance-measurement"],
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
      "type": "promote|demote|revise|narrow-scope|flag-dead|promote-convention|graduate|stale|churn|pass-rate|duration|skipped-state|violation-trend|tool-retry-pattern|iteration-outlier|role-boundary-violation|unused-tool|token-cost-outlier|error-recovery-anti-pattern|semantic-for-identifier|grep-for-conceptual|search-refinement-chain|tool-switch-pattern|grep-dominance-ratio|retirement-candidate|investment-candidate|high-value-rule|context-cost-outlier|compliance-variance",
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
