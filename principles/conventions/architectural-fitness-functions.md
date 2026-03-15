---
id: architectural-fitness-functions
title: Enforce Architecture with Automated Tests
severity: convention
scope:
  layers:
    - infra
  file_patterns:
    - "**/test/**"
    - "**/tests/**"
    - "**/__tests__/**"
    - "**/.github/**"
    - "**/ci/**"
tags:
  - architecture
  - testing
  - hard-parts
---

Key architectural constraints — dependency direction, layer violations, module boundaries, import rules, naming conventions — should be enforced by automated tests (fitness functions). Architecture that exists only in documentation, ADRs, or tribal knowledge will erode over time. Write tests that fail when architectural rules are violated: domain must not import from infrastructure, no circular dependencies between modules, services must not share database schemas.

## Rationale

*Software Architecture: The Hard Parts* introduces architectural fitness functions as the primary mechanism for preventing architectural erosion. Every architecture has rules: "the domain layer doesn't depend on the data layer," "services communicate through events, not shared databases," "all API responses use the standard envelope format." Without automated enforcement, these rules last until someone is in a hurry and takes a shortcut. Over time, the shortcuts accumulate and the architecture becomes a fiction — documented one way, implemented another.

The failure mode: the team agrees on clean architecture with strict layer separation. Six months later, the domain layer has 15 direct imports from the data layer because nobody caught them in code review. The architecture diagram on the wiki shows clean layers; the actual codebase is a tangled graph. By the time someone notices, untangling the violations requires a multi-sprint effort.

## Examples

**Bad — architecture rules enforced only by documentation:**

```markdown
<!-- architecture.md -->
## Rules
1. Domain layer must not import from infrastructure
2. No circular dependencies between modules
3. All API responses use the ResponseEnvelope type
<!-- Nobody reads this. Nobody enforces it. It's fiction. -->
```

**Good — architecture rules enforced by automated tests:**

```typescript
// tests/architecture/layer-boundaries.test.ts
import { glob } from "glob";
import { readFile } from "fs/promises";

test("domain layer does not import from infrastructure", async () => {
  const domainFiles = await glob("src/domain/**/*.ts");

  for (const file of domainFiles) {
    const content = await readFile(file, "utf-8");
    const infraImports = content.match(/from ['"].*\/(infra|infrastructure)\//g);

    expect(infraImports).toBeNull(),
      `${file} imports from infrastructure layer: ${infraImports}`;
  }
});

test("no circular dependencies between modules", async () => {
  const result = await exec("npx madge --circular src/");
  expect(result.stdout).toContain("No circular dependency found");
});

test("all API handlers return ResponseEnvelope", async () => {
  const handlerFiles = await glob("src/api/**/*.handler.ts");

  for (const file of handlerFiles) {
    const content = await readFile(file, "utf-8");
    expect(content).toContain("ResponseEnvelope"),
      `${file} does not use ResponseEnvelope type`;
  }
});
```

```javascript
// .eslintrc.js — import rules as lint config
module.exports = {
  rules: {
    "import/no-restricted-paths": ["error", {
      zones: [
        { target: "./src/domain", from: "./src/infra", message: "Domain must not import from infra" },
        { target: "./src/domain", from: "./src/api", message: "Domain must not import from API layer" },
      ],
    }],
    "import/no-cycle": "error",
  },
};
```

## Exceptions

Prototypes and proof-of-concept code where the architecture is still being discovered — adding fitness functions too early constrains exploration. Very small projects (under ~10 files) where the overhead of architectural tests exceeds their benefit. The cost-benefit threshold: if a rule has been violated more than once, it's worth automating.
