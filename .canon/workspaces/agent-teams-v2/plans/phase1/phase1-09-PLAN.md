---
task_id: "phase1-09"
wave: 3
depends_on:
  - "phase1-07"
  - "phase1-08"
files:
  - skills/canon/runbooks/fast-path.yaml
  - skills/canon/runbooks/feature.yaml
  - skills/canon/runbooks/refactor.yaml
  - skills/canon/runbooks/epic.yaml
  - skills/canon/runbooks/migrate.yaml
  - skills/canon/runbooks/test-gap.yaml
  - skills/canon/runbooks/review-only.yaml
  - skills/canon/runbooks/security-audit.yaml
  - skills/canon/runbooks/explore.yaml
  - skills/canon/runbooks/adopt.yaml
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
  - CLAUDE.md
principles:
  - refactoring-integrity
domains: []
---

## Task: Cross-artifact validation and consistency check

### Action

This is a validation task. No new files are created. Review all Phase 1 artifacts for consistency and completeness.

**Checks to perform:**

#### 1. Runbook-to-flow coverage audit

For each of the 10 runbooks, verify that every non-terminal state in the corresponding legacy flow definition is represented as a step in the runbook.

| Runbook | Legacy flow file | Expected states |
|---------|-----------------|-----------------|
| fast-path | flows/fast-path.md | execute, pre-launch-check, ship, learn |
| feature | flows/feature.md | design, implement, context-sync, verify, fix-impl, review, fix-violations, pre-launch-check, ship, learn, checkpoint |
| refactor | flows/refactor.md | analyze, implement, verify, fix-impl, context-sync, review, fix-violations, pre-launch-check, ship, learn, checkpoint |
| epic | flows/epic.md | research, design, implement, context-sync, test, fix-impl, security, fix-security, review, fix-violations, pre-launch-check, ship, learn |
| migrate | flows/migrate.md | research, design, implement, verify, fix-impl, security, fix-security, context-sync, review, fix-violations, pre-launch-check, ship, learn |
| test-gap | flows/test-gap.md | scan, write-tests, fix-impl, review, fix-violations |
| review-only | flows/review-only.md | review |
| security-audit | flows/security-audit.md | security, review |
| explore | flows/explore.md | research, synthesize |
| adopt | flows/adopt.md | scan, fix, rescan |

For each pair, read the flow file, list all states (including fragment-included states), and compare against the runbook step IDs. Flag any mismatches.

#### 2. Agent definition consistency check

For all 13 agent definitions:
- Verify `maxTurns` and `permissionMode` fields are present in YAML frontmatter
- Verify `permissionMode: plan` is set for read-only agents (researcher, architect, reviewer, security, chat, guide)
- Verify `permissionMode: auto` is set for write agents (implementor, tester, fixer, scribe, shipper, learner, writer)
- Verify existing `tools` lists are unchanged
- Verify no markdown body content was modified

#### 3. CLAUDE.md section check

- Verify the legacy section heading includes "(CANON_AGENT_TEAMS_MODE=off)"
- Verify the agent-teams section heading includes "(CANON_AGENT_TEAMS_MODE=on)"
- Verify the agent-teams section has all six subsections
- Verify no other CLAUDE.md sections were modified

#### 4. YAML validity check

Run YAML parse on all 10 runbook files:
```bash
for f in skills/canon/runbooks/*.yaml; do
  python3 -c "import yaml; yaml.safe_load(open('$f'))" && echo "OK: $f" || echo "FAIL: $f"
done
```

#### 5. Build/test check

```bash
cd mcp-server && npm run build && npm test
```

Confirm zero new errors, zero new test failures.

#### 6. Legacy path byte-identity check

With `CANON_AGENT_TEAMS_MODE` unset (or `off`):
- The existing "Driving the State Machine" section content is unchanged (only the heading was updated)
- No TypeScript files were modified
- `drive_flow` behavior is byte-identical to pre-Phase-1

### Canon principles to apply

- **refactoring-integrity**: Phase 1 is additions-only. This check verifies no existing behavior was altered.

### Tests to write

No new tests. This task runs existing tests as verification.

### Verify

1. All 10 runbooks cover all states from their legacy flows
2. All 13 agent defs have correct frontmatter fields
3. CLAUDE.md has both annotated sections
4. All runbooks parse as valid YAML
5. `npm run build` and `npm test` pass
6. No TypeScript files were modified in Phase 1

### Done when

- Cross-artifact validation passes all 6 checks
- Any issues found are documented for the implementor to fix before Phase 1 is marked complete
- A validation report is saved to `${WORKSPACE}/plans/phase1/VALIDATION-REPORT.md`
