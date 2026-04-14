---
task_id: "phase1-00"
wave: 1
depends_on: []
files:
  - skills/canon/runbooks/_schema.yaml
principles:
  - agent-plans-are-prompts
  - agent-design-before-code
domains:
  - orchestration
---

## Task: Define the canonical runbook YAML schema

### Action

Create `skills/canon/runbooks/_schema.yaml` — a fully commented YAML file that serves as both documentation and a structural reference for all runbooks authored in Wave 1.

1. Create the directory `skills/canon/runbooks/` if it does not exist.
2. Write `_schema.yaml` with the following top-level fields, each with inline YAML comments explaining purpose and constraints:

```yaml
# Canon Runbook Schema — canonical commented example
# All runbooks in skills/canon/runbooks/*.yaml must conform to this structure.
# Runbooks are NOT executable — Claude reads them as guidance playbooks.

name: "schema-example"           # kebab-case, matches filename without .yaml
description: "One-line purpose"  # Human-readable, shown in runbook index
tier: "medium"                   # small | medium | large — maps to flow tiers

# Steps are ordered. Claude follows them sequentially unless skip_when applies.
steps:
  - id: "research"              # Unique within this runbook. kebab-case.
    agent: "canon-researcher"   # Agent definition name from agents/*.md
    dispatch: "subagent"        # subagent | team — how Claude spawns this step
                                #   subagent: single focused agent, returns result to lead
                                #   team: agent team with shared task list (parallel wave)
    mcp_tools:                  # MCP tools the lead should call BEFORE spawning this step
      - get_principles          # Compose principle context for the agent
      - get_file_context        # KG file summaries for target files
      - graph_query             # Dependency/blast-radius queries
    artifacts:                  # Expected output paths (relative to workspace)
      - "research/${role}.md"   # Lead verifies these exist after step completes
    hitl: "none"                # none | approval | checkpoint | on_failure
                                #   none: no user interaction
                                #   approval: present result for user approval before next step
                                #   checkpoint: present summary, continue unless user objects
                                #   on_failure: present to user only if step fails/blocks
    skip_when: null             # null (never skip) or a condition string:
                                #   "no_contract_changes" — skip if no API/contract changes
                                #   "learn_gate_not_passed" — skip if learn gate fails
                                #   "no_open_questions" — skip if no questions from prior step
                                #   "no_fix_requested" — skip if user didn't request fixes
                                #   Claude evaluates these conditions by judgment, not code.
    notes: |                    # Free-form guidance for the lead. Injected into spawn context.
      Optional notes about this step — constraints, tips, things to watch for.
      Markdown allowed. Keep under 200 words.
```

3. Include a second example step in the same file showing `dispatch: team` with wave-specific fields:

```yaml
  - id: "implement"
    agent: "canon-implementor"
    dispatch: "team"            # Agent team — parallel wave execution
    mcp_tools:
      - get_principles
      - get_file_context
      - log_step                # Orchestration journal — log before spawning
    artifacts:
      - "plans/${slug}/${task_id}-SUMMARY.md"
    hitl: "none"
    skip_when: null
    notes: |
      Wave step. The lead creates an agent team from the plan index.
      Each teammate claims one task from the shared task list.
      TaskCompleted hooks enforce artifact production.
```

4. Add a trailing comment block documenting:
   - Field optionality (which fields are required vs optional)
   - How `mcp_tools` maps to the lead's pre-spawn composition (§2.2 of migration plan)
   - How `artifacts` maps to post-subagent verification (§2.8 layer 7)
   - How `hitl` maps to native Claude HITL patterns
   - That `skip_when` is evaluated by Claude's judgment, not pattern-matched code

### Canon principles to apply
- **agent-plans-are-prompts**: The schema itself is a prompt for implementors — every field must be self-documenting via comments. No separate prose doc needed.
- **agent-design-before-code**: This schema defines the contract for all 10 runbooks. Get it right before Wave 1 proceeds.

### Tests to write
- No code tests — this is a YAML documentation artifact.
- Manual verification: the schema must parse as valid YAML (`node -e "require('js-yaml').load(require('fs').readFileSync('skills/canon/runbooks/_schema.yaml'))"` or equivalent).

### Verify
1. File exists at `skills/canon/runbooks/_schema.yaml`
2. File parses as valid YAML without errors
3. All fields from the spec above are present with comments
4. `npm run build` still passes (no TypeScript changes)
5. `npm test` still passes (no test changes)

### Done when
- `skills/canon/runbooks/_schema.yaml` exists, parses as valid YAML, and documents every runbook field with inline comments
- A second implementor could read only this file and produce a conformant runbook without additional guidance
- Build and tests pass unchanged
