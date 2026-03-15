---
id: single-source-of-component-styles
title: One Component, One Style Source
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
  - modularity
---

Every component's visual appearance should be defined in exactly one location — the component's own style file or co-located style block. Never style a component from outside by reaching in with selectors from a parent or sibling. If a component needs to look different in a certain context, use modifiers (props, variants, or CSS custom properties) defined within that component's own style source.

## Rationale

Micah Godbolt's *Frontend Architecture for Design Systems* identifies the "single source of truth" as the foundation of sustainable CSS architecture. When a component's styles come from one place, you can change or delete that component with full confidence about what will and won't break. When styles leak across files — a parent overriding a child's `h2`, a utility class applied in a template but defined three directories away — the system becomes fragile. You can never safely remove a class because you don't know who depends on it from where.

This problem compounds in micro-frontend architectures. If team A styles team B's component through external selectors, deployment order matters, specificity wars emerge, and a CSS change in one module breaks the layout of another. Florian Rappl's *The Art of Micro Frontends* emphasizes that each micro frontend must own its styling completely, with no external style dependencies, to maintain deployment independence.

## Examples

**Bad — styles defined outside the component:**

```scss
// pages/dashboard.scss — reaching into a child component
.dashboard {
  .user-card {
    padding: 24px;          // overrides UserCard's own padding
    .user-card__name {
      font-size: 18px;      // dashboard dictates UserCard's typography
    }
  }
}

// components/sidebar.scss — also styling UserCard
.sidebar .user-card {
  padding: 12px;            // different override from a different parent
}
```

Now `UserCard` looks different depending on where it appears, and those rules live in files that `UserCard`'s team doesn't own.

**Good — component owns all its styles, parents use variants:**

```scss
// components/user-card.module.scss — single source of truth
.userCard {
  padding: 16px;
}

.userCard--compact {
  padding: 8px;
}

.name {
  font-size: 16px;
}

.userCard--compact .name {
  font-size: 14px;
}
```

```tsx
// Dashboard passes a variant prop, not external CSS
<UserCard variant="compact" user={user} />
```

All style decisions for `UserCard` live in one file. Parents communicate layout needs through props, not CSS overrides.

## Exceptions

Global reset/normalize stylesheets and design token definitions are intentionally cross-cutting and don't belong to any single component. Layout components (grid, flex containers) may legitimately set spacing on children via gap or margin on direct children — this is layout responsibility, not component styling. CSS-in-JS solutions that generate scoped class names (CSS Modules, styled-components) enforce this principle by default.
