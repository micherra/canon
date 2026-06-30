# workflows/ — Workflow Script Library

This directory is Canon's **workflow script library**. Each `*.js` file is a plain-JavaScript
orchestration script that runs inside the Claude Code `Workflow` tool's sandboxed runtime.

Scripts here are the source-of-truth library. They are hand-written (no generated code),
deterministic, and CI-linted to guarantee they will run correctly in the Workflow sandbox.

## canon-probe — Harness-Upgrade-Stability Canary

`canon-probe.js` is the reference canary for this library. Its role:

- **When to run**: after every Canon harness upgrade to verify that the Workflow tool itself
  still functions correctly (boots, spawns agents, ingests schema-validated structured output,
  returns a result).
- **What it does**: calls one `agent()` with a JSON Schema, checks that the result has
  `ok: true`, and returns `{ probe_ok, raw }`. A clean run means the workflow runtime is
  functional end-to-end.
- **Expected return**: `{ probe_ok: true, raw: { ok: true, note: "canon-probe passed" } }`

## On-Demand Invocation (Inc 0)

Invoke canon-probe by its file path (name-based resolution deferred to Increment 1):

```js
Workflow({ scriptPath: "workflows/canon-probe.js" })
```

This runs the script directly from disk — no prior install step required.

## Adding Scripts

1. Write a plain-JS script with a `export const meta = { ... }` pure-literal header.
2. The script body runs in an async context — use `await` directly.
3. Run `bash hooks/lint.sh` to confirm the new script passes the CI lint.
4. Add a row to the `CLAUDE.md` registry table.

See `workflows/CLAUDE.md` for the full authoring guide.
