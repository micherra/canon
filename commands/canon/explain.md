---
description: Explain a Canon principle with real examples from your codebase
argument-hint: <principle-id>
allowed-tools: [Read, Glob, Grep]
---

Load a Canon principle by ID and illustrate it with real examples from the user's codebase. Shows where the principle is honored and where it may be violated. Does NOT modify any files — this is a read-only educational command.

## Instructions

### Step 1: Parse arguments

Extract the principle ID from ${ARGUMENTS}. The argument should be a kebab-case principle ID like `thin-handlers` or `errors-are-values`.

If no argument is provided, glob for `*.md` files in `.canon/principles/` (or `${CLAUDE_PLUGIN_ROOT}/principles/`), read their frontmatter, and list the available principle IDs for the user to choose from.

### Step 2: Find and load the principle

Look for `{PRINCIPLE_ID}.md` in `.canon/principles/` first, then `${CLAUDE_PLUGIN_ROOT}/principles/`.

If not found, tell the user:
"No principle found with ID '${PRINCIPLE_ID}'. Run `/canon:list` to see available principles."

Read the full principle file — frontmatter and body.

### Step 3: Find applicable files in the codebase

Use the principle's scope (layers, file_patterns) to find files where it applies.

If the principle has `file_patterns`, glob for those directly. Otherwise, find source files in directories that match the layer scope (e.g., `**/api/**` for layer `api`). Limit to 20 files.

### Step 4: Search for violation patterns

Read the principle's `## Examples` section. From the "Bad" examples, identify signature code patterns — function shapes, import patterns, naming conventions, structural anti-patterns.

Search the codebase for those patterns using targeted grep queries. The specific patterns depend on the principle:

- **thin-handlers**: Look for database calls, complex logic, or long functions in handler/controller/route files
- **errors-are-values**: Look for `throw new` in domain/service files where result types should be used
- **naming-reveals-intent**: Look for vague names like `processData`, `handleResult`, `utils.ts`
- **secrets-never-in-code**: Look for hardcoded strings matching API key/password patterns
- **information-hiding**: Look for the same constants, formats, or field names repeated across multiple files
- **deep-modules**: Look for classes/modules with many small pass-through methods

For principles not listed above, derive patterns from the "Bad" example code.

Read the matching files to confirm whether the pattern is actually a violation (grep hits can be false positives).

### Step 5: Search for compliance patterns

Similarly, from the "Good" examples, identify the target patterns and search for them.

Read matching files to confirm they genuinely honor the principle.

### Step 6: Present the explanation

Format the output as:

```markdown
## Principle: {title}

**ID**: {id} | **Severity**: {severity} | **Tags**: {tags}
**Scope**: Layers: {layers or "all"}

### What It Says
{The principle's summary paragraph — the falsifiable constraint}

### Why It Matters
{The principle's rationale section}

---

### In Your Codebase

#### ✓ Honored
{Up to 3 examples of files where the principle is followed}

**{file-path}** (lines {N-M})
```{language}
{code snippet, ≤20 lines}
```
Why this is good: {brief explanation tied to the principle}

#### ✗ Potential Violations
{Up to 3 examples of files where the principle may be violated}

**{file-path}** (lines {N-M})
```{language}
{code snippet, ≤20 lines}
```
What to change: {brief suggestion based on the principle's good examples}

#### No Examples Found
{If neither honored nor violated examples were found:}
No clear examples found in the scanned files. This may mean the principle
doesn't apply to this codebase's domain, or the scope didn't match your
file structure.

---

### Canonical Examples (from the principle)
{Include the principle's own Examples section for reference}

### Exceptions
{Include the principle's Exceptions section}

---
Files scanned: N | Honored: N | Potentially violated: N
To fix violations: `/canon:review {file-path}` or spawn canon-refactorer
To see all principles: `/canon:list`
```

### Important constraints

- This command is **read-only**. It MUST NOT modify any files.
- Limit code snippets to ≤20 lines each to keep output scannable.
- Show at most 3 honored examples and 3 violated examples.
- If the principle has no `## Examples` section, show the principle body with the list of applicable files but skip the codebase search.
- Always include line numbers in code snippets for reference.
