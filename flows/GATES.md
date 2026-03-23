# Flow Gates

Gates are verification checkpoints that run between flow states. When a state declares a `gate`, the orchestrator runs the gate command after the state completes — if it fails, the flow loops back for fixes.

## How Gates Work

1. A state declares `gate: gate-name` in its definition
2. After the state completes, the orchestrator calls `runGate(gateName, flow, cwd)`
3. The gate runner resolves the name to a shell command and executes it
4. Exit code 0 = passed, non-zero = failed
5. On failure, the orchestrator follows the state's `transitions` (typically back to a fix state)

## Resolution Order

The gate runner resolves names in this order:

1. **Flow-level gates map** — if the flow defines `gates:` in its frontmatter, the name is looked up there first
2. **Built-in gates** — `test-suite` is the only built-in, auto-detected from `package.json`
3. **Not found** — gate is skipped gracefully (treated as passed)

## Built-in: `test-suite`

The `test-suite` gate auto-detects your test runner:

- If `package.json` has `scripts.test` → runs `npm test`
- Fallback → runs `make test`

```yaml
states:
  implement:
    type: single
    agent: canon-implementor
    gate: test-suite
    transitions:
      done: review
      blocked: fix
```

## Custom Gates

Define custom gates in the flow's `gates:` map. Each key is a gate name, each value is the shell command to run.

```yaml
gates:
  lint: "npm run lint"
  typecheck: "npx tsc --noEmit"
  e2e: "npm run test:e2e"

states:
  implement:
    type: single
    agent: canon-implementor
    gate: typecheck
    transitions:
      done: review
      blocked: fix
```

### Examples

**Lint gate:**
```yaml
gates:
  lint: "npx eslint src/ --max-warnings 0"
```

**Type-check gate:**
```yaml
gates:
  typecheck: "npx tsc --noEmit"
```

**Custom script:**
```yaml
gates:
  validate-schema: "./scripts/validate-schema.sh"
```

**Multiple gates per flow:**
```yaml
gates:
  unit-tests: "npm test"
  lint: "npm run lint"
  typecheck: "npx tsc --noEmit"

states:
  implement:
    gate: unit-tests
    # ...
  review:
    gate: lint
    # ...
```

## Security

Gate names are **never** executed directly as shell commands. They are lookup keys into the `gates:` map or the built-in registry. Only the resolved command string reaches the shell. This prevents command injection through flow definitions.

## Timeout

Gates have a 5-minute (300s) timeout. If a gate command exceeds this, it's killed and treated as failed.
