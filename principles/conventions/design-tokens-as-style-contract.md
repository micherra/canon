---
id: design-tokens-as-style-contract
title: Design Tokens Are the Style Contract
severity: convention
scope:
  layers:
    - ui
  file_patterns:
    - "**/*.css"
    - "**/*.scss"
    - "**/*.module.css"
    - "**/*.styled.*"
    - "**/*.tsx"
    - "**/*.vue"
tags:
  - ui
  - css
  - design-systems
  - theming
---

Use design tokens — named, semantic variables for color, spacing, typography, and other visual properties — as the shared contract between design and code. Components reference tokens (`--color-primary`, `--spacing-md`, `--font-size-body`) rather than hardcoded values (`#3b82f6`, `16px`, `1rem`). Tokens are the single source of truth for the visual language and the only coupling point between independently developed UI modules.

## Rationale

*Frontend Architecture for Design Systems* establishes that a sustainable design system needs a layer of abstraction between design intent and implementation detail. Hardcoded values scatter design decisions across hundreds of files — changing the primary brand color means a find-and-replace across the entire codebase with no guarantee you found every instance.

In micro-frontend architectures, tokens become even more critical. *The Art of Micro Frontends* emphasizes that independently deployed modules need a shared visual language without shared code. Tokens achieve this: each micro frontend imports the same token set (via CSS custom properties, a JSON token file, or a shared package) and applies it locally. The result is visual consistency without runtime coupling.

AI-generated code rarely uses tokens — it reaches for whatever literal value produces the correct visual output. Left unchecked, this creates a codebase where `#3b82f6` appears 47 times across 30 files, some of which should actually be `--color-interactive` and some `--color-info`, but all accidentally share the same hex value today.

## Examples

**Bad — hardcoded values everywhere:**

```tsx
const Card = styled.div`
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  font-family: 'Inter', sans-serif;
  color: #111827;

  h3 {
    font-size: 18px;
    margin-bottom: 8px;
  }

  p {
    font-size: 14px;
    color: #6b7280;
  }
`;
```

Changing the border radius system-wide means finding every `8px` and guessing which ones are border radii versus spacing.

**Good — tokens express design intent:**

```tsx
const Card = styled.div`
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
  box-shadow: var(--shadow-sm);
  font-family: var(--font-family-body);
  color: var(--color-text-primary);

  h3 {
    font-size: var(--font-size-lg);
    margin-bottom: var(--spacing-sm);
  }

  p {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
`;
```

A theme change updates the token definitions in one file. Dark mode swaps `--color-surface` from `#ffffff` to `#1f2937` and every component adapts automatically.

## Exceptions

Values with no semantic meaning that would never appear in a design token scale — single-use pixel adjustments for optical alignment, animation keyframe percentages, and truly unique layout dimensions — are fine as hardcoded values. The test: does this value belong to a system-wide scale (color, spacing, typography, radius, shadow)? If yes, it should be a token. If it's a one-off magic number with no design-system equivalent, hardcode it.
