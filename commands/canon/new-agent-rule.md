---
description: Author a new Canon agent-rule interactively
argument-hint: [agent-rule description or topic]
allowed-tools: [Read, Write, Bash, Glob, Agent]
---

Create a new Canon agent-rule using the canon-writer agent in **new-agent-rule** mode.

## Instructions

### Step 1: Spawn the writer

Launch the canon-writer agent:

"Mode: new-agent-rule. The user wants to create a new Canon agent-rule about: ${ARGUMENTS}"

If no arguments, the agent will ask what agent behavior the user wants to constrain.

### Step 2: Let the agent work

The canon-writer will:
1. Ask clarifying questions about the constraint, target agent(s), failure mode, and severity
2. Generate good and bad examples of agent behavior
3. Ask the user to validate the examples
4. Check for conflicts with existing agent-rules
5. Save to the appropriate location (plugin or project-local)
6. Validate the file format

### Step 3: Confirm creation

After the agent completes, confirm to the user:
- The agent-rule file was created and where it was saved
- Show the agent-rule's id, title, severity, and target agent(s)
- Suggest running `/canon:list` to see it in the index
- Note that the rule will be loaded during agent workflows: "This agent-rule will be loaded by the target agent(s) during `/canon:build` and other workflows. It constrains agent behavior, not application code."
