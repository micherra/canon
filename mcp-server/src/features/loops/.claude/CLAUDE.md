# features/loops/ — Loop Framework Bounded Context

## Purpose

Implements the Loop-as-Artifact framework's MCP layer. Loops are Canon's managed
periodic-observation artifact class — authored as `loops/*.md` files, registered
via `list_loops`, and dispatched by the orchestrator via CronCreate.

## Directory-as-Registry Invariant

The `loops/` directory at the repo root IS the loop registry. Every `loops/<id>.md`
file is a loop definition. There is no hardcoded catalog; the registry is queried
via `list_loops`. This mirrors how `principles/` is the principle registry.

## Contents

| File/Directory | Purpose |
|----------------|---------|
| `loop-schema.ts` | Zod schema + `LoopDefinition` type + `parseLoopDefinition`. Pure leaf module — no I/O. Enforces the mechanical determinism guardrail (dc-05). |
| `load-loops.ts` | `loadLoopsFromDir(dir)` — reads `loops/*.md`, parses frontmatter with gray-matter, calls `parseLoopDefinition`. Returns `{ valid, invalid, validBodies }`. Never silently drops invalid definitions. |
| `tools/list-loops.ts` | `listLoopsHandler` — loads all loops, filters to `status:active`, applies optional `lifecycle_hook` + `tier` filters. Always returns `invalid[]`. |
| `tools/get-loop-definition.ts` | `getLoopDefinitionHandler` — loads a single loop by id, returns definition + body. Used by the `/canon:loop-tick` runner. |
| `__tests__/` | Vitest unit tests: schema, loader, and tool integration tests. |

## Loader Contract

`loadLoopsFromDir(dir)` returns:
- `valid: LoopDefinition[]` — successfully parsed definitions
- `invalid: { file: string; error: string }[]` — failed definitions with filename, never dropped
- `validBodies: Record<string, string>` — markdown body (the action prompt) keyed by id

ENOENT → returns `{ valid: [], invalid: [] }` (mirrors matcher.ts ENOENT swallow).

## Mechanical Determinism Guardrail (dc-05)

Enforced at parse time in `parseLoopDefinition`:
1. `mode === "self-paced"` + `guardrails.mutates_build === true` → rejected
2. `guardrails.mutates_build === false` + forbidden tool in `observe.tools`/`observe.mcp` → rejected
   - **Bash read-only carve-out (decision loops-phase-b-01):** `Bash` is dual-use. When
     `mutates_build: false` and `Bash ∈ observe.tools`, it is admitted ONLY if
     `observe.shell_commands` is non-empty and every entry matches `READ_ONLY_SHELL_COMMANDS`.
     An empty `shell_commands` → rejected. A mutating subcommand (e.g. `git push`) → rejected,
     naming the offending command. `Write`, `Edit`, `NotebookEdit` remain unconditionally rejected —
     the carve-out is `Bash`-only.
3. `on_transition.field` not in `state.snapshot` → rejected (superRefine cross-field)
4. `id !== idFromFilename` → rejected

This guardrail predates the first self-paced loop (Phase C) — it's encoded in Phase A
so future authors cannot bypass it by omission.

## Phase Boundary

Phase A: schema + loader + tools + `_probe` demo loop; no production loop fires.
Phase B: `loops/ship-watch.md` added — first real loop, dispatched post-ship.
Phase C (current): self-paced mode + ScheduleWakeup + `loops/session-watch.md`; `BUILTIN_FORBIDDEN_MCP` denylist + `max_wall` schedule field added to schema (ADR-0002 first-tick-baseline invariant formalised).

## Non-Declarative Constraint (dc-06)

A plugin CANNOT auto-start a loop. Loops run ONLY when the orchestrator calls
`CronCreate` at a named lifecycle moment. Authoring a `loops/*.md` registers the
loop's definition; it does NOT start it.
