---
task_id: "v2_1a-02"
wave: 2
depends_on: ["v2_1a-00"]
decisions:
  - "dc-03"
files:
  - skills/canon/references/runbook-synthesis.md
principles:
  - agent-design-before-code
  - agent-template-required
domains:
  - infrastructure
---

## Task: Create runbook-synthesis.md skill

### Action

Write `skills/canon/references/runbook-synthesis.md` defining the mechanical synthesis contract `canon-planner` follows to compose a plan-specific runbook from the canonical step vocabulary (v2_1a-00).

**The skill must specify:**

1. **Step schema** (per v2.1 §5.2) — first-class fields every synthesized step carries:
   - `id` (required, from vocabulary)
   - `agent` (required, usually vocab default; overrides explicit in brief body)
   - `dispatch` (required, `subagent` | `team` | `n/a`)
   - `skills` (optional, strictly validated against `skills/canon/references/` at synthesis time)
   - `cause` (required on `fix` steps: `test-failure | security | review | verify`; carries analytic lineage + skill hint)
   - `mcp_tools` (optional, list of MCP tool calls to compose context)
   - `artifacts` (required, relative paths under `${WORKSPACE}`)
   - `hitl` (required, from vocab default unless overridden)
   - `skip_when` (optional, human-readable condition)

2. **Synthesis MUST** (per v2.1 §5.3):
   - Include mandatory tail (`context-sync` → `learn`) on every build runbook
   - Use canonical step IDs only; reject unknown IDs at synthesis time
   - Preserve default agent / dispatch / HITL unless overriding with justification in brief body
   - Validate `skills:` names strictly against `skills/canon/references/`
   - Use `${slug}` / `${task_id}` / `${timestamp}` placeholders per the runbook format spec
   - Include a one-paragraph Overview explaining why this step sequence was chosen
   - Emit body H3 prose per step with intent, skip-when elaboration, coordination notes
   - Apply contract pairings: behavior-preserving `implement` → mandatory following `verify`; `migrate` → paired rollback artifact; `security` findings → at least one `fix` step with `cause: security` before `ship`; `review` verdict not clean → `fix` with `cause: review` loop until clean

3. **Synthesis MAY**:
   - Reorder steps (e.g., `security` before `review` for auth-sensitive changes)
   - Skip optional steps (`design` for scoped fixes; `test` for doc-only changes)
   - Repeat steps (two `review` passes for risky migrations; multiple `fix` cycles)
   - Expand a single step into multiple waves

4. **Synthesis MUST NOT**:
   - Invent new step IDs (vocabulary change is a versioned data-layer change, not per-run)
   - Remove baseline HITL from step defaults (confidence is advisory, not a modifier per §7.3)
   - Skip mandatory tail regardless of flow size or user preference

5. **Iterate-until-approved loop** (per v2.1 §5.4):
   - Each iteration re-spawns the planner with full workspace context
   - Intermediate iterations persist as separate files (`runbook-iter-N.md` in v2.1a; separate `lifecycle_synthesized_runbooks` rows in v2.1b+)
   - Only the approved runbook executes

6. **Conservative prompt guidance**: "Under-confidence is safer than over-confidence. Surface uncertainty; don't hide it." (per §7.4 mitigation 5)

7. **Confidence articulation** (per review HIGH-2 adjustment in `docs/agent-teams-migration-plan-v2.md` §7.1): per-signal `confidence_signals[]` MUST be emitted in the runbook frontmatter; aggregate `confidence` scalar is internal only (v2.1a/b) — not user-facing

### Canon principles to apply

- **agent-design-before-code** — the synthesis contract IS the runbook-format spec; no separate template
- **agent-template-required** — downstream consumers (lead, journal, learner) parse runbooks structurally; the schema in this skill is the contract

### Risk mitigations

- Planner inconsistency (§13, MEDIUM/MEDIUM): the contract is mechanical and checkable, so a synthesis regression suite (review MEDIUM-2) can validate planner output against the contract
- LLM overconfidence (§13, MEDIUM/HIGH): section 6 (conservative prompt guidance) + section 7 (per-signal only, aggregate internal) together enforce the v2.1a stance

### Tests to write

No existing test infrastructure for skills/*.md markdown. Validation is by:

- Manual read against the 7-contract-element checklist (step schema 9 fields, MUST / MAY / MUST NOT ≥ 3 items each, iteration loop doc, confidence per-signal-only wording)
- Integration test (can live in existing `mcp-server/src/features/orchestration/__tests__/` following the repo's test-path convention): end-to-end spawn of canon-planner against a representative fast-path-equivalent request; synthesize runbook; assert every MUST is satisfied; assert mandatory tail present. Belongs to v2_1a-08 validation but can be developed incrementally during this task.

### Verify

1. Skill file exists at `skills/canon/references/runbook-synthesis.md`
2. Unit tests pass: `npm test -- runbook-synthesis`
3. Integration test passes (v2_1a-08 validation reruns this)
4. Synthesis skill references v2_1a-00 vocabulary explicitly (by relative path)
5. Confidence handling matches `docs/agent-teams-migration-plan-v2.md` §7.1 HIGH-2 decision: per-signal user-facing, aggregate internal

### Done when

- File exists with all 7 contract elements
- Tests pass
- File is registered in the skills manifest
- No duplication with `planner-brief.md` (synthesis is mechanical; brief is strategic)
- canon-planner agent frontmatter (v2_1a-03) references this skill
