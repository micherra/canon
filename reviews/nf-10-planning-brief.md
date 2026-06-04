# Planning Brief: NF-10 Coverage Map Generalization (iteration 2)

**Outcome**: GREENLIGHT

**Effort estimate**: small (hours)
**Value estimate**: high -- NF-8 demonstrated that silent scope narrowing at the planner-to-orchestrator handoff was a real failure mode; the same structural risk exists at two additional handoff points (architect-to-engineer, engineer-to-reviewer), and the fix is the same proven pattern: a structured coverage table that forces explicit disposition.

**Iteration 2 note**: User flagged that iteration 1 lacked sufficient research. Templates should always be aligned to docs. A research step is added before implement to audit the full template landscape and verify no handoff points are missed.

## ASSUMPTIONS

1. The task-plan template (`templates/task-plan.md`) is the correct target for the architect-to-engineer coverage map. The architect produces one task plan per implementation task; each plan should trace back to specific runbook requirements to prevent narrowing during decomposition.
2. The summary template (`templates/summary.md`) is the correct target for the engineer-to-reviewer coverage map. This is the engineer's output artifact that the reviewer reads in Stage 3 (compliance cross-check).
3. No TypeScript code changes are needed -- the coverage maps are instruction-layer markdown that agents follow via `agent-template-required`. The existing template-loading infrastructure does not parse these sections programmatically; they are consumed by agents as structured text.
4. The design-document template (`templates/design-document.md`) does NOT need a coverage map because the architect's design document is a different artifact from the task plan. The design doc captures the approach; the task plans capture the decomposition. The narrowing risk lives in the decomposition step (design -> task plans), not in the approach selection step.
5. The reviewer agent definition (`agents/reviewer.md`) already has Stage 3 (compliance cross-check) and Stage 4 (drift-from-plan) -- the new "Criteria Coverage" section in the implementation log gives the reviewer better input for those existing stages, but the reviewer template and agent instructions do not need changes.

## Problem Statement

When requirements flow through the Canon build pipeline, each handoff point is an opportunity for silent scope narrowing. NF-8 solved this at the planner-to-orchestrator boundary by adding a Requirement Coverage Map to the planning brief. The same structural vulnerability exists at two downstream handoffs:

1. **Runbook requirements -> Task plans**: The architect decomposes the approved runbook into atomic task plans. Requirements can be dropped or narrowed during decomposition with no structured mechanism to detect the loss.
2. **Task plan acceptance criteria -> Implementation**: The engineer implements a task plan and produces a summary. Acceptance criteria from the plan can be silently omitted from the implementation with no structured traceability back to what was required.

- **Evidence**: NF-8 was resolved in soak run 5 by adding the Requirement Coverage Map to `templates/planning-brief.md` (lines 67-87). The pattern is proven. The two downstream handoff points currently have no equivalent traceability mechanism -- confirmed by reading `templates/task-plan.md` (no coverage section) and `templates/summary.md` (no criteria coverage section).

## Target Users

- **Primary**: Canon build pipeline -- every build that flows through architect and engineer stages benefits from reduced silent narrowing risk.
- **Secondary**: Human reviewers -- the coverage maps make it easier to spot what was in-scope but not implemented, without manually cross-referencing upstream artifacts.
- **Out of scope**: External users of Canon; this is an internal pipeline quality improvement.

## Acceptance Criteria

- [ ] Research audit completed: every template in `templates/` assessed for handoff boundaries and coverage map applicability; agent definitions in `agents/` cross-referenced to confirm producer/consumer relationships; documentation in `docs/` and `references/` checked for coverage map pattern descriptions that need updating
- [ ] `templates/task-plan.md` contains a "Brief Coverage" section with a table mapping each runbook requirement to a task plan element (or explicitly marking it out-of-scope with rationale)
- [ ] `templates/summary.md` contains a "Criteria Coverage" section with a table mapping each acceptance criterion from the task plan to what was implemented (or explicitly marking it deferred with rationale)
- [ ] Both new sections follow the same disposition pattern as the planning brief's Requirement Coverage Map: `covered | descoped | partial` with required rationale for non-covered items
- [ ] Template frontmatter `read-by` fields are updated if downstream consumers change (verify current values are still accurate)
- [ ] The architect agent definition (`agents/architect.md`) references the new "Brief Coverage" section in its Step 7 (break into atomic task plans) instructions
- [ ] The engineer agent definition (`agents/engineer.md`) references the new "Criteria Coverage" section in its Step 10 (produce summary) instructions
- [ ] If research reveals additional templates or docs needing coverage maps or updates, those are either addressed in the implement step or explicitly descoped with rationale

## Requirement Coverage Map

| # | Requirement (from original request) | Disposition | Runbook step or rationale |
|---|-------------------------------------|-------------|--------------------------|
| 1 | Add "Brief Coverage" section to task-plan.md template mapping runbook requirements to tasks | covered | Step 2: implement |
| 2 | Add "Criteria Coverage" section to summary.md template mapping acceptance criteria to implementation | covered | Step 2: implement |
| 3 | Use same disposition pattern as NF-8 (covered/descoped/partial with rationale) | covered | Step 2: implement -- both tables use the identical disposition vocabulary |
| 4 | Instruction-layer-only change, no TypeScript | covered | Entire runbook is template + agent markdown edits only |
| 5 | Update architect agent instructions to reference the new section | covered | Step 2: implement |
| 6 | Update engineer agent instructions to reference the new section | covered | Step 2: implement |
| 7 | Audit ALL templates for handoff boundaries and coverage map applicability | covered | Step 1: research |
| 8 | Cross-reference agent definitions to verify producer/consumer template relationships | covered | Step 1: research |
| 9 | Check docs/references for coverage map pattern documentation needing updates | covered | Step 1: research |

## Alternatives Considered

### Alternative A: Coverage maps in templates only (no agent instruction updates)
- **Approach**: Add the coverage map sections to the two templates but do not update the architect or engineer agent definitions to reference them.
- **Effort**: small
- **Tradeoff**: Agents follow templates via `agent-template-required`, but without explicit instructions in the agent definition, the coverage sections may be treated as optional boilerplate rather than load-bearing traceability. The NF-8 pattern works because the orchestrator actively checks the coverage map -- without agent-side instructions, the new sections rely solely on template compliance.

### Alternative B: Full programmatic enforcement (TypeScript validation)
- **Approach**: Add TypeScript validation in the MCP server that parses coverage maps and blocks progression when dispositions are incomplete.
- **Effort**: medium
- **Tradeoff**: Stronger enforcement but significantly more effort for a risk that has not yet been observed at these handoff points. The instruction-layer approach (Alternative A + agent updates) is the proven pattern from NF-8. Programmatic enforcement can be added later if the instruction layer proves insufficient.

### Alternative C: Do nothing
- **Consequence**: Silent scope narrowing at the architect-to-engineer and engineer-to-reviewer handoffs remains undetected until a human reviewer manually cross-references upstream artifacts. Given that NF-8 proved this failure mode is real at the planner level, it is reasonable to expect it at downstream handoffs too.

## Recommended Approach

- **Approach**: Add structured coverage map sections to both `templates/task-plan.md` and `templates/summary.md`, following the identical disposition pattern from the planning brief's Requirement Coverage Map. Update the architect and engineer agent definitions to reference the new sections in their respective output steps. This is the same pattern that resolved NF-8, applied to two additional handoff points.
- **Why this one**: Proven pattern (NF-8), minimal effort, proportional to risk. The instruction-layer approach is sufficient because `agent-template-required` already enforces template compliance, and the explicit agent instructions ensure the sections are treated as mandatory rather than decorative.
- **Scope boundaries**: In scope: template edits to `task-plan.md` and `templates/summary.md`, agent instruction edits to `architect.md` and `engineer.md`. Out of scope: TypeScript validation, reviewer agent changes, design-document template changes, orchestrator-level enforcement of the new maps.
- **Runbook steps**: research -> implement -> review -> context-sync -> learn

## Open Questions

None -- all requirements and constraints are specified.

## Value Assessment

- **Cost**: small; four markdown file edits with a well-understood pattern to follow (the NF-8 coverage map).
- **Value**: high; closes the two remaining silent-narrowing gaps in the Canon build pipeline. Every build that flows through architect and engineer stages benefits. The NF-8 pattern proved this class of fix is effective.
- **Proportion**: yes -- the cost is minimal and the value is structural (prevents a class of failure, not just one instance).

## Handoff

- **GREENLIGHT** -> architect spawned next with this brief as context. The brief's Recommended Approach (specifically the Runbook steps field) is the primary input to the synthesis step.
