---
id: colocate-component-assets
title: Colocate Component Assets
severity: convention
scope:
  layers:
    - ui
  file_patterns:
    - "src/components/**"
    - "src/ui/**"
    - "packages/**"
    - "apps/**"
tags:
  - ui
  - components
  - project-structure
  - design-systems
---

Keep everything a component needs — its implementation, styles, tests, stories, and types — in the same directory. Don't scatter a component's pieces across parallel directory trees (`components/`, `styles/`, `tests/`, `types/`). When you delete a component, one `rm -rf` should remove everything related to it.

## Rationale

*Frontend Architecture for Design Systems* emphasizes that a design system's sustainability depends on how easily components can be added, modified, and removed. When a component's styles live in `styles/components/button.scss`, its tests in `tests/components/button.test.tsx`, and its stories in `stories/components/button.stories.tsx`, deleting the component means hunting through three directories. Worse, orphaned files accumulate — the style file outlives the component because nobody realized it existed.

AI-generated code almost never proposes colocated structures — it produces flat directories or scatters files across parallel trees by default, because training data contains both patterns and the flat layout requires fewer directory-creation decisions. Left unchecked, this creates the scattered layout that makes cleanup painful.

Colocation also reduces the cognitive overhead of working on a component. Opening one folder reveals everything: the implementation, how it's styled, how it's tested, and how it's documented. No context-switching between directory trees.

In larger codebases with multiple teams, colocation makes ownership clear. The team that owns `packages/checkout/src/CartSummary/` owns everything in that folder — no ambiguity about who maintains the test file three directories away.

## Examples

**Bad — assets scattered across parallel trees:**

```
src/
  components/
    Button.tsx
    CartSummary.tsx
  styles/
    Button.module.css
    CartSummary.module.css
  tests/
    Button.test.tsx
    CartSummary.test.tsx
  stories/
    Button.stories.tsx
    CartSummary.stories.tsx
  types/
    Button.types.ts
    CartSummary.types.ts
```

Adding a new component means creating files in five directories. Deleting one means remembering to clean up five directories.

**Good — everything colocated:**

```
src/
  components/
    Button/
      Button.tsx
      Button.module.css
      Button.test.tsx
      Button.stories.tsx
      index.ts
    CartSummary/
      CartSummary.tsx
      CartSummary.module.css
      CartSummary.test.tsx
      CartSummary.stories.tsx
      index.ts
```

One folder per component. Delete the folder, and every artifact goes with it. Add a component, and everything starts in one place.

## Exceptions

Truly shared type definitions that multiple components import (e.g., `Theme`, `DesignTokens`) belong in a shared location, not duplicated inside each component folder. Global styles (resets, token definitions) are cross-cutting by nature and live at the project root, not inside a component. End-to-end tests that exercise multi-component flows belong in a top-level `e2e/` directory since they don't map to a single component.

**Related:** `single-source-of-component-styles` enforces that a component's styles come from one file — colocation ensures that file lives next to the component. `component-single-responsibility` ensures each colocated folder maps to one coherent purpose.
