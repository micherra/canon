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
| PR #364 | ADR mechanism | `docs/adr/0001-adr-template-placement.md` — "first real ADR, dogfooded" |

No counter-instance was found where a mechanism shipped without a first instance.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The mechanism is complete — the instance can come in a follow-up." | A mechanism without an instance has no production validation. The follow-up rarely arrives before the first real user hits an unknown failure mode. | Add the minimal instance to the same PR. |
| "The template is the reference example." | A template describes the shape; a real instance proves the pipeline. | Produce one real instance alongside the template. |
| "The first instance will be written by the feature that uses this mechanism." | That feature build inherits the debugging cost for the first-use failure. | Absorb the minimal cost in the mechanism's own build. |

## Verification

- [ ] The build that introduces a new artifact class, registry, or workflow gate also includes at least one file that passes through the mechanism's full path.
- [ ] The instance is tracked (committed), minimal, and real — not a stub or placeholder.
