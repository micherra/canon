---
description: Author a new Canon routine interactively
argument-hint: <name> [--private]
allowed-tools: [Read, Write, Edit, Bash, Glob, Agent]
model: sonnet
---

Thin router for Canon routine authoring.

Authority model:
- `agents/writer.md` owns authoring behavior, interview logic, and lint rules
- `templates/routine.md` is the source of truth for file structure
- This command should not duplicate authoring or validation policy

## Instructions

### Step 1: Spawn the writer

Launch the writer agent:

"Mode: routine. ${ARGUMENTS}"

If no arguments, ask the user what the routine should be named. A routine name should be kebab-case (e.g., `daily-drift-report`).

### Step 2: Delegate completely

Do not restate authoring rules here. Let writer:
- read `templates/routine.md`
- conduct the interview with the user
- apply guardrail-floor and binding-override-coherence lint rules before saving
- write the routine to `routines/<name>.md` (or `.canon/routines/<name>.md` if `--private`)

### Step 3: Confirm changes

After the agent completes, confirm to the user:
- The routine name and where the file was saved
- The resolved `binding_target` (cloud-routine or desktop-task)
- The guardrail settings (`repo_writes`, `consent`)
- Suggest running `/canon:check` to verify the authored routine passes lint
