---
task_id: "phase1-08"
wave: 3
depends_on:
  - "phase1-05"
  - "phase1-06"
  - "phase1-07"
files:
  - agents/engineer.md (new — replaces implementor.md and fixer.md)
  - agents/planner.md (new)
  - templates/planning-brief.md (new — planner output template)
  - agents/implementor.md (delete)
  - agents/fixer.md (delete)
  - agents/guide.md (delete)
  - agents/chat.md (delete)
  - agents/researcher.md
  - agents/architect.md
  - agents/reviewer.md
  - agents/tester.md
  - agents/security.md
  - agents/scribe.md
  - agents/shipper.md
  - agents/learner.md
  - agents/writer.md
principles:
  - least-privilege-access
  - simplicity-first
  - refactoring-integrity
domains: []
---

## Task: Agent definition updates — engineer consolidation + frontmatter + skills

### Action

Four changes to agent definitions:

#### A. Engineer consolidation

Merge `implementor` and `fixer` into `engineer`:

1. Create `agents/engineer.md` with:
   - **tools**: union of both — `Read, Write, Edit, Bash, Glob, Grep, WebFetch, mcp__canon__semantic_search, mcp__canon__get_file_context, mcp__canon__graph_query, mcp__canon__codebase_graph, mcp__canon__get_messages, mcp__canon__write_implementation_summary`
   - **model**: sonnet
   - **maxTurns**: 50
   - **permissionMode**: acceptEdits
   - **memory**: project
   - **skills**: `agent-tdd-required, agent-minimal-fix, agent-fresh-context, agent-structured-triage, agent-simplify-before-extending, agent-context-check, principle-loading, status-protocol` (domain skills loaded on-demand by lead, NOT preloaded)
   - **Body**: Merge both instruction sets. The agent operates in two modes selected by spawn prompt context:
     - **Implementation mode** (spawned with a task plan): follows the implementor's process (read plan → load principles → implement → test → commit)
     - **Fix mode** (spawned with specific issues to fix): follows the fixer's process (understand issue → load context → minimal fix → verify → commit)
     - Shared sections: tool preference, commit protocol, status protocol, Canon compliance
     - **Memory instructions**: "Update your agent memory as you discover subsystem patterns, common test setup requirements, recurring gotchas, and fix patterns. This builds institutional knowledge across sessions."

2. Delete `agents/implementor.md`
3. Delete `agents/fixer.md`
4. Update `agents/.claude/CLAUDE.md` agent roster table

**Rationale**: Same skill set (both write code, both need Write/Edit/Bash, both need principles). Different prompting, not different agents. The fixer's `agent-minimal-fix` discipline and the implementor's `agent-tdd-required` discipline are both preloaded as skills — the spawn prompt activates the relevant mode.

#### A2. New planner agent

Create `agents/planner.md`:
- **description**: "Evaluates build requests before committing to implementation. Clarifies requirements, challenges assumptions, assesses alternatives and value. Produces a structured brief that greenlights, redirects, or asks clarifying questions. Spawned by the lead when a request is vague, assumption-heavy, or lacks clear acceptance criteria."
- **model**: opus
- **maxTurns**: 25
- **permissionMode**: plan
- **memory**: project
- **skills**: `agent-surface-assumptions, agent-evidence-over-intuition, agent-context-check, status-protocol`
- **tools**: `Read, Glob, Grep, WebFetch, mcp__canon__get_principles, mcp__canon__get_file_context, mcp__canon__graph_query, mcp__canon__semantic_search`

**Body**: Instructions covering the planner's five responsibilities:
1. Requirements clarification — what problem, who benefits, what does success look like
2. Assumption challenging — surface implicit assumptions, question whether they hold
3. Alternative evaluation — simpler approaches, configuration vs code, 80/20 solutions
4. Value assessment — effort estimate vs expected value, is the cost proportional
5. Brief production — structured output using a new `planning-brief.md` template

**Memory instructions**: "Update your agent memory with: features that were built and their outcomes, requests that were redirected to simpler solutions, patterns of over-engineering, recurring user needs. This builds judgment about what's worth building."

**New template**: Create `templates/planning-brief.md` with sections: Problem Statement, Target Users, Acceptance Criteria, Alternatives Considered, Recommended Approach, Open Questions, Value Assessment.

#### A3. Remove guide and chat

Delete `agents/guide.md` and `agents/chat.md`.

**Rationale — guide**: The lead session has full Canon MCP access (`get_principles`, `list_principles`, `get_compliance`, `get_drift_report`). When the user asks "what principles apply to auth?" the lead calls MCP tools directly. Spawning a subagent to do what the lead can do itself is overhead. Move the `guide-dashboards` reference content into the CLAUDE.md orchestration section (phase1-09) so the lead can render status dashboards natively.

**Rationale — chat**: Claude handles conversation natively. The planner now covers the structured "should we build this?" evaluation. Chat's remaining purpose (casual discussion, brainstorming) doesn't justify a dedicated agent definition — the lead does this in its main conversation.

#### B. Frontmatter updates for all 11 agents

Add `maxTurns`, `permissionMode`, `memory`, and `skills` to every agent:

| Agent | maxTurns | permissionMode | memory | skills (role-specific, + `agent-context-check` + `status-protocol` for all) |
|-------|----------|---------------|--------|-------|
| planner | 25 | plan | project | agent-surface-assumptions, agent-evidence-over-intuition |
| engineer | 50 | acceptEdits | project | agent-tdd-required, agent-minimal-fix, agent-fresh-context, agent-structured-triage, agent-simplify-before-extending, principle-loading |
| researcher | 20 | plan | project | agent-scoped-research, agent-surface-assumptions, agent-evidence-over-intuition |
| architect | 30 | plan | project | agent-design-before-code, agent-plans-are-prompts, agent-surface-assumptions |
| reviewer | 25 | plan | — | agent-cold-review, principle-loading |
| tester | 40 | acceptEdits | — | agent-test-the-contract, agent-test-sad-paths, tester-report-template, principle-loading |
| security | 25 | plan | — | agent-assume-hostile-input, security-checklist, principle-loading |
| scribe | 15 | acceptEdits | project | agent-context-sync, agent-missing-artifact, workspace-logging |
| shipper | 20 | acceptEdits | — | agent-artifacts-only, agent-template-required |
| learner | 25 | acceptEdits | project | agent-evidence-over-intuition, learner-dimensions, principle-format |
| writer | 25 | acceptEdits | — | principle-format, writer-worked-example |

**Permission model** — two values, declarative, enforced by Claude Code:
- `plan`: read-only. Agent cannot write files. For: researcher, architect, reviewer, security, planner.
- `acceptEdits`: auto-approves file edits and common filesystem commands (`mkdir`, `touch`, `rm`, `mv`, `cp`, `sed`) scoped to the working directory. All other Bash commands prompt. For: engineer, tester, scribe, shipper, learner, writer.

Note: `auto` mode exists but requires Team/Enterprise/API plans (NOT available on Pro or Max per Claude Code docs). The plan uses `acceptEdits` exclusively so Canon works on all plans. When the lead session runs in auto mode, subagent `permissionMode` frontmatter is ignored — the classifier handles everything.

This replaces the legacy `tool-profiles.ts` + `trust-resolver.ts` + `worktree-settings.ts` (~614 lines of runtime permission resolution). One YAML field per agent definition.

**Memory rationale**: Six agents get `memory: project` for cross-session learning:
- **planner**: Feature history, value patterns, requests redirected to simpler solutions
- **engineer**: Fix patterns, subsystem gotchas, common test setup (roadmap items 18, 19)
- **researcher**: Codebase topology, where subsystems live, prior research findings
- **architect**: Design patterns that worked/failed, recurring constraints, tradeoff history
- **scribe**: Doc landscape knowledge, which CLAUDE.md covers which areas, chronic gaps
- **learner**: Pattern mining results, principle proposals in progress (its core purpose)

Reviewer explicitly does NOT get memory — `agent-cold-review` rule requires fresh evaluation without anchoring on prior opinions. Other agents (tester, security, shipper, chat, guide, writer) have insufficient cross-session benefit to justify the memory overhead.

#### C. Remove runtime Read instructions

Where agent bodies contain `Read ${CLAUDE_PLUGIN_ROOT}/rules/agent-...` instructions, remove them — the content is now preloaded via `skills`. Keep the principle reference (e.g., "(agent-tdd-required)") as an inline citation but remove the Read instruction.

### Canon principles to apply

- **least-privilege-access**: `permissionMode: plan` for read-only roles. `acceptEdits` for roles that write files. No `auto` mode (requires Team/Enterprise plans).
- **simplicity-first**: Two agents become one. Fewer definitions to maintain.
- **refactoring-integrity**: The engineer consolidation is a genuine merge of overlapping roles, not a cosmetic rename.

### Tests to write

No new tests. Existing tests should pass since agent definitions are configuration, not code.

### Verify

1. `agents/engineer.md` exists with union tool list, correct skills (no domain primers), maxTurns 50, permissionMode acceptEdits, memory project
2. `agents/implementor.md` and `agents/fixer.md` are deleted
3. All 11 agent files have `maxTurns`, `permissionMode`, `memory` (where applicable), and `skills` in YAML frontmatter
4. YAML frontmatter parses for all agents: `for f in agents/canon-*.md; do python3 -c "import yaml; yaml.safe_load(open('$f').read().split('---')[1])"; done`
5. No runtime `Read ${CLAUDE_PLUGIN_ROOT}/rules/` instructions remain in agent bodies
6. `agents/.claude/CLAUDE.md` roster table updated to show 11 agents (engineer, planner present; implementor, fixer, guide, chat absent)
7. `npm run build` passes
8. `npm test` passes

### Done when

- 11 agent definitions (delete 4: implementor, fixer, guide, chat; create 2: engineer, planner; modify 9) with complete frontmatter
- engineer merges both instruction sets with dual-mode operation
- All skills in the preload map are referenced
- All runtime Read instructions for rules removed
- Build and tests pass
