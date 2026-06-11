# Codex Recurring-Defect Checklist

> **Source**: Frequency-ranked defect classes mined from all `chatgpt-codex-connector[bot]` review comments across merged PRs #47+ (the Codex-activation window). Full evidence in `docs/reference/codex-defect-classes.md`.
>
> **Severity posture**: Grep checks are advisory→WARNING, never BLOCKING. A false BLOCKING on a heuristic would halt clean builds. This tension (`fail-closed-by-default` pull vs. heuristic-precision limits) is resolved by keeping grep checks advisory. A human reviewer or a subsequent fix cycle escalates confirmed findings.
>
> **Scope guard**: Grep checks fire only when the diff touches the relevant code shape (shell/awk/grep/path-resolution code). They do NOT apply to unrelated diffs — each item states its trigger condition explicitly.

---

## Grep Checks (deterministic — advisory→WARNING, never BLOCKING)

These checks are diff-deterministic: a match in the flagged pattern is a strong candidate finding, not a confirmed violation. Present flagged matches to the human reviewer as WARNING. Do NOT auto-escalate to BLOCKING.

### Class 5 — Shell/Git Tokenize & Eval Safety

**Evidence**: 10 comments (8 P1, 2 P2); Score 18. See `docs/reference/codex-defect-classes.md` class 5.

**Trigger**: When the diff touches `*.sh`, `hooks/*`, any shell heredoc, or any file that produces shell commands for evaluation.

**What to flag**:

1. String-executing wrappers over interpolated content — patterns matching `eval `, `` `bash`[[:space:]]-c `` (with `$`-variables or `$(...)` command substitution inside), or `` `sh`[[:space:]]-c `` with interpolated content.
2. Unquoted variable expansions in destructive git commands — patterns like `git reset --hard $ref`, `git checkout $branch`, `git clean -f $path` where `$ref`/`$branch`/`$path` is not double-quoted.
3. `cd` outside a subshell in a sequence where subsequent commands assume the resulting directory — `cd` that affects the caller's shell state without explicit subshell scoping (`(cd ...; ...)` or `pushd/popd`).

**Grep commands** (for reviewer use — run against changed shell files):

```bash
# Flag string-executing wrappers over interpolated vars (avoids triggering Canon's own guard)
grep -n 'eval ' <changed-file>
grep -nE '(ba)?sh[[:space:]]+-c[[:space:]]+["'"'"'][^"'"'"']*\$' <changed-file>

# Flag unquoted expansions in destructive git operations
grep -n 'git reset --hard \$\|git checkout \$\|git clean.*\$' <changed-file>

# Flag cd outside subshell
grep -n '^[[:space:]]*cd [^(]' <changed-file>
```

**Counterexample-probe note (watch_QQQQQQ1)**: The `bash -c` pattern would false-positive on a comment line like `# do NOT use bash -c "$var"` — a line that documents the anti-pattern rather than exhibiting it. Observed behavior: `grep -nE '(ba)?sh[[:space:]]+-c[[:space:]]+["'"'"'][^"'"'"']*\$'` matches any line (including comments) containing the pattern. Mitigation: the reviewer treats matches as candidates, not confirmed violations — inspect context before flagging. Also, lines with only single-quoted strings (no `$`) are not matched by the `\$` requirement, avoiding false-positives on safe static invocations like `bash -c 'echo hello'`.

---

### Class 6 — Grep/Awk/Regex/Fence Boundary

**Evidence**: 11 comments (3 P1, 8 P2); Score 14. See `docs/reference/codex-defect-classes.md` class 6.

**Trigger**: When the diff adds or modifies an awk/grep that parses frontmatter or a fenced block, OR adds a fence around an embedded prompt or heredoc.

**Extends Stage 2 "Structural Assertion Grep Scope"**: That sub-axis targets verification commands in the diff. This checklist item ALSO applies to shell scripts and hooks being built — not only verification assertions. Both surfaces share the same failure mode (unanchored pattern matches beyond the target block).

**What to flag**:

1. **Unanchored frontmatter terminators**: An awk pattern using `/^---/{exit}` to stop at the end of frontmatter without also stopping at the next top-level YAML key. If `tools:` is not the last frontmatter key, subsequent keys (e.g., `skills:`, `memory:`) leak through and can produce false positives.
   - Correct form: `awk '/^tools:/{in_tools=1; next} in_tools && /^[^ \t]/{exit} in_tools{print}'`
   - Incorrect form (leaks): `awk '/^tools:/{found=1} found && /^---/{exit} found{print}'`

2. **Unbounded frontmatter greps**: A `grep` over a full file when the claim is "field Y is in block X" — e.g., `grep 'mcp__canon__foo' agents/reviewer.md` would match a prose mention in the body, not just the `tools:` block.

3. **Embedded-prompt fences shorter than content**: A fence delimiter (`---`, `` ``` ``, or `<<<EOF`) that could appear inside the content it wraps, causing the parser to exit early.

**Grep commands** (for reviewer use — run against changed files):

```bash
# Flag /^---/{exit} awk patterns (unanchored terminator — check for missing key-stop)
grep -n '/\^---/{exit}' <changed-file>

# Flag bare grep on agent files without block-scoping (potential frontmatter leakage)
grep -n "grep.*agents/" <changed-file>
```

**Counterexample-probe note (watch_QQQQQQ1)**: The `/^---/{exit}` grep would false-positive on the correct terminator form `awk '/^---/{in_front=0} in_front{...}'` used for a different structural purpose. Observed behavior: the pattern flags all awk scripts that mention `/^---/` regardless of their termination logic. Mitigation: treat as a candidate — inspect whether the script also has a key-stop guard (`/^[^ \t]/{exit}` within the target block) before flagging as a violation.

---

### Class 2 (Light Grep Hint) — Path/Dir Resolution

**Evidence**: 34 comments (16 P1, 18 P2); Score 50. See `docs/reference/codex-defect-classes.md` class 2.

**Trigger**: When the diff touches TypeScript/JavaScript files that construct file paths, resolve module roots, or reference plugin or project directories.

**This is a HINT only** — it flags candidates for the Class 2 Judgment Prompt Item below. A match does not confirm a violation; it flags code for closer human inspection.

**What to flag**:

1. ESM `__dirname` or `require(...)` usage in ESM (`.mjs`, or `.ts` with `"type": "module"`) files — ESM uses `import.meta.url` instead.
2. Hardcoded `CANON_PROJECT_DIR` string literals (not env-var reads) — the path may differ per user.
3. Plugin-dir constructions (paths containing `canon-marketplace` or `plugins/cache`) used where the project-root is expected, or vice versa.

**Grep commands** (for reviewer use — run against changed TypeScript files):

```bash
# Flag __dirname in ESM context
grep -n '__dirname\|require(' <changed-file>

# Flag hardcoded CANON_PROJECT_DIR string
grep -n 'CANON_PROJECT_DIR' <changed-file>

# Flag plugin-dir path fragments used in project-root context
grep -n 'canon-marketplace\|plugins/cache' <changed-file>
```

**Counterexample-probe note (watch_QQQQQQ1)**: The `__dirname` grep would false-positive on a comment explaining the correct migration — e.g., `// was __dirname, now import.meta.url`. Observed behavior: `grep -n '__dirname'` matches any line mentioning the string, including doc comments. Mitigation: the reviewer checks whether the match is in executable code vs. a comment or string literal before flagging.

---

## Judgment Prompt Items (review-prompt — evaluate against the diff)

These items require human judgment applied to the diff. They are not grep-detectable. Include them as prompt items when evaluating diffs that touch the relevant code shapes.

### Class 1 — Board/State Persistence & Ordering

**Evidence**: 19 comments (12 P1, 7 P2); Score 31. Highest P1 count among judgment classes. See `docs/reference/codex-defect-classes.md` class 1.

**Evaluate against the diff**:
- Does the diff correctly handle wave-gate precedence (e.g., a gate that fires only after a prior gate completes)?
- Are `finalize`/terminal-state transitions handled correctly — can a flow transition to a terminal state while still in progress?
- Is flow-event override ordering correct — does a later event correctly supersede an earlier one, or can they interleave?
- Is there a read-before-write on board state — does the code read current state before writing, avoiding stale-read overwrites?

---

### Class 2 — Path/Dir Resolution (Judgment Portion)

**Evidence**: 34 comments (16 P1, 18 P2); Score 50. Highest-volume class. See `docs/reference/codex-defect-classes.md` class 2.

**Evaluate against the diff** (after reviewing grep-hint matches from the Grep Checks section above):
- Is project-root vs. plugin-dir resolution correct for ESM? Does the code use `import.meta.url` + `fileURLToPath` for ESM-safe `__dirname` equivalents?
- Does the path resolution survive a non-default `CANON_PROJECT_DIR`? Is the env var read at runtime or baked in at build time?
- Are there cases where the plugin install directory is used where the user's project root is expected, or vice versa?

---

### Class 3 — Scope/Boundary Too Broad-or-Narrow

**Evidence**: 19 comments (6 P1, 13 P2); Score 25. See `docs/reference/codex-defect-classes.md` class 3.

**Cross-reference**: Overlaps with Stage 6 Scope-Parity Check (embedded shell commands, pathspec scope). This judgment item covers the same concern at the logical-guard level (exceptions, conditions, filters) where the Stage 6 check is more focused on file-set parity.

**Evaluate against the diff**:
- Is each guard, exception clause, or file-pattern scoped to exactly its declared surface — not too wide (catching more than intended) and not too narrow (missing cases it must cover)?
- Would the guard fire on an input outside its declared domain? Would it fail to fire on an input clearly inside its domain?
- For path-based filters: does the pathspec cover the correct set of files — verified against the actual repo with `git ls-files -- <pathspec>`?

---

### Class 4 — Validation/Guard on Missing or Bad Input

**Evidence**: 35 comments (6 P1, 29 P2); Score 41. Highest raw comment count. See `docs/reference/codex-defect-classes.md` class 4.

**Evaluate against the diff**:
- Does the diff raise or return on missing/null/undefined inputs before proceeding? Or does it assume the caller always provides valid data?
- Is there verify-before-act logic — does the code confirm a precondition (e.g., file exists, workspace initialized) before performing a destructive or irreversible action?
- Is the code robust to concurrent initialization — if two callers invoke the same setup function concurrently, does one win cleanly or do they corrupt shared state?
- Are optional fields that become structurally required (e.g., a field that must be non-null at this call site) guarded with an explicit check?

---

### Class 7 — Concurrency/Transaction/Race

**Evidence**: 3 comments (3 P1, 0 P2); Score 6. All P1 (highest-severity only). Maps to the `explicit-transaction-boundaries` Canon principle. See `docs/reference/codex-defect-classes.md` class 7.

**Evaluate against the diff**:
- Are board read+write operations serialized, or can interleaved reads/writes produce inconsistent state?
- Are reads that depend on each other performed in the same transaction, so no concurrent write can change the data between reads?
- Is initialization atomic — does the workspace/session init succeed-or-fail as a unit, leaving no half-initialized state?
- Are jobs and sessions correctly scoped — is a job result visible only within its originating session, or could it leak across sessions?

This item directly maps to the `explicit-transaction-boundaries` Canon principle: side effects that span multiple writes should be bracketed by an explicit transaction or mutex so the system can never observe partial state.

---

## Not Wired (Deliberate)

### Class 8 — Tool-Wiring (Schema/Args/Call)

**Evidence**: 6 comments (3 P1, 3 P2); Score 9. See `docs/reference/codex-defect-classes.md` class 8.

**Why not wired here**: Already covered by reviewer Stage 2 sub-axes:
- **"Agent→Tool Reachability"** — verifies that the tool is in the agent's `tools:` allowlist AND registered in the MCP server.
- **"Discriminant Surface Parity"** — verifies TypeScript type members match Zod schema members.

Wiring class 8 here would duplicate existing Stage 2 checks and introduce noise. If a re-mine elevates this class's P1 count significantly above current levels (3 P1), reconsider.

### Class 9 — Return-Shape / Empty Handling

**Evidence**: 1 comment (0 P1, 1 P2); Score 1. Lowest-volume class. See `docs/reference/codex-defect-classes.md` class 9.

**Why not wired here**: Below the noise-vs-value cut — the single P2 comment does not justify a standing checklist item. Revisit if a re-mine produces 3+ P1 comments or a Score above 5.
