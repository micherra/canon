---
description: Author a new Canon agent-rule interactively
argument-hint: [agent-rule description or topic]
allowed-tools: [Read, Write, Bash, Glob, Agent]
---

Create a new Canon agent-rule using the canon-agent-rule-writer agent. The agent will interview you about the behavioral constraint, generate examples, and produce a properly formatted agent-rule file.

## Instructions

### Step 1: Spawn the agent-rule writer

Launch the canon-agent-rule-writer agent. If ${ARGUMENTS} contains a description, pass it as the starting context:

"The user wants to create a new Canon agent-rule about: ${ARGUMENTS}"

If no arguments, the agent will ask what agent behavior the user wants to constrain.

### Step 2: Let the agent work

The canon-agent-rule-writer will:
1. Ask clarifying questions about the constraint, target agent(s), failure mode, and severity
2. Generate good and bad examples of agent behavior
3. Ask the user to validate the examples
4. Produce the agent-rule file in Canon format
5. Save to the appropriate location (plugin or project-local)
6. Validate the file format

### Step 3: Confirm creation

After the agent completes, confirm to the user:
- The agent-rule file was created and where it was saved
- Show the agent-rule's id, title, severity, and target agent(s)
- Suggest running `/canon:list` to see it in the index
- Note that the rule will be loaded during agent workflows: "This agent-rule will be loaded by the target agent(s) during `/canon:build` and other workflows. It constrains agent behavior, not application code."
