---
description: Initialize Canon principles in your project
argument-hint: [--starter|--empty|--no-scan]
allowed-tools: [Bash, Read, Write, Glob, Edit, Agent, WebSearch, AskUserQuestion]
model: haiku
---

Initialize Canon engineering principles in the current project. This sets up the `.canon/principles/` directory and integrates with CLAUDE.md.

## Instructions

### Step 1: Create the Canon directory structure

```bash
mkdir -p .canon/principles/rules .canon/principles/strong-opinions .canon/principles/conventions
mkdir -p .canon/workspaces .canon/history
```

Then ensure `principle-overrides.yaml` will be tracked by git even though `.canon/` is otherwise gitignored. Check whether `.gitignore` ignores `.canon/` and doesn't already have the exception; if so, append it:

```bash
grep -q '\.canon/' .gitignore && ! grep -q '!\.canon/principle-overrides\.yaml' .gitignore && echo '!.canon/principle-overrides.yaml' >> .gitignore
```

This is a no-op if `.gitignore` does not ignore `.canon/` or already contains the exception.

### Step 2: Explain the two-layer principle model

The `.canon/principles/` directories created in Step 1 are for **project-local principles only** — custom principles you write for this specific project. Built-in Canon principles are loaded automatically from the plugin directory at runtime.

If you need to customize a built-in principle, use the writer agent's `fork` mode to copy it into `.canon/principles/` for editing.

Do NOT copy built-in principles into `.canon/principles/` — this would create stale duplicates that shadow updates from the plugin.

If the user passed `--empty`, skip this step entirely (same as before — but now this step has no copy action since the directories are empty by design).

### Step 3: Create default config

Create `.canon/config.json` with sensible defaults:

```json
{
  "principle_dirs": [".canon/principles"],
  "layers": {
    "src": ["src/**"]
  },
  "review": {
    "max_principles_per_review": 10,
    "include_honored_in_output": true
  },
  "hook": {
    "pre_commit_severity": "rule",
    "warn_on_opinions": true
  }
}
```

### Step 4: Update CLAUDE.md

Check if `CLAUDE.md` exists in the project root. If it does, check whether it already contains a "Canon" section. If not, append the following sections:

```markdown

## Canon Orchestration (MANDATORY)

This project has Canon initialized. **You ARE the orchestrator.** Drive the build pipeline yourself using Canon's MCP harness tools — do NOT spawn a canon-orchestrator subagent. Call MCP tools directly and spawn only specialist agents as leaf workers.

Classify every user message by intent:
- **build/review/security** → `init_workspace` → follow the documented sequence (spawn specialist agents, journal each step via `log_step`) → present HITL breakpoints at mandatory gates → `finalize_workspace`. Read `references/canon-orchestrator.md` for the full protocol.
- **question/status** → Spawn `canon:guide`
- **principle authoring** → Spawn `canon:writer`
- **learn** → Spawn `canon:learner`
- **git ops / read-only / chat** → Handle directly

## Canon Engineering Principles

This project uses Canon for engineering principles. Before writing or modifying code, load relevant principles via the `get_principles` MCP tool. Severity levels: `rule` is non-negotiable, `strong-opinion` requires justification to skip, `convention` is noted but doesn't block.

Built-in principles are loaded from the Canon plugin automatically. Project-local principles (custom additions) go in `.canon/principles/`. Project-local principles with the same ID as a built-in principle take precedence. Use `.canon/principle-overrides.yaml` to disable or adjust built-in principles without copying them.
```

If `CLAUDE.md` doesn't exist, create it with just the Canon sections above.

### Step 5: Auto-detect project conventions

Scan the existing codebase to infer conventions and pre-populate `.canon/CONVENTIONS.md`. This gives new projects a useful starting point instead of a blank template.

Detect the language/framework from config files (package.json, go.mod, Cargo.toml, etc.). Sample 10-20 source files to detect naming, error handling, testing, import, and validation patterns.

#### Write CONVENTIONS.md

Create `.canon/CONVENTIONS.md` with detected conventions:

```markdown
## Project Conventions

> Project-specific patterns and decisions. Auto-detected by `/canon:init` and refined as the project evolves.
> Implementor agents read this file alongside Canon principles.

{detected conventions as bullets, e.g.:}
- **Naming**: camelCase for functions and variables, PascalCase for types and components
- **File naming**: kebab-case for files and directories
- **Error handling**: try/catch with custom error classes
- **Testing**: Vitest with inline test data
- **Validation**: Zod schemas at API boundaries
- **Data layer**: Prisma ORM with repository pattern
```

If no conventions could be detected (empty project or unrecognizable stack), fall back to the blank template:

```markdown
## Project Conventions

> Project-specific patterns and decisions. Updated as the project evolves.
> Implementor agents read this file alongside Canon principles.

<!-- Add your project conventions below. Examples: -->
<!-- - **Error handling**: Use result types, not thrown exceptions -->
<!-- - **Validation**: Zod schemas at API boundaries -->
<!-- - **Testing**: Vitest with inline test data -->
```

### Step 5b: Provision language tooling (LSP + KG code-intel)

**Shared detection (once):** Reuse the language detection from Step 5 — the config files already scanned (`package.json`/`tsconfig.json` → TypeScript/JavaScript, `go.mod` → Go, `Cargo.toml` → Rust, `pyproject.toml`/`setup.py` → Python, etc.). Compute the detected language set ONCE and feed both Branch A and Branch B. Do NOT re-scan or maintain any hardcoded `{language → server/grammar}` answer table — only templated WebSearch query strings are allowed.

If no languages were detected, skip this step entirely and note it in the Step 6 report.

#### Branch A — LSP server (per detected language)

For each detected language:

1. **WebSearch-resolve** the recommended LSP server and its install command. Apply the source-trust rubric: prefer the language's official documentation, official LSP server repository, or editor-extension documentation. Capture the source URL(s). Query example: `"<language> LSP language server install command"`. If WebSearch yields no trustworthy result (no citeable official source), skip this language for Branch A and note it.

2. **Presence check:** Run `command -v <resolved-binary>` via Bash. If the binary is already on PATH, report `Code-intel available for <language> (<binary> on PATH)` and propose nothing — do not re-install. If absent, proceed.

3. **Present for vetting:** Show the resolved install command labeled `[web-inferred — verify before running]` with the source URL(s). Do not install yet.

4. **Approval gate:** Use `AskUserQuestion` to ask: "Install LSP server for <language>? Command: `<install command>` (Source: <URL>). Approve? [yes/no]". If the user declines, record the LSP server as "declined" and leave no mutation — provide the install command as copy-paste info only.

5. **On approval:** Run the install command via `Bash`.

#### Branch B — KG tree-sitter grammar + LanguageConfig (per detected language)

For each detected language:

1. **Presence check (offline, first):** Is this language already KG-supported? KG-supported means: its extension is handled by a built-in language (JS/TS `.js`/`.ts`/`.jsx`/`.tsx`, Python `.py`, Bash `.sh`, Java `.java`, Markdown `.md`) OR a project-local overlay already exists at `.canon/kg-languages/<lang>.json`. If supported, report `KG already supports <language>` and skip — propose nothing for Branch B.

2. **WebSearch-resolve** for unsupported languages (two queries):
   - (a) The npm package `tree-sitter-<lang>` that ships a prebuilt `.wasm` file, or an official prebuilt `.wasm` URL as fallback. Query example: `"tree-sitter-<lang> npm prebuilt wasm"`. Capture the package name/URL and source URL(s).
   - (b) The grammar's node-type names for the 8 required roles: `functionDef`, `classDef`, `methodDef`, `importStatement`, `callExpression`, `variableDecl`, `exportStatement`, `classBody`. Query example: `"<language> tree-sitter grammar node types named-nodes.json"`. For any role where no trustworthy node-type name can be found, use an empty array `[]` — never fabricate names.
   
   Apply the source-trust rubric: prefer the grammar's official repository, its `grammar.js` definition, or its `node-types.json`. Capture source URLs for both queries. If either query (grammar package or node-types) returns no trustworthy result, skip Branch B for this language entirely and report it — produce no artifact.

3. **Present for vetting:** Show (labeled `[web-inferred — verify before running]`):
   - The grammar source (npm package or URL) with source URL(s)
   - The full inferred `LanguageConfig` JSON in the exact overlay format (see contract below), with source URL(s) for the node-type mappings
   - A note that the node-type names are the riskiest inference and should be verified against the grammar's `named-nodes.json` or `grammar.js`

   **Overlay contract — the `.canon/kg-languages/<lang>.json` MUST match this exact shape:**
   ```json
   {
     "id": "<lang>",
     "extensions": [".<ext>", ...],
     "grammarFile": "tree-sitter-<lang>.wasm",
     "nodeKinds": {
       "functionDef": ["<node-type>", ...],
       "classDef": ["<node-type>", ...],
       "methodDef": ["<node-type>", ...],
       "importStatement": ["<node-type>", ...],
       "callExpression": ["<node-type>", ...],
       "variableDecl": ["<node-type>", ...],
       "exportStatement": ["<node-type>", ...],
       "classBody": ["<node-type>", ...]
     }
   }
   ```
   All 8 `nodeKinds` roles are required; each must be a string array (empty arrays are valid for roles the language does not have). Do NOT include a `hooks` field — it is intentionally omitted in v1 (Decision lsp-recommender-07).

4. **Approval gate:** Use `AskUserQuestion` to ask: "Provision KG tree-sitter grammar for <language>? This will: download the grammar wasm from `<package/URL>` into `.canon/grammars/`, then write the inferred LanguageConfig to `.canon/kg-languages/<lang>.json`. Please verify the node-type mappings shown above before approving. Approve? [yes/no]". If the user declines, produce no artifact — leave the KG exactly as before.

5. **On approval — atomic provisioning (KG-integrity):** Provision in this exact order; if any step fails, remove any partial artifact and abort with a clear error:
   - (i) Create the directories if absent: `mkdir -p .canon/grammars .canon/kg-languages`
   - (ii) Acquire the wasm: `npm install tree-sitter-<lang>` (or download the sourced URL). Copy or move the `.wasm` file into `.canon/grammars/tree-sitter-<lang>.wasm`. Verify the file is non-empty.
   - (iii) Verify the file is in place: confirm `.canon/grammars/tree-sitter-<lang>.wasm` exists and is non-empty.
   - (iv) ONLY AFTER the wasm is confirmed in place, write the vetted `LanguageConfig` to `.canon/kg-languages/<lang>.json` using the exact shape above.
   - (v) Trigger a graph refresh: call `codebase_graph` or run `ensure-graph-fresh` so the new language overlay is picked up and the project's files in that language are tree-walked.
   - NEVER write the JSON config without a confirmed wasm. NEVER leave a partial wasm and no config, or a partial config and no wasm. If the wasm download fails or the config write fails, delete any partial file that was written.

#### Graceful degradation

- **No detected language:** Skip Step 5b entirely; note in Step 6 report.
- **No network / WebSearch failure for a target:** Report per-target, mutate nothing.
- **No trustworthy result (no server, no grammar package, or untrustworthy node-mappings):** Report it for that target; produce no artifact; do not fabricate.
- **Partial (e.g. Branch A resolvable but Branch B not):** Handle each target independently; the other target's failure does not affect the one that succeeded.
- **Decline on approval gate:** For that target, provide the resolved info as copy-paste only; write no file; run no install.
- Never crash; never half-register the KG.

### Step 6: Report what was done

Tell the user what was created (principles, conventions, workspaces, CLAUDE.md). Add one-line status per Step 5b target:
- `Code-intel (LSP): <available | installed <server> | recommended (not installed) | no trustworthy result | skipped (no language detected)>`
- `KG tree-walk: <already supported | provisioned <lang> | no trustworthy grammar | skipped>`

Note that `/canon:init` is re-invocable: re-running it will re-check LSP presence and re-run KG presence checks (idempotent).

If the adoption scan in Step 7 was run, summarize scan results here (number of violations found by tier, and whether any were highlighted for attention). Suggest next steps: ask Canon to list principles to browse them, edit `.canon/CONVENTIONS.md` to add conventions, and add `.canon/` to git tracking.

### Step 7: Run adoption scan

Check whether `--no-scan` was passed in `${ARGUMENTS}`. If it was, skip this step entirely.

Otherwise, invoke the orchestrator with:
- `flow: adopt`
- `task: "Adoption scan of the project"`

The flow will scan the codebase for principle violations and produce a tiered adoption report. Read the adoption report from the workspace and display a summary to the user: how many violations were found per tier, and which files have the most issues.

If the project appears to be empty or very small (fewer than 5 source files), skip the scan and note that it can be run later by re-running `/canon:init` without `--no-scan`.
