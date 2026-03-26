# Quality Gates

## Design Philosophy

Gates are **language-agnostic shell commands** executed deterministically. Canon does not know or care what language your codebase uses. A gate is: "run this command; pass if exit code 0."

## Zero-Config Discovery (Default)

By default, you don't need to configure any gates. Canon's agents automatically discover what quality checks are available:

- The **tester** detects your test framework and reports the test command
- The **reviewer** detects your linting/formatting tools and reports those commands
- The **gate runner** executes whatever was discovered — deterministically

This means most projects get test and lint gates for free, with no YAML configuration.

## Explicit Override

If you want to control exactly which commands run, declare them in flow YAML:

```yaml
states:
  implement:
    gates:
      - "npm test"
      - "make lint"
      - "./scripts/check.sh"
```

Explicit gates always take priority over discovered gates.

## Multi-Language Examples

- Node.js: `gates: ["npm test", "npx eslint ."]`
- Python: `gates: ["pytest", "ruff check ."]`
- Go: `gates: ["go test ./...", "go vet ./..."]`
- Rust: `gates: ["cargo test", "cargo clippy"]`
- Any language: `gates: ["make lint", "./scripts/check.sh"]`

## Resolution Priority

The gate runner resolves commands in this order:

1. **Explicit `gates:` array** in flow YAML — direct shell commands, run as-is
2. **Legacy `gate:` field** — named reference resolved via flow gates map (backward compat)
3. **Discovered gates** — accumulated from agent `report_result` calls during the build
4. **No gates** — state proceeds without quality checks

The first non-empty tier wins. Explicit configuration always overrides discovery.

## Fail-Closed Behavior

Named gates that cannot be resolved (not in the flow's gates map and not a built-in) **fail** instead of being silently skipped. Direct shell commands in the `gates:` array never have this issue — they execute as-is.

If a gate command exits non-zero, the flow does not advance. The orchestrator follows the state's `transitions` — typically looping back to a fix state.

## Postconditions

States can declare postcondition assertions, or let agents discover them:

### Explicit Postconditions

```yaml
states:
  implement:
    postconditions:
      - type: file_exists
        target: plans/SUMMARY.md
      - type: no_pattern
        target: src/index.ts
        pattern: "TODO|FIXME|HACK"
    effects:
      - type: check_postconditions
```

### Agent-Discovered Postconditions

When no explicit postconditions are declared, agents can report discovered postconditions via `report_result`. The architect generates these contextually based on what the task should produce. When the `check_postconditions` effect fires, it checks explicit declarations first, then falls back to agent-reported discoveries.

If neither explicit nor discovered postconditions exist, the effect is a no-op.

### Assertion Types

| Type | Description | Fields |
|------|-------------|--------|
| `file_exists` | File must exist | `target` |
| `file_changed` | File must have changed since base commit | `target` |
| `pattern_match` | File must contain regex pattern | `target`, `pattern` |
| `no_pattern` | File must NOT contain regex pattern | `target`, `pattern` |
| `bash_check` | Shell command must exit 0 | `command` |

### Security

`bash_check` commands are filtered against a denylist: `rm`, `sudo`, `curl`, `wget`, `chmod`, `chown`, `mkfs`, `dd`. Commands containing these are rejected before execution.

## Richer Metrics

Each state completion records signals on `StateMetrics`:

| Signal | Type | Source |
|--------|------|--------|
| `gate_results` | `GateResult[]` | Gate runner |
| `postcondition_results` | `PostconditionResult[]` | Contract checker |
| `violation_count` | `number` | Review agent |
| `violation_severities` | `{blocking, warning}` | Review agent |
| `test_results` | `{passed, failed, skipped}` | Agent-reported |
| `files_changed` | `number` | Agent-reported |
| `revision_count` | `number` | Auto-computed from iteration count |

**Note**: `test_results` is agent-reported structured data, not Canon parsing framework output. Canon does not parse your test runner's stdout.

At flow completion, signals are aggregated into `FlowRunEntry`:
`gate_pass_rate`, `postcondition_pass_rate`, `total_violations`, `total_test_results`, `total_files_changed`.

## Security Model

Gate names in the legacy `gate:` field are **never** executed directly as shell commands. They are lookup keys into the `gates:` map or the built-in registry. Only the resolved command string reaches the shell.

Direct commands in the `gates:` array execute as-is via `spawnSync(..., { shell: true })`. The flow author controls these commands — they are not user-supplied input.

## Timeout

All gate commands have a 5-minute (300s) timeout. If a gate command exceeds this, it is killed and treated as failed.
