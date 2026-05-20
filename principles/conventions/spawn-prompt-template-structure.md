---
id: spawn-prompt-template-structure
title: Spawn-Prompt Templates Use Variables-Prompt Structure
severity: convention
tags: [templates, orchestrator, agent-spawn]
scope:
  file_patterns:
    - "templates/worker-prompt.md"
    - "templates/renderer-*.md"
---

Templates representing spawn prompts (used by the orchestrator to build an `Agent()` call, not by agents to shape output) follow this structure:

1. **YAML frontmatter** with fields: `template`, `description`, `used-by: [orchestrator]`, `read-by: [<agent-type>]`, `output-path: <artifact-path>`
2. **`## Variables` section** — one bullet per `${VARIABLE}` placeholder with a one-line description
3. **`## Prompt` section** — the literal spawn prompt inside a fenced code block (no language tag), with `${VARIABLE}` references for orchestrator-injected values
4. **`## Template Notes` section** — guidance for the orchestrator (not the agent): who substitutes variables, graceful degradation, boundary constraints

The `used-by: [orchestrator]` frontmatter field is the type discriminator. Artifact-output templates have `used-by: [engineer]`, `used-by: [reviewer]`, etc.

## Rationale

4/4 spawn-prompt templates (prior to renderer-planning-brief.md deletion; 3/3 surviving) independently converged on this structure. The pattern is mechanically enforced by CLAUDE.md's Renderer Spawn Protocol ("read the template, fill Variables, pass Prompt block to Agent()"). Codifying it prevents a future template author from inventing an incompatible structure.

## Examples

**Good — spawn-prompt template following the convention:**

```markdown
---
template: renderer-design
description: Renderer spawn prompt for design.html
used-by: [orchestrator]
read-by: [renderer]
output-path: ${WORKSPACE}/artifacts/design.html
---

## Variables
- `${WORKSPACE}` — Canon workspace root path
- `${SLUG}` — Build slug identifier

## Prompt
` `` (triple backticks in practice)
You are a renderer agent...
...${WORKSPACE}/artifacts/design.html...
` ``

## Template Notes
The orchestrator fills all Variables before passing the Prompt block.
```

**Bad — spawn-prompt template missing the structure:**

```markdown
# Renderer Design Prompt

Render the design document at ${WORKSPACE}/plans/${SLUG}/DESIGN.md to HTML.
Save to ${WORKSPACE}/artifacts/design.html.
```

This is bad because: no Variables section (orchestrator doesn't know what to fill), no fenced code block (orchestrator can't extract the prompt), no frontmatter (no type discriminator).

## Exceptions

None. All spawn-prompt templates follow this structure. Artifact-output templates (design-document.md, task-plan.md, implementation-log.md, etc.) use a different structure and are NOT subject to this convention.
