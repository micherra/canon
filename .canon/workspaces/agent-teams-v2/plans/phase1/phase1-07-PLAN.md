---
task_id: "phase1-07"
wave: 2
depends_on: []
files:
  - rules/agent-context-check.md
  - skills/canon/references/agent-tdd-required.md
  - skills/canon/references/agent-fresh-context.md
  - skills/canon/references/agent-structured-triage.md
  - skills/canon/references/agent-simplify-before-extending.md
  - skills/canon/references/agent-cold-review.md
  - skills/canon/references/agent-assume-hostile-input.md
  - skills/canon/references/agent-design-before-code.md
  - skills/canon/references/agent-plans-are-prompts.md
  - skills/canon/references/agent-surface-assumptions.md
  - skills/canon/references/agent-scoped-research.md
  - skills/canon/references/agent-evidence-over-intuition.md
  - skills/canon/references/agent-minimal-fix.md
  - skills/canon/references/agent-test-the-contract.md
  - skills/canon/references/agent-test-sad-paths.md
  - skills/canon/references/agent-context-sync.md
  - skills/canon/references/agent-missing-artifact.md
  - skills/canon/references/agent-artifacts-only.md
  - skills/canon/references/agent-template-required.md
  - skills/canon/references/agent-context-check.md
principles:
  - agent-plans-are-prompts
domains:
  - orchestration
---

## Task: Register rules as skills and create agent-context-check rule

### Action

This task makes Canon rules available as Claude Code skills for preloading into agent definitions. It also creates the new `agent-context-check` rule described in §2.5 of the migration plan.

#### Part 1: Create `agent-context-check` rule

Create `rules/agent-context-check.md` with the following content structure:

```markdown
---
id: agent-context-check
severity: rule
scope: all
tags: [agent-behavior, context, self-serve]
---

# agent-context-check

## Summary
Before starting work, verify you have Canon principles for your target files. If context is missing, self-serve via MCP tools.

## Body
[Full rule text — see content specification below]

## Exceptions
- Agents that do not have Canon MCP tools in their tools allowlist are exempt.
- The learn and ship steps where principle loading is not applicable.
```

The rule body must instruct agents to:
1. Check whether the spawn prompt includes a `## Principles` section with matched principles for the target files.
2. If principles are missing, call `get_principles` with the target file path and task description.
3. If file context or dependency information is needed and not provided, call `get_file_context` or `graph_query` directly.
4. This is a fallback path — the lead's pre-spawn composition is the primary context channel. Self-serve only fills gaps.

#### Part 2: Symlink rules into skills/canon/references/

For each rule file in the preload map (from `/tmp/canon-skills-research.md`), create a symlink from `skills/canon/references/{rule-name}.md` pointing to `../../../rules/{rule-name}.md`.

Rules to symlink (18 rules from the preload map, plus `agent-context-check`):

```bash
cd skills/canon/references/

# Role-specific rules
ln -sf ../../../rules/agent-tdd-required.md agent-tdd-required.md
ln -sf ../../../rules/agent-fresh-context.md agent-fresh-context.md
ln -sf ../../../rules/agent-structured-triage.md agent-structured-triage.md
ln -sf ../../../rules/agent-simplify-before-extending.md agent-simplify-before-extending.md
ln -sf ../../../rules/agent-cold-review.md agent-cold-review.md
ln -sf ../../../rules/agent-assume-hostile-input.md agent-assume-hostile-input.md
ln -sf ../../../rules/agent-design-before-code.md agent-design-before-code.md
ln -sf ../../../rules/agent-plans-are-prompts.md agent-plans-are-prompts.md
ln -sf ../../../rules/agent-surface-assumptions.md agent-surface-assumptions.md
ln -sf ../../../rules/agent-scoped-research.md agent-scoped-research.md
ln -sf ../../../rules/agent-evidence-over-intuition.md agent-evidence-over-intuition.md
ln -sf ../../../rules/agent-minimal-fix.md agent-minimal-fix.md
ln -sf ../../../rules/agent-test-the-contract.md agent-test-the-contract.md
ln -sf ../../../rules/agent-test-sad-paths.md agent-test-sad-paths.md
ln -sf ../../../rules/agent-context-sync.md agent-context-sync.md
ln -sf ../../../rules/agent-missing-artifact.md agent-missing-artifact.md
ln -sf ../../../rules/agent-artifacts-only.md agent-artifacts-only.md
ln -sf ../../../rules/agent-template-required.md agent-template-required.md

# New rule
ln -sf ../../../rules/agent-context-check.md agent-context-check.md
```

#### Part 3: Verify all skill names from preload map exist

Cross-reference the preload map from `/tmp/canon-skills-research.md` against actual files in `skills/canon/references/`. Every skill name referenced must resolve to an existing file.

Preload map skill names to verify:

| Skill name | Expected file |
|-----------|---------------|
| `agent-tdd-required` | `skills/canon/references/agent-tdd-required.md` |
| `agent-fresh-context` | `skills/canon/references/agent-fresh-context.md` |
| `agent-structured-triage` | `skills/canon/references/agent-structured-triage.md` |
| `agent-simplify-before-extending` | `skills/canon/references/agent-simplify-before-extending.md` |
| `agent-cold-review` | `skills/canon/references/agent-cold-review.md` |
| `agent-assume-hostile-input` | `skills/canon/references/agent-assume-hostile-input.md` |
| `agent-design-before-code` | `skills/canon/references/agent-design-before-code.md` |
| `agent-plans-are-prompts` | `skills/canon/references/agent-plans-are-prompts.md` |
| `agent-surface-assumptions` | `skills/canon/references/agent-surface-assumptions.md` |
| `agent-scoped-research` | `skills/canon/references/agent-scoped-research.md` |
| `agent-evidence-over-intuition` | `skills/canon/references/agent-evidence-over-intuition.md` |
| `agent-minimal-fix` | `skills/canon/references/agent-minimal-fix.md` |
| `agent-test-the-contract` | `skills/canon/references/agent-test-the-contract.md` |
| `agent-test-sad-paths` | `skills/canon/references/agent-test-sad-paths.md` |
| `agent-context-sync` | `skills/canon/references/agent-context-sync.md` |
| `agent-missing-artifact` | `skills/canon/references/agent-missing-artifact.md` |
| `agent-artifacts-only` | `skills/canon/references/agent-artifacts-only.md` |
| `agent-template-required` | `skills/canon/references/agent-template-required.md` |
| `agent-context-check` | `skills/canon/references/agent-context-check.md` |
| `principle-loading` | `skills/canon/references/principle-loading.md` (already exists) |
| `status-protocol` | `skills/canon/references/status-protocol.md` (already exists) |
| `tester-report-template` | `skills/canon/references/tester-report-template.md` (already exists) |
| `security-checklist` | `skills/canon/references/security-checklist.md` (already exists) |
| `learner-dimensions` | `skills/canon/references/learner-dimensions.md` (already exists) |
| `principle-format` | `skills/canon/references/principle-format.md` (already exists) |
| `writer-worked-example` | `skills/canon/references/writer-worked-example.md` (already exists) |
| `guide-dashboards` | `skills/canon/references/guide-dashboards.md` (already exists) |
| `workspace-logging` | `skills/canon/references/workspace-logging.md` (already exists) |

Run verification:
```bash
for skill in agent-tdd-required agent-fresh-context agent-structured-triage \
  agent-simplify-before-extending agent-cold-review agent-assume-hostile-input \
  agent-design-before-code agent-plans-are-prompts agent-surface-assumptions \
  agent-scoped-research agent-evidence-over-intuition agent-minimal-fix \
  agent-test-the-contract agent-test-sad-paths agent-context-sync \
  agent-missing-artifact agent-artifacts-only agent-template-required \
  agent-context-check principle-loading status-protocol tester-report-template \
  security-checklist learner-dimensions principle-format writer-worked-example \
  guide-dashboards workspace-logging; do
  if [ ! -e "skills/canon/references/${skill}.md" ]; then
    echo "MISSING: ${skill}"
  fi
done
```

### Canon principles to apply
- **agent-plans-are-prompts**: The `agent-context-check` rule IS a prompt — it must be actionable and specific about when and how to self-serve context.

### Tests to write
- No code tests — this task creates markdown files and symlinks only.

### Verify
1. `rules/agent-context-check.md` exists with proper frontmatter (id, severity: rule, scope: all)
2. All 19 symlinks exist in `skills/canon/references/` and resolve to valid files
3. All 28 skill names from the preload map resolve to existing files in `skills/canon/references/`
4. Existing references (principle-loading, status-protocol, etc.) are unchanged
5. Symlinks point to correct relative paths (`../../../rules/{name}.md`)
6. `npm run build` passes (no TypeScript changes)
7. `npm test` passes (no test changes)

### Done when
- `rules/agent-context-check.md` exists with self-serve context instructions
- 19 symlinks created in `skills/canon/references/` pointing to rule files
- All 28 preload map skill names verified as resolvable files
- No existing references modified
- Build and tests pass unchanged
