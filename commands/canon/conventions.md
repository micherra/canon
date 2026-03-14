---
description: View and update project-level Canon conventions
argument-hint: [--add "convention text"] [--remove N] [--show]
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

View and update the project-level `.canon/CONVENTIONS.md` file. Conventions are concrete patterns and decisions that implementor agents read alongside Canon principles.

## Instructions

### Step 1: Parse arguments

Extract flags from ${ARGUMENTS}:
- `--show` (default if no flag): Display current conventions
- `--add "text"`: Append a convention
- `--remove N`: Remove convention by line number
- No arguments: same as `--show`

### Step 2: Locate conventions file

Check for `.canon/CONVENTIONS.md` in the project root.

If it doesn't exist and the action is `--show`, tell the user:
"No project conventions file found. Run `/canon:init` to create one, or `/canon:conventions --add "..."` to create it with your first convention."

If it doesn't exist and the action is `--add`, create it with the starter template first (see Step 4).

### Step 3: Handle --show (default)

Read and display `.canon/CONVENTIONS.md`. Format the output clearly:

```markdown
## Project Conventions

{contents of .canon/CONVENTIONS.md}

---
{N} convention(s) defined.
To add: `/canon:conventions --add "Use result types for error handling"`
To remove: `/canon:conventions --remove 3`
```

If the file exists but has no conventions (only the template comments), tell the user:
"No conventions defined yet. Add one with `/canon:conventions --add "..."`"

### Step 4: Handle --add

If `.canon/CONVENTIONS.md` doesn't exist, create it with:

```markdown
## Project Conventions

> Project-specific patterns and decisions. Updated as the project evolves.
> Implementor agents read this file alongside Canon principles.

```

Then append the new convention as a bullet:
```
- **{category}**: {detail}
```

If the user provides text in the format "Category: detail", parse it into bold category + detail. Otherwise, add it as a plain bullet.

After adding, display the updated file and confirm:
"Added convention. Implementor and refactorer agents will see this in their next session."

### Step 5: Handle --remove

Read the file, identify the convention at line N (counting only convention bullet lines, not headers or blank lines), remove it, and write the file back.

After removing, display the updated file and confirm:
"Removed convention #{N}."

### Important constraints

- This command manages **project-level** conventions only (`.canon/CONVENTIONS.md`)
- Task-level conventions (`.canon/plans/{slug}/CONVENTIONS.md`) are created by the canon-architect agent during builds
- Keep conventions concrete — patterns, not philosophy
- Each convention should be ≤1 line
- Warn if the file exceeds 20 conventions (suggest consolidating)
