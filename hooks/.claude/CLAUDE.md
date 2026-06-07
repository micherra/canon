# Canon Hooks — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-09 -->
Pre/post tool-use interceptors that enforce policy and prevent mistakes without requiring agent compliance. Hooks run automatically on matched tool invocations.

## Architecture
<!-- last-updated: 2026-05-31 -->

`hooks.json` is the single registry defining when each hook script runs. Hooks are shell scripts triggered by `PreToolUse` (before Bash/Write/Edit/EnterPlanMode/Agent), `PostToolUse` (after Bash), `SessionStart`, `SubagentStop`, or `PostCompact`. The separate `canon-agent-teams/hooks.json` was merged into this file (2026-04-26); `canon-agent-teams/hooks.json` no longer exists.

`lib/canon-hook-lib.sh` — shared helper library sourced by hooks that need JSON extraction or git subcommand resolution. `canon_extract_command(input)` uses `jq` when available; falls back to `grep`/`sed`. The fallback fails closed: if the extracted value contains a backslash (escaped-quote sequence), it returns empty so the caller's fail-closed branch fires (exit 2) rather than passing garbage through. `canon_strip_comments(command)` strips shell comment text from a possibly-multiline command (char-walk with persistent quote state across newlines; `#` inside quotes or mid-word is NOT a comment; newlines are always preserved for line-count alignment). `canon_tokenize(segment)` is the quote-aware awk tokenizer (split on unquoted whitespace; quoted spans grouped into one token with quote chars removed; one token per line). `canon_has_git_token(segment)` tokenizes via `canon_tokenize` and returns 0 iff some token equals exactly `git` — the authoritative replacement for the per-segment grep prefilter. `canon_git_subcommand(segment)` resolves the real git subcommand of a single command segment, correctly classifying git global options as value-consuming (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--exec-path`, `--super-prefix`) or self-contained (all others including unknown `-flag` tokens) — never consuming an unknown flag's value (fail-closed posture). After quote-stripping the candidate subcommand token, shape validation rejects tokens that do not match `^[A-Za-z][A-Za-z0-9_-]*$` (e.g. `$CMD`, `${CMD}`, `$(x)`) → returns 1 so the parse-ambiguity guard fires → fail-closed. Returns 1 (prints nothing) when no resolvable git invocation is found. `canon_unwrap_string_exec_arg(segment)` detects string-executing wrappers (`eval`, `bash -c`, `sh -c`, `zsh -c`, `ksh -c`) using a prefix-vocabulary-free universal scan-forward: known transparent prefixes (`command`/`nohup`/`env`/`timeout`/`nice`) are handled explicitly, and any other leading token triggers a scan of all remaining tokens for the first wrapper — so arbitrary outer commands (e.g. `setsid`, `stdbuf`, `xargs`) are covered without an allowlist; returns 1 for non-executing wrappers (echo, printf, etc.). `canon_git_dir_arg(command)` and `canon_is_git_cmd(command, subcmd)` are also provided for cd-prefix detection and subcommand-presence tests respectively.

**Hook scripts:**

| Script | Trigger | Purpose |
|--------|---------|---------|
| `pre-commit-check.sh` | PreToolUse (Bash) | Detect secrets, validate principle compliance |
| `destructive-guard.sh` | PreToolUse (Bash) | Prevent force push, hard reset, and other dangerous git ops |
| `workspace-lock-guard.sh` | PreToolUse (Bash) | Prevent concurrent builds on same branch |
| `pre-push-review.sh` | PreToolUse (Bash) | Require review before pushing |
| `large-file-guard.sh` | PreToolUse (Write/Edit) | Prevent accidental large file commits |
| `principle-inject.sh` | PreToolUse (Write/Edit) | Inject principle summaries into prompts |
| `plan-mode-guard.sh` | PreToolUse (EnterPlanMode) | Guard against unintended plan mode entry |
| `dag-dispatch-guard.sh` | PreToolUse (Agent) | Advisory warning when raw Agent spawns detected during DAG implement state — never blocks (exit 0) |
| `canon-agent-teams/canon-workspace-check.sh` | PreToolUse (Edit/Write/Bash) | Block file edits when no active Canon workspace exists (L4 enforcement) |
| `canon-agent-teams/pre-commit-branch-guard.sh` | PreToolUse (Bash) | Block commits directly to main/master during a Canon build |
| `learn-nudge.sh` | PostToolUse (Bash) | Suggest principle creation/updates |
| `compaction-check.sh` | PostToolUse (Bash) | Detect workspace file growth |
| `canon-agent-teams/post-commit-trailers.sh` | PostToolUse (Bash) | Validate Canon commit trailers after each commit |
| `canon-agent-teams/session-start-deps-install.sh` | SessionStart | Install mcp-server deps into `${CLAUDE_PLUGIN_DATA}` via compare-manifest pattern; exits 0 always; 120s timeout |
| `canon-agent-teams/session-start-server-guard.sh` | SessionStart | Reap stale PID-validated tsx process on :3141; health-probe WARN citing `/mcp` on zero-tool state; exits 0 always |
| `canon-agent-teams/session-start-doc-check.sh` | SessionStart | Nudge on stale documentation at session open |
| `canon-agent-teams/session-start-kg-check.sh` | SessionStart | Nudge on stale knowledge graph at session open |
| `canon-agent-teams/session-start-timestamp.sh` | SessionStart | Write session start timestamp for duration watchdog |
| `canon-agent-teams/session-start-context.sh` | SessionStart | Output project pulse (recent builds, drift, convention count) as invisible orchestrator context |
| `canon-agent-teams/session-duration-watchdog.sh` | PreToolUse (*) | Advisory session duration warning after configurable threshold |
| `canon-agent-teams/tool-loop-detector.sh` | PostToolUse (*) | Detect 3 consecutive identical tool calls (loop) and exit 2 to surface HITL |
| `canon-agent-teams/postcompact-narrative-capture.sh` | PostCompact | Append compaction summary to active workspace journal for agent continuity |

## Contracts
<!-- last-updated: 2026-06-06 -->

- **Fail-closed contract** (`destructive-guard.sh`, `pre-commit-check.sh`): safety hooks extract the tool command via `canon_extract_command "$INPUT"`. When extraction returns empty AND the raw `$INPUT` contains a non-empty `"command"` key, hooks exit 2 (blocked). Genuinely empty or absent command fields exit 0. `pre-push-review.sh` is advisory-only: it emits `CANON WARNING:` on extraction failure but always exits 0. Both hooks source `lib/canon-hook-lib.sh`; jq is required and the library fails closed when jq is absent — command extraction is unreliable without jq and enforcement cannot be guaranteed.
- **Destructive-guard detection contract** (`destructive-guard.sh`): after command extraction, the guard (1) strips shell comments via `canon_strip_comments` (char-walk, preserves quote state across newlines, always emits newline — runs before both stream derivations so comment-only inputs no-op cleanly), (2) deletes shell quote characters (`"` and `'`) to reproduce bash quote-removal before any flag matching, (3) segments the command on `&&`, `||`, `;`, and `|` to evaluate each segment independently, (4) uses `canon_has_git_token` (tokenizer-authoritative) to skip segments with no standalone `git` token — correctly skips `echo "git worktree remove exit: $?"` whose git text is inside a quoted string, (4a) **string-executing-wrapper expansion (universal scan-forward)**: when a segment has no standalone `git` token, `canon_unwrap_string_exec_arg` performs a prefix-vocabulary-free scan: known transparent prefixes (`command`/`nohup`) advance past their own flags; `env` advances past its flags and assignments but also recognises `-S`/`--split-string`/bundled-`S` flag clusters as string-re-executing forms — the payload is extracted and queued for recursive evaluation (not skipped); `timeout`/`nice` and any unrecognised outer token (e.g. `setsid`, `stdbuf`, `xargs`) trigger a universal scan-forward that walks ALL remaining tokens looking for the first token whose basename normalises to a shell wrapper (`bash`, `sh`, `zsh`, `ksh`, `eval`); pure-output / no-exec builtins (`echo`, `printf`, `:`, `true`, `false`) short-circuit immediately (return 1) before the scan-forward so that `echo bash -c "..."` (unquoted) does not false-block; once a wrapper is found, the wrapper's inner `-c` string is extracted and appended to the processing queue for recursive evaluation; recognised wrappers that cannot produce a parseable inner string fail closed (exit 2); non-executing wrappers whose quoted argument contains `bash` etc. as a multi-word token do NOT trigger wrapping (the quoted string is one token, not a bare `bash` command token); recursion is capped at depth 3 and fails closed on depth-exceeded, and (5) resolves the git subcommand of each RAW segment via `canon_git_subcommand` with shape validation — then inspects only that subcommand's own arguments for destructive flags. A segment with a real `git` token whose subcommand cannot be resolved (including shape-invalid tokens like `$CMD`) blocks fail-closed (exit 2). Whole-command-string regex matching is not used. **Consciously documented gap**: `bash -c "$(echo git reset --hard)"` and other command-substitution/backtick inner forms pass (exit 0) — the inner argument is a shell expansion that cannot be evaluated statically; this is genuinely exotic (requires deliberate obfuscation) and is deferred by design. The guard is a best-effort floor with the Claude harness as backstop.
- **Layer** — `hooks/**` (including `hooks/lib/**`) is mapped to the `hooks` layer in `mcp-server/src/shared/lib/config.ts` `DEFAULT_LAYER_MAPPINGS`; entry is ordered before `shared` so `hooks/lib/*.sh` resolves to `hooks`, not `shared`.
- **Principles scoped to this layer**: `hooks-fail-closed` (rule), `source-shared-hook-helpers` (convention), `hooks-observable-failures` (convention) — all carry `scope.layers: [hooks]` and `scope.file_patterns: ["hooks/**"]`.

## Conventions
<!-- last-updated: 2026-05-29 -->

- Hooks are guardrails — they enforce safety without requiring agents to opt in
- Each hook script must be executable and exit 0 (pass) or non-zero (block)
- Hook configuration lives in `hooks.json` with matcher patterns for tool names
- `principle-inject-worker.mjs` is a Node.js helper invoked by `principle-inject.sh`
- `destructive-guard.test.sh` and `install-git-hooks.sh` are utilities, not registered hooks
- When testing secret-detection hooks, use all-zeros suffixes or EXAMPLE-pattern placeholders for key fixtures — not plausible real-looking values. GitHub push protection scans test files regardless of hook exclusion rules.
- **Hook test files**: Hooks with 3+ decision branches, runtime state inspection (sqlite queries, filesystem checks), or bypass gate env vars MUST have a corresponding `.test.sh` file. Place it alongside the hook (e.g., `pre-commit-check.test.sh`) or in a `__tests__/` subdirectory. Tests must cover: bypass gate, all silent-pass paths, and all warning/blocking paths. Run with `bash hooks/<name>.test.sh`.
- **Shared test helpers**: All hook test files source `hooks/test-helpers.sh` for shared utilities (`run_test`, `assert_eq`, etc.); do not define these helpers inline in individual test files.
- **Shell linting gate**: All hook scripts (excluding `*.test.sh` and `test-helpers.sh`) must pass `shellcheck`. Run `bash hooks/lint.sh` to check. This is part of the verify gate — it runs as the final step after `npm test`. The script fails closed (exits 1) if shellcheck is not installed. Fix all errors and warnings; style-level checks (SC2001, SC2016) and source-path noise (SC1091) are suppressed globally. The CI `shell` job (`.github/workflows/ci.yml`) runs `bash hooks/lint.sh` and all `hooks/**/*.test.sh` suites on every push/PR — both gates fail the build on non-zero exit.
- **Observable-failures compliance**: Every `|| true` / `2>/dev/null || true` suppression site in hook scripts must be one of two forms: (1) `# DOCUMENTED FAIL-OPEN -- <reason and downstream handler>` inline annotation on the same line as the suppression code for expected no-match or pass-through paths; (2) converted to `|| { >&2 echo "CANON WARNING: [hook-name] <message>"; VAR=""; }` for genuine failure paths where silent swallowing would hide bugs. No bare `|| true` without annotation is permitted.
