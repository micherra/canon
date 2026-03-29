---
id: agent-tdd-required
title: Test-Driven Development Required
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - implementor
  - testing
  - tdd
---

Implementor agents must follow the red-green-refactor cycle: write a failing test that specifies the desired behavior, write the minimal code to make it pass, then refactor. Code must not be written before its corresponding test exists and fails.

## Rationale

Tests written after implementation suffer from confirmation bias — they verify what the code does, not what it should do, and routinely miss edge cases the implementation never considered. Writing the test first forces clear inputs, outputs, and boundaries. The short iteration loop (minutes, not hours) keeps the implementor aligned with the plan rather than drifting.

The refactor step is where the cycle pays compound interest. Because tests are green and trusted, cleanup happens without fear. Without TDD, refactoring is risky and deferred — leading to structural debt.

## Examples

**Bad — implementor writes code first, adds tests afterward:**

```
1. Read plan
2. Write src/services/order.ts (full implementation)
3. Write src/services/order.test.ts (tests to match)
4. Commit
```

**Good — implementor follows red-green-refactor per behavior:**

```
1. Read plan
2. Write failing test: "createOrder returns error for insufficient stock"
3. Write minimal code in order.ts to pass
4. Write failing test: "createOrder returns order on success"
5. Write minimal code to pass
6. Refactor: extract shared setup, improve naming
7. Commit
```

## Exceptions

- **Exploratory spikes**: Throwaway code investigating an API or algorithm before committing to an approach. Spikes must be deleted or rewritten with TDD before merging.
- **Trivial wiring**: Thin glue code with no logic (re-exporting a module, wiring DI) may skip the cycle.
