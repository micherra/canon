---
task_id: "phase1-07"
wave: 2
depends_on:
  - "phase1-01"
  - "phase1-02"
  - "phase1-03"
  - "phase1-04"
  - "phase1-05"
  - "phase1-06"
files:
  - agents/canon-researcher.md
  - agents/canon-architect.md
  - agents/canon-implementor.md
  - agents/canon-reviewer.md
  - agents/canon-tester.md
  - agents/canon-security.md
  - agents/canon-fixer.md
  - agents/canon-scribe.md
  - agents/canon-shipper.md
  - agents/canon-learner.md
  - agents/canon-chat.md
  - agents/canon-guide.md
  - agents/canon-writer.md
principles:
  - least-privilege-access
  - simplicity-first
domains: []
---

## Task: Update agent definitions with subagent/teammate frontmatter fields

### Action

Add `maxTurns` and `permissionMode` frontmatter fields to all 13 agent definitions. These fields enable richer dispatch when `CANON_AGENT_TEAMS_MODE=on`. They have no effect on the legacy `drive_flow` path (which does not read them).

**For each agent, add these fields to the YAML frontmatter (between the `---` delimiters):**

#### canon-researcher
```yaml
maxTurns: 20
permissionMode: plan
```
Rationale: Researchers are read-only investigation agents. Low turn budget (20) because research should be focused. `plan` mode prevents writes.

#### canon-architect
```yaml
maxTurns: 30
permissionMode: plan
```
Rationale: Architects design but do not write code. Medium turn budget (30) for complex design tasks with competitive synthesis. `plan` mode prevents writes (architect uses Write only for plan files, which are in the workspace -- but `plan` mode allows this via plan approval).

#### canon-implementor
```yaml
maxTurns: 50
permissionMode: auto
```
Rationale: Implementors need the highest turn budget for implementation + testing + commits. `auto` mode allows writes without prompting.

#### canon-reviewer
```yaml
maxTurns: 25
permissionMode: plan
```
Rationale: Reviewers read code and produce review artifacts. Medium turn budget. `plan` mode prevents writes.

#### canon-tester
```yaml
maxTurns: 40
permissionMode: auto
```
Rationale: Testers write test files and run test suites. High turn budget for writing tests + running them + iterating. `auto` mode allows writes.

#### canon-security
```yaml
maxTurns: 25
permissionMode: plan
```
Rationale: Security agents scan and report. Do not write code. `plan` mode prevents writes.

#### canon-fixer
```yaml
maxTurns: 35
permissionMode: auto
```
Rationale: Fixers write code to fix issues. Medium-high turn budget. `auto` mode allows writes.

#### canon-scribe
```yaml
maxTurns: 15
permissionMode: auto
```
Rationale: Scribes update documentation files. Low turn budget (documentation updates are focused). `auto` mode for writes (Edit tool needed).

#### canon-shipper
```yaml
maxTurns: 20
permissionMode: auto
```
Rationale: Shippers synthesize artifacts and may create PRs. Low-medium turn budget. `auto` mode for writes and Bash (git, gh).

#### canon-learner
```yaml
maxTurns: 25
permissionMode: auto
```
Rationale: Learners analyze patterns and write proposal files. Medium turn budget. `auto` mode for writes.

#### canon-chat
```yaml
maxTurns: 30
permissionMode: plan
```
Rationale: Chat agents discuss but do not write code. Medium turn budget for extended conversations. `plan` mode prevents writes.

#### canon-guide
```yaml
maxTurns: 20
permissionMode: plan
```
Rationale: Guides are read-only. Low turn budget. `plan` mode prevents writes.

#### canon-writer
```yaml
maxTurns: 25
permissionMode: auto
```
Rationale: Writers create/edit principle files. Medium turn budget. `auto` mode for writes.

**Placement**: Add the new fields after the existing `tools:` field (or after the last existing frontmatter field if tools is not present). Maintain existing field order otherwise.

**Do NOT change**: Agent description, model, color, tools list, or any markdown body content.

### Canon principles to apply

- **least-privilege-access**: `permissionMode: plan` for read-only agents (researcher, architect, reviewer, security, chat, guide). `permissionMode: auto` only for agents that must write files.
- **simplicity-first**: Only two new fields per agent. No structural changes to agent definitions.

### Risk mitigations

- **Risk: Breaking legacy path** -- The legacy `drive_flow` path does not read `maxTurns` or `permissionMode` from agent definitions. It uses `tool-profiles.ts` for permission mode and flow YAML for iteration limits. Mitigation: Verify `npm test` passes after changes to confirm no parsing issues.
- **Risk: Incorrect turn budgets** -- Turn budgets may be too low or too high. Mitigation: These are Phase 1 guidance values, tunable in Phase 2 based on validation results. Start with conservative estimates.

### Tests to write

No new tests. Existing tests should continue to pass since only frontmatter fields are added.

### Verify

1. All 13 agent files have `maxTurns` and `permissionMode` in their YAML frontmatter
2. YAML frontmatter still parses correctly for all files: `python3 -c "import yaml; yaml.safe_load(open('agents/canon-researcher.md').read().split('---')[1])"`
3. `npm run build` passes (no TypeScript changes, but verify nothing depends on strict agent frontmatter parsing)
4. `npm test` passes
5. Existing agent markdown body content is unchanged (diff shows only frontmatter additions)

### Done when

- All 13 agent definitions have `maxTurns` and `permissionMode` fields
- Values follow the least-privilege-access principle
- No other changes to agent files
- `npm run build` and `npm test` pass
