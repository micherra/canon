---
description: Author a new Canon engineering principle interactively
argument-hint: [principle description or topic]
allowed-tools: [Read, Write, Bash, Glob, Agent]
---

Create a new Canon engineering principle using the canon-principle-writer agent. The agent will interview you about the principle, generate examples, and produce a properly formatted principle file.

## Instructions

### Step 1: Spawn the principle writer

Launch the canon-principle-writer agent. If ${ARGUMENTS} contains a description, pass it as the starting context:

"The user wants to create a new Canon principle about: ${ARGUMENTS}"

If no arguments, the agent will ask what principle the user wants to create.

### Step 2: Let the agent work

The canon-principle-writer will:
1. Ask clarifying questions about the constraint, failure mode, scope, and severity
2. Generate good and bad code examples
3. Ask the user to validate the examples
4. Produce the principle file in Canon format
5. Save to `.canon/principles/{id}.md`
6. Validate the file against the principle matcher

### Step 3: Confirm creation

After the agent completes, confirm to the user:
- The principle file was created at `.canon/principles/{id}.md`
- Show the principle's id, title, and severity
- Suggest running `/canon:list` to see it in the index
- Note that compliance will be tracked automatically: "This principle will be evaluated during code reviews (`/canon:review`, `/canon:build`) and tracked in drift reports (`/canon:drift`). Run `/canon:learn --drift` after 10+ reviews to see data-driven severity recommendations."
