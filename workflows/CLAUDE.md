# workflows/ — Workflow Script Library

## Purpose

`workflows/` is Canon's managed workflow script library. Each `*.js` file is a
**plain-JavaScript orchestration script** for the Claude Code `Workflow` tool.

This directory is the source-of-truth library. Scripts here are the canonical versions;
the harness's `.claude/workflows/` name-resolution directory is populated from here by the
install pipeline (Increment 1). For Increment 0, invoke scripts directly via `scriptPath`.

## Authoring Rules

Every workflow script MUST:

1. **Begin with a pure-literal `export const meta`** — no variables, function calls,
   spreads, or template interpolation in the meta object or any of its nested values.
   Required fields: `name`, `description`. Optional: `whenToUse`, `phases`.

2. **Be valid plain JavaScript** — no TypeScript syntax (no type annotations, interfaces,
   or generics). Scripts run in the Workflow sandbox, not Node.js.

3. **Be deterministic** — the following constructs are BANNED (they break prefix-cached
   resume):
   - `Date.now()` — use `args.ts` or a pre-computed constant instead
   - `Math.random()` — vary by index (`i`, `args.seed`) instead
   - `argless new Date()` — use `new Date(args.ts)` if a timestamp is needed
   - `isolation` **agent-option key** — Canon CLAUDE.md prohibits the `isolation`
     property key in agent option objects (`agent(..., { isolation: ... })`); a bare
     variable named `isolation` is NOT banned

4. **Never use `.claude/workflows/` name-install paths** for Inc 0. Use `scriptPath`.

## Forbidden Constructs (enforced by `hooks/lint.sh`)

The CI lint (`mcp-server/scripts/workflows-lint.mjs`, wired via `hooks/lint.sh`) rejects
any script containing:

| Construct | Why banned |
|-----------|-----------|
| `Date.now()` | Non-deterministic — invalidates resume cache |
| `Math.random()` | Non-deterministic — invalidates resume cache |
| `new Date()` (argless) | Non-deterministic — invalidates resume cache |
| `isolation` agent-option key | Canon prohibits the `isolation` KEY in agent option objects (`agent(..., { isolation: ... })`); a bare variable named `isolation` is NOT banned — the boundary is the property key, not the identifier name |
| TypeScript syntax | Workflow sandbox is plain JS; TS fails to parse |
| Non-literal `meta` | The harness requires a static, pure-literal meta object |
| Malformed JS | Scripts that cannot parse are rejected |

Scripts that pass the lint are valid-by-construction for the Workflow sandbox.

## Invocation (Inc 0)

```js
// On-demand invocation via scriptPath (name-based resolution is Inc 1):
Workflow({ scriptPath: "workflows/canon-probe.js" })
```

## Registered Scripts

| Script | Role | Status |
|--------|------|--------|
| `canon-probe.js` | Harness-upgrade-stability canary | active |

## Relationship to Other Concepts

| Concept | Relation |
|---------|---------|
| `loops/` | Periodic observation artifacts (different from in-turn orchestration) |
| `routines/` | Managed scheduled-task definitions |
| `.claude/workflows/` | Install target for name-based resolution (Inc 1+; populated from here) |
