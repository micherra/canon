---
name: write-principle
description: >-
  Principle, convention, and agent-rule authoring. Covers creation,
  editing, and applying accepted learner proposals. Handles interview,
  examples, conflict detection, format validation, and save. Loaded
  by the writer agent.
user-invocable: false
---

# Skill: write-principle

This skill defines the full procedural contract for creating, editing, and applying Canon principles, conventions, and agent-rules. You are the Canon Writer operating under this skill's guidance.

Core requirements:
- Encode behavior, not preferences. Every entry must define observable constraints and failure modes.
- Treat `${CLAUDE_PLUGIN_ROOT}/references/principle-format.md` as the single source of truth for file structure during both creation and editing.
- Do not infer or invent alternate section structure from existing files. Conform output to the format spec.

## Determine the mode

From the prompt you receive, determine the mode:

- **new-principle**: Creating a new principle (targets application code)
- **new-agent-rule**: Creating a new agent-rule (targets agent behavior)
- **edit**: Editing an existing principle or agent-rule
- **apply-proposal**: Applying an accepted learner proposal to create or update an entry
- **fork**: Copying a built-in principle to `.canon/principles/` for project-local customization

---

## Mode: new-principle / new-agent-rule

### Step 1: Understand the format

Read the principle format specification:
```
${CLAUDE_PLUGIN_ROOT}/references/principle-format.md
```

This specification is authoritative for required sections and ordering.

Read 2-3 existing entries as examples:
- For **new-principle**: Read from `${CLAUDE_PLUGIN_ROOT}/principles/` — pick entries from different severity subdirectories (`rules/`, `strong-opinions/`, `conventions/`)
- For **new-agent-rule**: Read from `${CLAUDE_PLUGIN_ROOT}/rules/` — pick 2-3 examples

### Step 2: Interview the user (if needed)

Ask only questions the user hasn't already answered. If the prompt includes the constraint, failure mode, and scope, skip to Step 3. Otherwise, ask **up to 3 targeted questions** to fill gaps from:

1. **The constraint** — What must be true?
   - For principles: "What engineering pattern or constraint do you want to encode?"
   - For agent-rules: "What agent behavior do you want to constrain?"
   - Follow up: "Can you state it as a rule that is either followed or not?"

2. **The failure mode** — What goes wrong when this is violated?
   - "What problems have you seen when this isn't followed?"

3. **The scope** — Where does this apply?
   - For principles:
     - "Which architectural layers? (api, ui, domain, data, infra, shared, or all?)"
     - "Any specific file patterns? (e.g., `**/api/**`)"
   - For agent-rules:
     - "Which Canon agent(s) should this rule apply to?" List the options:
       `architect`, `planner`, `engineer`, `tester`, `security`, `reviewer`, `scribe`, `shipper`, `learner`, `writer`, or `all`
     - "Does this rule apply to specific output files? (e.g., `.canon/plans/**`)"
     - Set `scope.layers` to `[]` (agent-rules don't target architectural layers)

4. **The severity** — How strictly should this be enforced?
   - Explain the three levels:
     - `rule`: Hard constraint — blocks commits (principles) or must always be followed (agent-rules)
     - `strong-opinion`: Default path — warn but don't block
     - `convention`: Stylistic preference — noted but not enforced
   - "Which severity fits?"

5. **Tags** — Freeform classification
   - Suggest relevant tags based on the content
   - For agent-rules: always include `agent-behavior` plus the target agent name(s)

### Step 3: Generate examples

Create at least one **bad** and one **good** example:
- For principles: realistic code examples
- For agent-rules: realistic agent behavior/output examples

Present to the user for validation:
- "Do these examples accurately represent what you mean?"
- "Would you change anything?"

### Step 4: Assemble the file

Produce the complete file with:
- YAML frontmatter (id, title, severity, scope, tags)
- Summary paragraph (falsifiable constraint)
- `## Rationale` section
- `## Examples` section (good and bad)
- `## Exceptions` section (when deviation is acceptable)
- `## Anti-Rationalization` section (table: excuse, why it's wrong, correct action)
- `## Verification` section (checklist with concrete compliance checks)

Generate a kebab-case `id` from the title. For agent-rules, prefix with `agent-`.
Ensure the final structure matches the format spec exactly.

### Worked Example

Read the complete worked example at `${CLAUDE_PLUGIN_ROOT}/references/writer-worked-example.md` to see a fully assembled principle file.

### Step 5: Check for conflicts

Use the `list_principles` MCP tool to load the index of all existing entries (metadata only — id, title, severity, tags, scope). This avoids loading full bodies into context.

Note: `list_principles` merges both tiers (project-local `.canon/principles/` and the portable `principles/` set). An ID collision against an entry in the *other* tier is an override-precedence situation (project-local always wins, enforced by `loadAllPrinciples` in `mcp-server/src/shared/matcher.ts`), not a true conflict — flag it informatively rather than as a blocking error.

For agent-rules, also glob `.canon/rules/*.md` and `${CLAUDE_PLUGIN_ROOT}/rules/*.md` and read only their frontmatter.

Check for:

1. **ID collision**: Another entry already uses this `id`? Warn that saving will override it.

2. **Scope overlap with contradictory advice**: Find entries with overlapping `scope.layers` or `scope.file_patterns`. If any give contradictory guidance, flag them:
   "This may conflict with `{other-id}` ({other-title}) — both apply to `{overlapping scope}`. Review them together."

3. **Duplicate coverage**: Same tags AND very similar scope? Flag as potential duplicate:
   "This looks similar to `{other-id}` ({other-title}). Consider extending that entry instead."

4. **Severity inconsistency**: A `convention`-severity entry overlapping with a `rule`-severity entry on the same topic? Flag the gap.

Present findings and ask whether to proceed, adjust, or cancel.

### Step 5.5: Detect context and determine tier

Before saving, run the two-part detection check defined in `${CLAUDE_PLUGIN_ROOT}/references/principle-tier-routing.md`:

> **Precondition**: run these checks from the repository/worktree root. `git ls-files principles/` resolves the pathspec relative to the current working directory — if run from a subdirectory it will return empty and detection will silently fall back to installed-copy.

<!-- keep in sync with references/principle-tier-routing.md -->
```sh
# tracked-source iff BOTH return non-empty / succeed:
git ls-files principles/ | head -1          # non-empty → principles/ is tracked here
test -d "$(git rev-parse --show-toplevel)/principles"  # principles/ lives under THIS worktree root
```

**If both checks pass** → **tracked-source context**. Apply the two-question classification test:

1. Would this principle constrain the code of a team using Canon for an entirely unrelated project? (No → project-specific)
2. Is it a specialization of an existing universal principle onto this project's own internals? (Yes → project-specific)

If neither condition holds → **universal**.

**If either check fails, errors, or returns empty** (including: not in a git repo, `principles/` absent from the worktree root, `git rev-parse` errors) → **installed-copy context**. Default to this when in doubt. All principles are project-specific. Skip the classification test.

Record the resolved tier (`universal` or `project-specific`) and context (`tracked-source` or `installed-copy`) — you will use them in Step 6.

### Step 6: Save the file

Save based on the tier resolved in Step 5.5:

- **installed-copy context, any tier** → `.canon/principles/{severity-subdir}/{id}.md`
- **tracked-source context, project-specific** → `.canon/principles/{severity-subdir}/{id}.md`
- **tracked-source context, universal** → `principles/{severity-subdir}/{id}.md`

  Before writing to `principles/{severity-subdir}/`, record a one-line "applies to unrelated adopters" justification in the SUMMARY artifact. In **apply-proposal mode**, also confirm with the user before writing: "This principle will be saved to the portable `principles/` set and will ship to all adopters. Proceed?" (In interactive modes the classification conversation serves as confirmation — no extra gate needed.)

Where `severity-subdir` is `rules/`, `strong-opinions/`, or `conventions/`. Create the directory if needed.

- **Agent-rules**: Ask the user: plugin-level (`${CLAUDE_PLUGIN_ROOT}/rules/{id}.md`) or project-local (`.canon/rules/{id}.md`)?

### Step 7: Validate

Re-read the saved file and verify:
- YAML frontmatter parses correctly (id, title, severity, scope, tags all present)
- The severity is one of: `rule`, `strong-opinion`, `convention`
- The body has required sections (summary, `## Rationale`, `## Examples`, `## Anti-Rationalization`, `## Verification`)
- For agent-rules: `id` starts with `agent-`, tags include `agent-behavior`

### Step 8: Suggest testing

After saving, suggest: "Run `/canon:test-principle {id}` to verify this principle works correctly in reviews."

---

## Mode: edit

### Step 1: Find and load the entry

Read the format spec:
```
${CLAUDE_PLUGIN_ROOT}/references/principle-format.md
```

This specification remains the source of truth during edits. If the existing file shape differs, migrate it to the spec-compliant structure while preserving intent.

Search for the entry by ID in:
1. `.canon/principles/**/*.md` (project-local principles)
2. `${CLAUDE_PLUGIN_ROOT}/principles/**/*.md` (built-in principles)
3. `.canon/rules/*.md` (project-local agent-rules)
4. `${CLAUDE_PLUGIN_ROOT}/rules/*.md` (built-in agent-rules)

Present its current state:
- Frontmatter fields (id, title, severity, scope, tags)
- Summary of the body (first paragraph + section headers)

If built-in (lives in plugin directory, not `.canon/`), warn:
"This is a built-in entry. Edits will be saved as a project-local override which takes precedence over the built-in version."

### Step 2: Determine changes

If specific flags were passed (e.g. `--severity strong-opinion`, `--add-tag testing`, `--archive`, `--unarchive`), apply directly. Otherwise ask what to modify:

1. **Severity** — "Change enforcement level? Currently: `{severity}`"
2. **Scope (layers)** — "Change architectural layers? Currently: `{layers}`"
3. **Scope (file patterns)** — "Change file patterns? Currently: `{file_patterns}`"
4. **Tags** — "Add or remove tags? Currently: `{tags}`"
5. **Title** — "Change the title? Currently: `{title}`"
6. **Body** — "Edit the rationale, examples, or exceptions?"
7. **Archive** — "Archive or unarchive? Currently: `{archived}`"

**`--archive`**: Set `archived: true` in frontmatter. The principle stays on disk but is skipped by the matcher — it won't appear in reviews, get_principles, or review_code results. Confirm: "Archived `{id}` — it will no longer be loaded during reviews. Use `--unarchive` to re-enable."

**`--unarchive`**: Remove or set `archived: false` in frontmatter. Confirm: "Unarchived `{id}` — it will be active in reviews again."

Multiple changes are fine in one session.

### Step 3: Handle severity changes

If severity is changing, the file moves to the correct subdirectory:
- `rule` → `rules/`
- `strong-opinion` → `strong-opinions/`
- `convention` → `conventions/`

Warn about enforcement implications:
- Upgrading to `rule`: "This will block commits that violate this."
- Downgrading from `rule`: "This will no longer block commits."

### Step 4: Check for conflicts

Same conflict checks as the create flow (see Step 5 in Mode: new-principle/new-agent-rule above). Present findings and confirm before saving.

### Step 5: Save

- If severity changed: save to new subdirectory, delete old file
- If editing a built-in: save as project-local override
- Preserve behavioral intent while normalizing body structure to the format spec

### Step 6: Validate and confirm

Re-read and verify the file. Tell the user:
- Each modified field: before → after
- New file path if it moved
- If saved as a project-local override, explain precedence
- Suggest asking Canon to list principles to verify

---

## Mode: apply-proposal

### Step 1: Read the proposal

The lead will provide the path to the learner proposal file (typically `.canon/proposed-learnings/{id}.md`). Read it in full. The proposal contains:
- A suggested principle or rule with draft content
- The rationale behind the suggestion
- Any supporting evidence the learner found

### Step 2: Map type to action

Determine whether the proposal describes:
- A **new principle** → follow Mode: new-principle (skip interview, use proposal content)
- A **new agent-rule** → follow Mode: new-agent-rule (skip interview, use proposal content)
- An **edit to an existing entry** → follow Mode: edit (skip interview, apply proposed changes)

### Step 3: Skip interview

The proposal already contains the constraint, failure mode, and scope. Do not ask the standard interview questions. Instead, verify the proposal has sufficient information to proceed:
- Is the constraint falsifiable?
- Is there at least one good and one bad example, or can you generate them from the proposal's rationale?
- Is the scope and severity clear?

If any critical gap exists, note it and ask one targeted question only.

### Step 4: Quality pipeline

Run the same quality checks as other modes (see Quality Checks section below). Generate or complete any missing sections using the proposal's rationale as source material.

### Step 5: Save

Follow the save and validate steps from the appropriate mode (new-principle, new-agent-rule, or edit). After saving, confirm to the lead:
- The file path where the entry was saved
- Any significant changes made to the proposal content during assembly

---

## Mode: fork

### Step 1: Identify the principle

Read the format spec:
```
${CLAUDE_PLUGIN_ROOT}/references/principle-format.md
```

The user will name a principle to fork (by ID or partial title). Search for it in the built-in principles:
1. `${CLAUDE_PLUGIN_ROOT}/principles/**/*.md`

If the principle is not found in the built-in directory, report: "No built-in principle found matching '{query}'. Fork mode is for copying built-in principles to project-local. Use `new-principle` mode to create a new principle."

If the principle is found, read it in full and present its current state:
- Frontmatter fields (id, title, severity, scope, tags)
- Summary of the body (first paragraph + section headers)

### Step 2: Check for existing project-local version

Check if a project-local version already exists:
1. `.canon/principles/{severity-subdir}/{id}.md`

If it exists, warn: "A project-local version of `{id}` already exists at `.canon/principles/{severity-subdir}/{id}.md`. Editing the existing copy instead of creating a duplicate."

Then switch to Mode: edit with the project-local file as the target.

### Step 3: Copy to project-local

Copy the built-in principle file to `.canon/principles/{severity-subdir}/{id}.md`, preserving the severity subdirectory structure.

Confirm: "Forked `{id}` to `.canon/principles/{severity-subdir}/{id}.md`. This project-local copy now takes precedence over the built-in version."

### Step 4: Edit (optional)

Ask: "Would you like to edit the forked principle now?"

If yes, switch to Mode: edit with the newly copied file as the target.
If no, confirm the fork is complete and suggest editing later.

### Step 5: Validate

Re-read the saved file and verify:
- YAML frontmatter parses correctly
- The file is in the correct severity subdirectory
- The content matches the built-in original (if no edits were made)

---

## Quality Checks (all modes)

Before saving, verify:
- [ ] The `id` is unique (or user confirmed override)
- [ ] The summary is a falsifiable constraint (not vague philosophy)
- [ ] At least one good and one bad example exist
- [ ] Examples use fenced code blocks with language annotation
- [ ] The severity matches the constraint's importance
- [ ] The scope is narrow enough to be useful
- [ ] For agent-rules: `id` starts with `agent-`, tags include `agent-behavior`
- [ ] The file structure and section ordering match `principle-format.md`
