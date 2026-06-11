---
id: mechanism-ships-first-instance
title: A New Mechanism Must Ship Its Own First Instance
severity: convention
scope:
  layers: []
  file_patterns:
    - "principles/**"
    - "agents/**"
    - "loops/**"
    - "routines/**"
    - "docs/adr/**"
    - "CLAUDE.md"
    - "references/**"
    - "mcp-server/src/**"
    - "**/mcp-server/src/**"
    - "hooks/**"
    - "**/hooks/**"
    - ".github/**"
    - "**/.github/**"
    - "templates/**"
    - "**/templates/**"
tags: []
---

When a build introduces a new Canon mechanism — a new artifact class, tracked template system, registry, or workflow gate — the build MUST ship at least one real instance of that mechanism in the same PR. The first instance must be minimal (a probe, a single example, or the smallest valid input), but it must be real: it passes through the mechanism's full path, lands in the tracked repository, and can serve as a reference for the next author.

A mechanism that ships without any instance is incomplete: it has no end-to-end validation and no reference example.

## The Pattern

The instance is typically produced as the last step of the `implement` state: create the mechanism, then produce the minimal instance using the mechanism itself. This is the "dogfood" step — it proves the schema→registry→runtime path and demonstrates the format.

**Instance requirements:**
- Real, not synthetic — it must be a genuine use case, not a placeholder.
- Minimal — the smallest valid input that exercises the mechanism's full path.
- Tracked — it must land in the repository so it is discoverable as a reference.

## Rationale

Shipping a mechanism without any instance creates a latent gap: the mechanism is untested in the real repo, the artifact type lands empty, and the next build that tries to use it encounters unknown failure modes for the first time in a production context. The cost of debugging a first-use failure mid-build is higher than the cost of producing the minimal first instance during the mechanism's own build.

The first instance also serves as the reference example for future authors. Without it, the next author has only the template to reference.

Four consecutive Canon builds (2026-05-20 to 2026-06-09) each shipped a first instance alongside the mechanism they introduced. In every case the first-instance step was explicitly described as deliberate validation:

| Build | Mechanism introduced | First instance shipped |
|-------|---------------------|------------------------|
| PR #224 | Two-layer principle authoring | `.canon/principle-overrides.yaml`, `skills/canon/skills/write-principle/SKILL.md` |
| PR #350 | Loops artifact class | `loops/_probe.md` — "proves schema→registry→runtime path" |
| PR #352 | Routines artifact class | `routines/canon-maintenance.md` + 2 others |
| PR #362 | Loops Phase B (ship-watch) | `loops/ship-watch.md` — "first production loop, dispatched via post-ship tap" |

No counter-instance was found where a mechanism shipped without a first instance.

## Examples

**Good — loops artifact class shipped with a probe instance in the same PR:**

```
PR #350 introduces the loops mechanism (schema, registry, list_loops MCP tool).
The same PR commits loops/_probe.md — a minimal real loop that passes through
schema validation, registry loading, and the list_loops response path.
Result: the schema→registry→runtime path is proven before merge.
```

**Bad — routines registry introduced without any registered routine:**

```
PR ships:
  routines/.claude/CLAUDE.md    ← index template
  mcp-server/src/features/routines/tools/list-routines.ts  ← registry tool
  mcp-server/src/features/routines/tools/sync-routines.ts  ← sync tool

No file under routines/ passes through the schema or registry loader.
Result: the sync path has no end-to-end validation; the next build that
creates a routine hits unknown failure modes first.
```

**Good — routines artifact class shipped with three registered routines:**

```
PR #352 introduces the routines mechanism (schema, registry, list_routines,
sync_routines MCP tools, generated index at routines/.claude/CLAUDE.md).
The same PR commits routines/canon-maintenance.md, routines/pr-review.md,
and routines/release-ahead.md — three real routines that pass through schema
validation, the registry loader, and the sync path.
Result: the schema→registry→sync pipeline is proven with real content before
any follow-on build tries to author a routine.
```

**Bad — workflow gate introduced with empty gate registry:**

```
PR ships:
  mcp-server/src/features/orchestration/tools/register-gates.ts
  references/gate-vocabulary.md

The gate registry is empty; no gate definition file is committed.
Result: any build that tries to fire a gate encounters the real schema
requirements for the first time under delivery pressure.
```

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The mechanism is complete — the instance can come in a follow-up." | A mechanism without an instance has no production validation. The follow-up rarely arrives before the first real user hits an unknown failure mode. | Add the minimal instance to the same PR. |
| "The template is the reference example." | A template describes the shape; a real instance proves the pipeline. | Produce one real instance alongside the template. |
| "The first instance will be written by the feature that uses this mechanism." | That feature build inherits the debugging cost for the first-use failure. | Absorb the minimal cost in the mechanism's own build. |

## Verification

- [ ] The build that introduces a new artifact class, registry, or workflow gate also includes at least one file that passes through the mechanism's full path.
- [ ] The instance is tracked (committed), minimal, and real — not a stub or placeholder.
