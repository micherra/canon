---
runbook: nf-14-nf-15-agent-artifact-and-worktree-failures
flow: feature
tier: feature
created: 2026-04-28T00:00:00Z
iteration: 2
confidence_signals:
  - dimension: scope
    level: medium
    rationale: >-
      Scope expanded significantly from iteration 1: now covers all agents (not just researcher),
      two new rules, NF-15 merge. The researcher tooling gap is high-confidence, but the
      behavioral root cause for engineer artifact failures is hypothesized (missing instructions)
      and needs research validation. The NF-15 merge adds worktree orientation across 3 agent
      definitions -- scope is well-defined but the interaction between workspace paths, worktree
      paths, and branch targeting has not been audited yet.
  - dimension: step-sequence
    level: high
    rationale: >-
      Research validates expanded root cause before implementation. Implementation has five
      clear deliverables (researcher tools fix, two new rules, agent definition updates,
      log_step enhancement). Test covers the mechanical enforcement. Review covers both
      rule quality and agent definition correctness. Standard tail follows.
  - dimension: contract-pairings
    level: medium
    rationale: >-
      The two new rules are consumed by resolve_agent_skills -- existing tests cover the resolver.
      The log_step enhancement has existing tests. However, the interaction between agent-worktree-orientation
      and the actual git worktree behavior during agent execution is a runtime contract that cannot
      be fully tested in unit tests -- it depends on correct spawn prompt construction by the orchestrator.
status: draft
---

# Runbook: NF-14 + NF-15 Agent Artifact Write Failures and Worktree Targeting

## Overview

This runbook addresses two related soak findings -- NF-14 (agent artifact write failures) and NF-15 (engineer commits to main instead of worktree branch) -- through a unified approach: explicit workspace orientation rules and mechanical artifact enforcement.

The original NF-14 brief scoped the problem as a researcher-specific tooling gap. User feedback revealed the problem is broader: the engineer (which has `Write` and `Edit`) also fails to write declared artifacts, and commits land on the wrong branch. The shared root cause is that no agent definition includes explicit instructions for workspace orientation (verify branch, verify working directory) or artifact completion (write all declared artifacts before returning). This runbook delivers two new Canon rules that address these gaps across all agents, plus the researcher-specific tooling fix and mechanical `log_step` enforcement from the original scope.

The flow is upgraded from fast-path to feature because the scope now touches ~8 agent definitions, creates 2 new rule files, modifies TypeScript (log_step), and updates CLAUDE.md orchestrator protocol. Research validates the expanded root cause hypothesis before implementation proceeds.

## Steps

### Step 1: research

```yaml
id: research
agent: researcher
dispatch: subagent
skills: []
cause: ~
mcp_tools:
  - get_file_context
  - graph_query
  - semantic_search
artifacts:
  - ${WORKSPACE}/plans/${slug}/research-findings.md
hitl: none
skip_when: ~
```

**Intent:** Validate the expanded root cause analysis against actual code. The original brief hypothesized a researcher-only tooling gap; user feedback says the engineer also fails. This research step audits ALL agent definitions to confirm or refine the hypothesis. Four dimensions:

1. **All-agent artifact write audit**: For each agent in `agents/`, document: (a) what artifacts the agent is expected to produce (from runbook steps and agent instructions), (b) what write mechanisms are available (Write tool, Edit tool, MCP write tools), (c) whether the agent's instructions include any explicit "write your artifacts before returning" directive, (d) whether the agent's instructions reference `worktree_path` or workspace paths and how. Produce a table showing each agent's write capability vs. its artifact obligations.

2. **Worktree and workspace path confusion audit**: For each code-writing agent (engineer, tester, scribe), document: (a) how `worktree_path` is referenced in instructions, (b) whether the agent is told to verify its branch, (c) whether the agent's commit protocol includes branch verification, (d) how `${WORKSPACE}` is used vs. `worktree_path`. Identify any ambiguity between "where to write code" (worktree) and "where to write artifacts" (workspace).

3. **write_research_synthesis analysis**: Read the MCP tool implementation to confirm the fixed path (`handoffs/RESEARCH-SYNTHESIS.md`) and understand whether adding an optional `output_path` parameter is straightforward or has hidden complexity.

4. **log_step enhancement feasibility**: Read `orchestration-journal.ts` and its callers to understand whether adding artifact existence checking to `log_step` (status "completed") is safe. Document what callers pass as `artifacts_expected`, whether the field is reliably populated, and what the return type implications are.

**Coordination notes:** Produces `research-findings.md`. The key deliverable is the all-agent audit table showing the gap between artifact obligations and write instructions. The implement step consumes these findings to calibrate which agents need which rule additions.

---

### Step 2: design

```yaml
id: design
agent: architect
dispatch: subagent
skills: []
cause: ~
mcp_tools:
  - get_file_context
  - graph_query
artifacts:
  - ${WORKSPACE}/plans/${slug}/DESIGN.md
  - ${WORKSPACE}/plans/${slug}/INDEX.md
hitl: approval
skip_when: ~
```

**Intent:** Design the two new rules and the agent definition update strategy based on research findings. Key design decisions:

1. **Rule content for `agent-artifact-write-before-return`**: What exactly must the rule say? How does it interact with `agent-template-required` (which governs output format but not the write act itself) and `agent-missing-artifact` (which governs missing input, not missing output)? The rule must be precise enough to be actionable but not so rigid that it conflicts with agents that write artifacts via MCP tools (reviewer uses `write_review`, engineer uses `write_implementation_summary`).

2. **Rule content for `agent-worktree-orientation`**: What verification steps are required? Just `git branch --show-current`, or also `pwd` verification? Should the rule cover both code-writing agents (who use worktrees) and artifact-writing agents (who write to workspace paths)? How does this interact with agents spawned without Agent-managed isolation (they rely on the orchestrator to set up the worktree correctly)?

3. **Agent update strategy**: Which agents get which rules? The audit table from research determines this. Design the specific frontmatter and instruction changes for each affected agent.

4. **log_step enhancement design**: Confirm the `artifacts_missing` field approach. Design the interaction with outcome sentinels and unresolved `${variable}` paths.

Break into task plans for the engineer.

**Coordination notes:** Produces DESIGN.md and INDEX.md (task plan index). Presented to the user for approval. The implement step executes the approved task plans.

---

### Step 3: implement

```yaml
id: implement
agent: engineer
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/plans/${slug}/SUMMARY.md
hitl: none
skip_when: ~
```

**Intent:** Execute the task plans from the design step. Five deliverable categories:

1. **Researcher tooling fix**: Add `Write` to the researcher's `tools:` list in `agents/researcher.md`. Update Output Format section to instruct direct `Write` usage with the preloaded template. Remove the outdated instruction about the orchestrator "providing the template path."

2. **New rule: `agent-artifact-write-before-return`**: Create `rules/agent-artifact-write-before-return.md`. Content per architect's design. Add to `rules:` frontmatter of all artifact-producing agents: researcher, architect, engineer, tester, reviewer, scribe, shipper, learner.

3. **New rule: `agent-worktree-orientation`**: Create `rules/agent-worktree-orientation.md`. Content per architect's design. Add to `rules:` frontmatter of code-writing agents: engineer, tester, scribe.

4. **Agent definition instruction updates**: Update engineer.md commit protocol to include branch verification. Update tester.md and scribe.md with workspace orientation instructions. Update researcher.md output instructions.

5. **log_step mechanical enforcement**: In `orchestration-journal.ts`, extend `logStep` (status "completed") to check `artifacts_expected` file existence. Add `artifacts_missing` field to result. Update CLAUDE.md post-subagent artifact check to reference mechanical enforcement.

**Coordination notes:** Produces SUMMARY.md with implementation log. The engineer should reference research findings and design decisions for calibration. The test step verifies the `log_step` behavior.

---

### Step 4: test

```yaml
id: test
agent: tester
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/plans/${slug}/test-report.md
hitl: none
skip_when: ~
```

**Intent:** Verify the `log_step` artifact verification behavior and validate the rule files are well-formed. Test cases:

1. `logStep` with `status: "completed"` and existing artifact paths returns empty `artifacts_missing`.
2. `logStep` with `status: "completed"` and non-existent artifact paths returns those paths in `artifacts_missing`.
3. `logStep` with `status: "completed"` and `outcome:` sentinel artifacts does not flag them as missing.
4. `logStep` with `status: "completed"` and unresolved `${variable}` paths skips them (does not flag as missing).
5. `logStep` with `status: "started"` or `status: "planned"` does not check artifacts (no premature checking).
6. Existing `verifyCompletion` tests still pass (regression check).
7. New rule files are valid markdown with correct frontmatter (`id`, `title`, `severity`, `tags`).
8. All modified agent frontmatter is valid YAML (no parse errors).
9. `npm run build` passes (TypeScript compilation check).

**Coordination notes:** Produces test-report.md. If tests reveal issues, the tester reports IMPLEMENTATION_ISSUE and the engineer is spawned in fix mode.

---

### Step 5: review

```yaml
id: review
agent: reviewer
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/reviews/REVIEW.md
hitl: checkpoint
skip_when: ~
```

**Intent:** Verify the implementation is correct and complete. Key review dimensions:

1. **Rule quality**: Both new rules are clear, actionable, and non-contradictory with existing rules (`agent-template-required`, `agent-missing-artifact`). Each rule has correct frontmatter, rationale, and exceptions sections.
2. **Agent definition correctness**: All affected agents' `rules:` frontmatter includes the new rules. Instruction updates are consistent across agents. No agent has contradictory instructions (e.g., "use MCP write tool" AND "use Write tool" for the same artifact).
3. **Researcher fix completeness**: `Write` is in the tools list, output instructions reference it, outdated template-path instructions are removed.
4. **Worktree orientation completeness**: Engineer commit protocol includes branch verification. Tester and scribe have orientation instructions. NF-15 is fully addressed.
5. **log_step implementation**: Artifact verification checks on "completed" only, handles outcome sentinels and unresolved variables, returns `artifacts_missing` without failing the tool call.
6. **CLAUDE.md accuracy**: Post-subagent artifact check section accurately describes the mechanical enforcement.
7. **No regressions**: `npm run build` passes, existing tests pass.

**Coordination notes:** Produces REVIEW.md. If verdict is BLOCKING, the orchestrator spawns engineer in fix mode. If CLEAN or WARNING, flow proceeds to mandatory tail.

---

## Mandatory Tail

### Step 6: context-sync

```yaml
id: context-sync
agent: scribe
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/context-sync-report.md
hitl: none
skip_when: ~
```

**Intent:** The scribe updates CLAUDE.md files to reflect: the two new rules, the researcher's updated tool profile, the engineer/tester/scribe worktree orientation instructions, and the `log_step` artifact verification behavior. The `agents/.claude/CLAUDE.md` and `rules/.claude/CLAUDE.md` may need updating to reflect new rules and changed agent capabilities.

**Coordination notes:** Runs after review completes. Produces `context-sync-report.md`. The `learn` step follows immediately.

---

### Step 7: learn

```yaml
id: learn
agent: learner
dispatch: subagent
skills: []
cause: ~
mcp_tools: []
artifacts:
  - ${WORKSPACE}/learning.md
hitl: none
skip_when: ~
```

**Intent:** The learner analyzes this flow for patterns. Key questions: (1) Does the behavioral-vs-mechanical classification from NF-11 hold here -- this was initially classified as mechanical (researcher tooling gap) but expanded to include behavioral (missing instructions for all agents). Does the NF-11 framework need refinement to handle mixed-classification findings? (2) Are there other agent behavioral gaps of the same shape -- "agent has capability X but no explicit instruction to use it for purpose Y"? (3) Should Canon add a CI validation that checks each agent's `rules:` frontmatter includes required rules (like an "every artifact-producing agent must have agent-artifact-write-before-return" assertion)?

**Coordination notes:** Final step. Produces `learning.md`. No subsequent steps; orchestrator transitions to `complete_flow` after this step.
