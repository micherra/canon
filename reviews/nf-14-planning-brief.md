# Planning Brief: NF-14 + NF-15 Agent Artifact Write Failures and Worktree Targeting

**Outcome**: GREENLIGHT

**Effort estimate**: medium (days) -- expanded from small (hours) due to scope growth: all-agent audit, new behavioral rule, worktree orientation rule, NF-15 merge
**Value estimate**: high -- agent artifact write failures observed in 100% of researcher spawns (2/2 in NF-10) and engineer artifact failures are also reported. NF-15 shows engineer commits landing on main instead of worktree branch (f3a18cde in NF-10). These share a root cause: agents lack explicit workspace orientation instructions. Every future build with agent-teams mode will hit both failure modes.

## ASSUMPTIONS

1. **The researcher's tooling gap is real but only part of the story.** The researcher lacks the `Write` tool and its MCP write tool targets the wrong path -- this is confirmed. But the engineer (which has `Write` and `Edit`) also fails to write its declared artifacts. This means the broader issue is behavioral, not purely a tooling gap. Agents with full write capability still do not reliably produce their declared artifacts before returning. If this assumption is wrong and the engineer failures have a different root cause (e.g., context exhaustion at high turn counts), the research step will surface it.

2. **Artifact write failures and worktree targeting failures share a root cause: insufficient workspace orientation.** Agents receive `worktree_path` and `${WORKSPACE}` in their spawn prompts but lack explicit instructions to (a) verify they are on the correct branch, (b) write code changes to the worktree directory, (c) write artifacts to the workspace directory, and (d) write all declared artifacts before returning. NF-15 (engineer committing to main) and NF-14 (agents not writing artifacts) are symptoms of the same gap: no explicit "orient yourself before working" and "write artifacts before returning" instructions.

3. **The post-subagent artifact check is behavioral with no mechanical enforcement.** The orchestrator's CLAUDE.md says "verify expected artifacts exist" but this is a behavioral instruction that is skipped under token pressure. Extending `log_step` with artifact verification provides a lightweight mechanical backstop.

4. **A new Canon rule (`agent-artifact-write-before-return`) added to all artifact-producing agents' `rules:` frontmatter will address the behavioral gap.** This is the primary intervention for the engineer-type failures where the agent has the tools but does not use them. The rule makes artifact writing an explicit pre-return obligation rather than an implicit expectation.

5. **A new Canon rule (`agent-worktree-orientation`) added to all code-writing agents' `rules:` frontmatter will address NF-15.** This rule requires agents to verify they are on the correct branch and writing to the correct paths (worktree for code, workspace for artifacts) at the start of their work. This subsumes the NF-15 fix.

6. **The `write_research_synthesis` MCP tool was designed for legacy flow-based orchestration.** Its fixed output path (`handoffs/RESEARCH-SYNTHESIS.md`) does not match runbook-declared artifact paths. In agent-teams mode, the researcher should use the `Write` tool directly instead.

## Problem Statement

Canon agents fail to produce their declared output artifacts in agent-teams mode. This manifests in two observed failure modes:

1. **Artifact write failures (NF-14)**: The researcher agent completed research (read 40-54 files) but never wrote `research-findings.md` -- it lacks the `Write` tool entirely. More broadly, the engineer agent (which has `Write` and `Edit`) also fails to write declared artifacts. The common factor is that no agent definition includes explicit instructions to write all declared artifacts before returning.

2. **Worktree targeting failures (NF-15)**: The engineer committed `f3a18cde` directly to `main` instead of the Canon-managed worktree branch (`canon/nf-10-coverage-map-generalization`). Learner analysis of 5/6 soak runs shows commits landing on main. Agents receive `worktree_path` in spawn prompts but lack explicit branch-verification instructions.

Both failures stem from insufficient workspace orientation: agents do not have explicit behavioral rules requiring them to orient to their working context (correct branch, correct paths) and produce their declared outputs before returning.

- **Evidence**: (1) Researcher failed to write `research-findings.md` in both spawns during NF-10 soak run #8. Workspace `research/` directory created but left empty. Researcher's `tools:` list does not include `Write` or `Edit`. (2) Engineer committed f3a18cde directly to main instead of worktree branch. (3) User reports engineer also fails to write declared artifacts despite having `Write`/`Edit`. (4) No agent definition contains explicit "write your artifacts before returning" or "verify you are on the correct branch" instructions.

## Target Users

- **Primary**: Canon build pipeline -- every agent-teams build is affected. Both artifact and commit targeting failures degrade pipeline reliability.
- **Secondary**: Human reviewers who depend on artifacts at HITL checkpoints, and developers whose main branch receives unintended commits.
- **Out of scope**: End users of projects built with Canon. Legacy flow-based orchestration (uses different artifact paths and does not use worktrees).

## Acceptance Criteria

- [ ] Researcher agent can write findings to the artifact path declared in the runbook, using the `research-finding` template format. Verified by: researcher's `tools:` list includes `Write` and output instructions reference direct Write usage.
- [ ] New rule `agent-artifact-write-before-return` exists in `rules/` and is added to the `rules:` frontmatter of all artifact-producing agents (researcher, architect, engineer, tester, reviewer, scribe, shipper, learner). Verified by: rule file exists, all listed agents' frontmatter includes it.
- [ ] New rule `agent-worktree-orientation` exists in `rules/` and is added to the `rules:` frontmatter of all code-writing agents (engineer, tester, scribe). Verified by: rule file exists, all listed agents' frontmatter includes it.
- [ ] Agent definitions include explicit branch-verification and path-targeting instructions where applicable. Verified by: engineer.md, tester.md, and scribe.md contain instructions to verify branch and working directory match worktree_path.
- [ ] Post-subagent artifact check has mechanical enforcement via `log_step` artifact verification on completion. Verified by: `log_step` with `status: "completed"` checks `artifacts_expected` existence and returns `artifacts_missing` field.
- [ ] Engineer commits to the worktree branch, not main. Verified by: engineer.md commit protocol includes branch verification step.
- [ ] Existing agents that successfully write artifacts are unaffected by the changes. Verified by: `npm run build` passes and existing tests pass.
- [ ] NF-15 is resolved by the worktree orientation rule and agent instruction updates. Verified by: soak doc NF-15 can be marked as resolved.

## Requirement Coverage Map

| # | Requirement (from original request) | Disposition | Runbook step or rationale |
|---|-------------------------------------|-------------|--------------------------|
| 1 | Root cause investigation -- why do agents (not just researcher) fail to write artifacts? | covered | Step 1: research -- audit all agent definitions for artifact write mechanisms and workspace orientation |
| 2 | Fix researcher agent so it can write output files (tooling gap) | covered | Step 2: implement -- add `Write` to researcher tools, update instructions |
| 3 | Add artifact-write-before-return rule to all agents | covered | Step 2: implement -- create `agent-artifact-write-before-return` rule, add to all agents' `rules:` |
| 4 | Add worktree orientation / branch-verification instructions to agents | covered | Step 2: implement -- create `agent-worktree-orientation` rule, update agent definitions |
| 5 | Merge NF-15 scope (engineer commits to main instead of worktree branch) | covered | Step 2: implement -- worktree orientation rule + engineer commit protocol update |
| 6 | Strengthen post-subagent artifact enforcement from behavioral to mechanical | covered | Step 2: implement -- `log_step` artifact verification on completion |
| 7 | Update CLAUDE.md to reference mechanical enforcement | covered | Step 2: implement -- update Post-Subagent Artifact Check section |
| 8 | Investigate whether the researcher-specific tooling gap affects other agents | covered | Step 1: research -- tool profile audit across all agents |

## Alternatives Considered

### Alternative A: Behavioral rules only (no mechanical enforcement)
- **Approach**: Create the two new rules (`agent-artifact-write-before-return`, `agent-worktree-orientation`), add them to agent frontmatter, update agent instructions. No TypeScript changes to `log_step`.
- **Effort**: small
- **Tradeoff**: Simplest path. Addresses the root cause (missing instructions) without code changes. But behavioral instructions are exactly what failed before -- the orchestrator already had "verify artifacts exist" as a behavioral instruction and skipped it. Without mechanical enforcement, the same failure mode repeats one layer deeper. The NF-11 framework classifies this as needing both behavioral AND mechanical fixes.

### Alternative B: Comprehensive approach (behavioral + mechanical)
- **Approach**: Create both rules, update all agent definitions, add `Write` to researcher, AND extend `log_step` with artifact verification. Merge NF-15 scope into the worktree orientation rule.
- **Effort**: medium
- **Tradeoff**: Addresses both the behavioral gap (agents don't know they must write artifacts / verify branch) and the mechanical gap (no enforcement when they still fail). More work but provides defense in depth. Follows NF-11's classification framework.

### Alternative C: Do nothing
- **Consequence**: Every agent-teams build continues to lose artifacts. Engineers commit to main instead of worktree branches. The soak period cannot progress because both NF-14 and NF-15 remain unresolved, blocking confidence in the agent-teams pipeline.

## Recommended Approach

- **Approach**: Alternative B -- comprehensive behavioral + mechanical fix. Five deliverables:

  1. **Researcher tooling fix**: Add `Write` to the researcher's `tools:` list. Update Output Format section to instruct direct `Write` usage with the preloaded template. The `write_research_synthesis` MCP tool remains for backward compatibility but is no longer the primary write path.

  2. **New rule: `agent-artifact-write-before-return`**: A Canon rule requiring every agent to write all artifacts declared in its runbook step before returning its status. The rule specifies: (a) check the spawn prompt for `artifacts:` paths, (b) write each artifact before reporting status, (c) if an artifact cannot be produced, explain why in the status output rather than silently omitting it. Added to the `rules:` frontmatter of all artifact-producing agents.

  3. **New rule: `agent-worktree-orientation`**: A Canon rule requiring code-writing agents to orient themselves at the start of work: (a) verify they are on the expected branch (`git branch --show-current`), (b) if `worktree_path` is provided, verify the working directory matches, (c) if on the wrong branch, switch before making changes. Added to the `rules:` frontmatter of engineer, tester, and scribe.

  4. **Agent definition updates**: Update engineer.md commit protocol to include branch verification. Update tester.md and scribe.md similarly. Update all artifact-producing agents' `rules:` frontmatter to include the new rules.

  5. **Mechanical artifact enforcement**: Extend `log_step` (status "completed") to check `artifacts_expected` file existence, returning `artifacts_missing` in the result. Update CLAUDE.md post-subagent artifact check to reference the mechanical enforcement.

- **Why this one**: The root cause is two-fold -- a tooling gap (researcher) and a behavioral gap (all agents lack explicit artifact-write and branch-verification instructions). NF-11's behavioral vs. mechanical classification applies: behavioral rules address the instruction gap, mechanical enforcement provides the backstop. Merging NF-15 into the worktree orientation rule is natural -- both failures stem from missing workspace orientation. The combined fix prevents scope fragmentation.
- **Scope boundaries**: In scope: researcher `tools:` update, two new rules in `rules/`, all agent `rules:` frontmatter updates, engineer/tester/scribe instruction updates for branch verification, `log_step` artifact verification, CLAUDE.md update. Out of scope: overhauling the artifact validation system, adding `required_artifacts` to flow definitions, changing how MCP write tools work (beyond the existing `write_research_synthesis` optional path param), enforcement hooks (L4 mechanical hooks for branch targeting -- deferred to v2.2 if behavioral fix proves insufficient).
- **Runbook steps**: research -> implement -> test -> review -> context-sync -> learn

## Open Questions

None -- all requirements and constraints are specified. The user explicitly requested the scope expansion, and the NF-15 merge is confirmed.

## Value Assessment

- **Cost**: medium; two new rule files (markdown), agent definition updates across ~8 agents (markdown frontmatter + instruction edits), one focused TypeScript enhancement to `log_step`. The researcher tooling fix is a one-line tools list edit. The bulk of work is careful agent definition updates and rule authoring.
- **Value**: high; resolves two open soak findings (NF-14, NF-15) simultaneously. Unblocks every research step and prevents commits from landing on main. The artifact-write-before-return rule is a systemic improvement that prevents silent artifact loss across all agent types, not just the researcher. Defense in depth (behavioral + mechanical) follows the NF-11 classification framework.
- **Proportion**: yes -- the cost is medium and the value is structural. The two rules become permanent infrastructure that prevent an entire class of agent failures. The NF-15 merge avoids a separate build cycle for a tightly related issue.

## Handoff

- **GREENLIGHT** -> architect spawned next with this brief as context. The brief's Recommended Approach (specifically the Runbook steps field) is the primary input to the synthesis step.
