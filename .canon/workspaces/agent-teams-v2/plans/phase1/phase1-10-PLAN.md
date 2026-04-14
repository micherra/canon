---
task_id: "phase1-10"
wave: 3
depends_on:
  - "phase1-07"
  - "phase1-08"
  - "phase1-09"
files:
  - agents/canon-engineer.md (new — replaces canon-implementor.md and canon-fixer.md)
  - agents/canon-implementor.md (delete)
  - agents/canon-fixer.md (delete)
  - agents/canon-researcher.md
  - agents/canon-architect.md
  - agents/canon-reviewer.md
  - agents/canon-tester.md
  - agents/canon-security.md
  - agents/canon-scribe.md
  - agents/canon-shipper.md
  - agents/canon-learner.md
  - agents/canon-chat.md
  - agents/canon-guide.md
  - agents/canon-writer.md
principles:
  - least-privilege-access
  - simplicity-first
  - refactoring-integrity
domains: []
---

## Task: Agent definition updates — engineer consolidation + frontmatter + skills

### Action

Three changes to agent definitions:

#### A. Engineer consolidation

Merge `canon-implementor` and `canon-fixer` into `canon-engineer`:

1. Create `agents/canon-engineer.md` with:
   - **tools**: union of both — `Read, Write, Edit, Bash, Glob, Grep, WebFetch, mcp__canon__semantic_search, mcp__canon__get_file_context, mcp__canon__graph_query, mcp__canon__codebase_graph, mcp__canon__get_messages, mcp__canon__write_implementation_summary`
   - **model**: sonnet
   - **maxTurns**: 50
   - **permissionMode**: auto
   - **skills**: `agent-tdd-required, agent-minimal-fix, agent-fresh-context, agent-structured-triage, agent-simplify-before-extending, agent-context-check, principle-loading, status-protocol, backend-api, backend-data, deprecation, frontend, infrastructure, testing`
   - **Body**: Merge both instruction sets. The agent operates in two modes selected by spawn prompt context:
     - **Implementation mode** (spawned with a task plan): follows the implementor's process (read plan → load principles → implement → test → commit)
     - **Fix mode** (spawned with specific issues to fix): follows the fixer's process (understand issue → load context → minimal fix → verify → commit)
     - Shared sections: tool preference, commit protocol, status protocol, Canon compliance

2. Delete `agents/canon-implementor.md`
3. Delete `agents/canon-fixer.md`
4. Update `agents/.claude/CLAUDE.md` agent roster table

**Rationale**: Same skill set (both write code, both need Write/Edit/Bash, both need principles). Different prompting, not different agents. The fixer's `agent-minimal-fix` discipline and the implementor's `agent-tdd-required` discipline are both preloaded as skills — the spawn prompt activates the relevant mode.

#### B. Frontmatter updates for all 12 agents

Add `maxTurns`, `permissionMode`, and `skills` to every agent:

| Agent | maxTurns | permissionMode | skills (role-specific, in addition to `agent-context-check` + `status-protocol` for all) |
|-------|----------|---------------|-------|
| canon-engineer | 50 | auto | agent-tdd-required, agent-minimal-fix, agent-fresh-context, agent-structured-triage, agent-simplify-before-extending, principle-loading + all 6 domain primers |
| canon-researcher | 20 | plan | agent-scoped-research, agent-surface-assumptions, agent-evidence-over-intuition |
| canon-architect | 30 | plan | agent-design-before-code, agent-plans-are-prompts, agent-surface-assumptions + all 6 domain primers |
| canon-reviewer | 25 | plan | agent-cold-review, principle-loading |
| canon-tester | 40 | auto | agent-test-the-contract, agent-test-sad-paths, tester-report-template, principle-loading |
| canon-security | 25 | plan | agent-assume-hostile-input, security-checklist, principle-loading |
| canon-scribe | 15 | auto | agent-context-sync, agent-missing-artifact, workspace-logging |
| canon-shipper | 20 | auto | agent-artifacts-only, agent-template-required |
| canon-learner | 25 | auto | agent-evidence-over-intuition, learner-dimensions, principle-format |
| canon-chat | 30 | plan | (no role-specific skills beyond agent-context-check + status-protocol) |
| canon-guide | 20 | plan | guide-dashboards |
| canon-writer | 25 | auto | principle-format, writer-worked-example |

#### C. Remove runtime Read instructions

Where agent bodies contain `Read ${CLAUDE_PLUGIN_ROOT}/rules/agent-...` instructions, remove them — the content is now preloaded via `skills`. Keep the principle reference (e.g., "(agent-tdd-required)") as an inline citation but remove the Read instruction.

### Canon principles to apply

- **least-privilege-access**: `permissionMode: plan` for read-only roles. `auto` only for roles that write files.
- **simplicity-first**: Two agents become one. Fewer definitions to maintain.
- **refactoring-integrity**: The engineer consolidation is a genuine merge of overlapping roles, not a cosmetic rename.

### Tests to write

No new tests. Existing tests should pass since agent definitions are configuration, not code.

### Verify

1. `agents/canon-engineer.md` exists with union tool list, correct skills, maxTurns 50, permissionMode auto
2. `agents/canon-implementor.md` and `agents/canon-fixer.md` are deleted
3. All 12 agent files have `maxTurns`, `permissionMode`, and `skills` in YAML frontmatter
4. YAML frontmatter parses for all agents: `for f in agents/canon-*.md; do python3 -c "import yaml; yaml.safe_load(open('$f').read().split('---')[1])"; done`
5. No runtime `Read ${CLAUDE_PLUGIN_ROOT}/rules/` instructions remain in agent bodies
6. `agents/.claude/CLAUDE.md` roster table updated to show 12 agents with canon-engineer
7. `npm run build` passes
8. `npm test` passes

### Done when

- 12 agent definitions (not 13) with complete frontmatter
- canon-engineer merges both instruction sets with dual-mode operation
- All skills in the preload map are referenced
- All runtime Read instructions for rules removed
- Build and tests pass
