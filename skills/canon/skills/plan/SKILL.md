---
name: plan
description: >-
  Strategic analysis and planning brief production. Evaluates build requests,
  challenges assumptions, considers alternatives, and produces a structured
  planning brief. Used by the planner agent before any code is written.
user-invocable: false
---

# canon:plan — Strategic Analysis Skill

This skill defines the contract for producing a planning brief. Load it when you are the planner agent evaluating a build request before any implementation begins.

## Non-Responsibilities

This skill covers strategic analysis only. Do NOT do the following — they belong to other agents:

- **Step-by-step execution plan** — that is the domain of `canon:synthesize`. The brief's Recommended Approach names which runbook steps are needed (using vocabulary from `references/runbook-vocabulary.md`); the synthesis skill translates those into an executable runbook.
- **Code-level design decisions** — that is the architect's domain during the `design` step. The brief identifies the problem and recommends an approach; it does not specify how modules are structured, which APIs to call, or how data flows through the system.

---

## 1. Required Brief Sections

Every planning brief must include all seven sections below. The output format follows `templates/planning-brief.md` (canonical path from project root). Write the brief to `${WORKSPACE}/plans/${slug}/planning-brief.md`.

### 1.1 Problem Statement

**Intent**: State the real outcome the user wants, not the solution they proposed. Distinguish observed (evidenced) from speculative (imagined) problems.

**Quality bar**:
- One to two sentences from the user's perspective.
- Cite evidence (`graph_query`, `get_file_context`, logs, user reports) when the problem is not self-evident. Apply `agent-evidence-over-intuition`: claims about user need must be grounded in observable facts, not assumed.
- If no evidence exists, say so explicitly: `Evidence: speculative — no logs or reports confirm this problem`.

**Example wording**: "Users cannot filter search results by date range. Evidence: 12 open GitHub issues tagged `search-ux`; no date-range parameter in the current API."

### 1.2 Target Users

**Intent**: Name who benefits and who does not. Scope prevents over-building.

**Quality bar**:
- At minimum: primary role + frequency of benefit.
- Explicitly note if certain user groups are out of scope.
- For internal tooling, name the team, not a persona.

**Example wording**: "Primary: end-users performing recurring search queries (daily). Secondary: admins auditing search usage (weekly). Out of scope: API consumers — the filter is UI-only in this brief."

### 1.3 Acceptance Criteria

**Intent**: Observable, testable conditions that define "done" without ambiguity.

**Quality bar**:
- Each criterion is independently verifiable — a reviewer unfamiliar with the request can confirm pass/fail.
- Use checkbox format (`- [ ]`) so the reviewer or tester can mark off each item.
- If the request lacks explicit criteria, propose them. If uncertain, flag in Open Questions.
- For complex epics: include a North-Star criterion ("the system as a whole achieves X") plus concrete sub-criteria.

**Example wording**: "- [ ] Filtering by date range returns only results within the specified window (integration test). - [ ] Invalid date input returns a 422 with a human-readable message. - [ ] Filter state persists across page reload."

### 1.4 Alternatives Considered

**Intent**: Ensure the recommended approach is the result of deliberate choice, not default.

**Quality bar**:
- At minimum two alternatives for any non-trivial request: one real alternative plus "Do nothing".
- For each alternative: one-line approach, effort bucket, honest tradeoff (what it gives up vs the recommended approach).
- Alternative C must always be "Do nothing" with an explicit consequence statement.
- Prefer alternatives that use existing capabilities: configuration over new code, extension over rewrite. Challenge the user's framing if a simpler path solves the same need.

**Example wording for Alternative C**: "Do nothing — users continue to filter manually post-export; churn risk increases as the dataset grows beyond ~5k rows."

### 1.5 Recommended Approach

**Intent**: The planner's single recommended path, grounded in the alternatives analysis.

**Quality bar**:
- Names the approach clearly.
- States rationale tied to evidence and Canon principles where applicable (cite principle IDs).
- Defines explicit scope boundaries: what is in scope and what is explicitly excluded.
- Phrases the approach in terms of runbook steps from `references/runbook-vocabulary.md` so the synthesis skill can consume it directly. Example: "Recommended steps: `research` (codebase scope), `design` (API contract), `implement` (team dispatch, 2 tasks), `test`, `review`, `context-sync`, `learn`."
- If the outcome is REDIRECT: state the redirect rationale explicitly and show how the redirected scope still satisfies the user's underlying need.

### 1.6 Open Questions

**Intent**: Surface what cannot be resolved from the request alone — before the architect builds on a wrong assumption.

**Quality bar**:
- Each question is tagged with a decision-owner: `[user]`, `[planner]`, or `[architect]`.
- Each question states why the answer matters — what decision it unblocks.
- If there are no open questions, say so explicitly: "None — all requirements and constraints are specified."
- Apply `agent-surface-assumptions`: assumptions that you resolved yourself belong in the ASSUMPTIONS block; unresolvable items belong here.

**Example wording**: "1. Should date-range filtering apply to all search result types or only document results? [user] — determines API scope. 2. Is timezone normalization required? [architect] — affects data model."

### 1.7 Value Assessment

**Intent**: Confirm the cost is proportional to the benefit before committing resources.

**Quality bar**:
- States cost (effort bucket + key risks).
- States value (magnitude of benefit + frequency + affected user count or percentage).
- States proportion verdict: `yes`, `no`, or `conditional` with conditions.
- For REDIRECT outcomes, the value assessment covers the redirected scope.
- Apply `agent-evidence-over-intuition`: cite measurable signals (issue count, usage data, error rates) rather than asserting value qualitatively.

**Example wording**: "Cost: medium (3–4 days, 1 engineer). Value: high — resolves 12 open issues affecting ~40% of active users on a daily workflow. Proportion: yes."

---

## 2. Depth Calibration Rules

Scale the brief to the complexity of the request. Never produce a full-length brief for a one-step fix; never produce a one-liner for a multi-wave epic.

### Trivial (maps to a 1-step runbook)

A request that resolves in a single runbook step (e.g., `fix` a specific bug, `context-sync` a doc update).

- **Problem Statement**: one sentence.
- **Recommended Approach**: one line naming the step (e.g., "`fix` — correct the off-by-one in `src/search/filter.ts`").
- **Alternatives**: not required. Include only if a genuine alternative exists.
- **Open Questions**: include only if genuinely unresolved. Empty is correct when the request is fully specified.
- **Acceptance Criteria**: one or two items maximum.
- **Value Assessment**: one sentence.

### Small feature (maps to a 3–4 step runbook)

A request that requires research, implementation, and review (the standard fast-path or feature flow).

- All seven sections required.
- At least one real alternative plus "Do nothing".
- Acceptance criteria are explicit and independently verifiable.
- Recommended approach cites the runbook steps.

### Complex epic (maps to a multi-wave runbook)

A request spanning multiple waves, multiple agents, or architectural change.

- All seven sections required, with full depth.
- Multiple alternatives with honest tradeoffs.
- North-Star-style acceptance criteria: a top-level observable outcome, plus decomposed sub-criteria per wave or subsystem.
- Value assessment includes risk-adjusted estimate — what happens if the work runs long or scope expands?
- Open Questions resolved before greenlight; unresolved questions block GREENLIGHT and produce OPEN_QUESTIONS outcome instead.

---

## 3. Constructive Push-Back Discipline

The planner's job is to challenge the request before resources are committed. Apply the following four checks in order before writing the brief body:

1. **Clarify requirements** — Is the problem statement clear? If not, ask one or two targeted questions. Do not enumerate every possible ambiguity — only the ones whose answers change the approach or scope.

2. **Challenge assumptions** — What does this request assume about the current system, user behavior, or effort? List assumptions explicitly in the ASSUMPTIONS block (required by `agent-surface-assumptions`). Flag assumptions that are likely wrong based on `graph_query` or `get_file_context` results.

3. **Evaluate alternatives** — Apply the Canon preference ordering: configuration over new code; extension over rewrite; scoped fix over broad refactor. If a simpler path achieves the same outcome, the brief should REDIRECT to it, not GREENLIGHT the original.

4. **Assess value relative to effort** — Estimate wave count and agents involved. If the effort exceeds the observable value, REDIRECT or flag in Value Assessment. "We could build this, but X is likely faster and solves the same problem" is a valid finding.

The outcome field (`GREENLIGHT` / `REDIRECT` / `OPEN_QUESTIONS`) communicates the result of this discipline, not just the planner's preference.

---

## 4. Artifact Contract

### Output path

```
${WORKSPACE}/plans/${slug}/planning-brief.md
```

Where:
- `${WORKSPACE}` is the active workspace directory (e.g., `.canon/workspaces/agent-teams-v2`).
- `${slug}` is the kebab-case name of the build request.

### Output format

Follow `templates/planning-brief.md` exactly. Read the template before writing the brief (`agent-template-required`). The template is the authoritative section structure; do not add or remove top-level sections.

### Iterations

When the brief is revised (e.g., after user answers Open Questions), write the new version as a numbered file:

```
planning-brief-iter-1.md   <- first revision
planning-brief-iter-2.md   <- second revision
```

The base `planning-brief.md` always holds the latest approved version. Numbered iteration files are the audit trail.

### Downstream reference

The synthesized runbook (produced by `canon:synthesize`) references this brief by path. The Recommended Approach section of this brief is the primary input the synthesis skill uses to determine which runbook steps to generate. Phrase the recommended approach using step IDs from `references/runbook-vocabulary.md`.

---

## 5. Evidence Requirements

Apply `agent-evidence-over-intuition` throughout:

- **Codebase claims** — back with `graph_query`, `get_file_context`, or `semantic_search` results. "The current API has no date-range parameter" must be verified, not assumed.
- **Effort estimates** — base on file counts, dependency depth (blast radius), and runbook step count. Do not assert "medium effort" without a rationale.
- **Value claims** — cite observable signals: issue counts, error rates, usage data, prior HITL feedback. "Users want this" is not evidence; "12 open issues tagged `search-ux`" is.
- **Principle citations** — when rationale references a Canon principle, cite the principle ID (e.g., `agent-simplify-before-extending`).

If evidence is unavailable for a claim, flag it in ASSUMPTIONS or Open Questions. Do not lower the evidence bar — omit the claim instead.
