---
description: Author a new Canon engineering principle interactively
argument-hint: [principle description or topic]
allowed-tools: [Read, Write, Bash, Glob, Agent]
---

Create a new Canon engineering principle using the canon-writer agent in **new-principle** mode.

## Instructions

### Step 1: Spawn the writer

Launch the canon-writer agent:

"Mode: new-principle. The user wants to create a new Canon principle about: ${ARGUMENTS}"

If no arguments, the agent will ask what principle the user wants to create.

### Step 2: Let the agent work

The canon-writer will:
1. Ask clarifying questions about the constraint, failure mode, scope, and severity
2. Generate good and bad code examples
3. Ask the user to validate the examples
4. Check for conflicts with existing principles
5. Save to `.canon/principles/{severity-subdir}/{id}.md`
6. Validate the file

### Step 3: Confirm creation

After the agent completes, confirm to the user:
- The principle file was created at `.canon/principles/{severity-subdir}/{id}.md`
- Show the principle's id, title, and severity
- Suggest running `/canon:list` to see it in the index
- Note that compliance will be tracked automatically: "This principle will be evaluated during code reviews (`/canon:review`, `/canon:build`). Run `/canon:learn --drift` after 10+ reviews to see data-driven severity recommendations."
