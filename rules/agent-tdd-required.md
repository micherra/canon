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

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|----------------|----------------|
| "This logic is too simple to need a test first." | Simple code still has edge cases, and tests written after implementation suffer from confirmation bias — they verify what the code does, not what it should do. | Write the failing test first regardless of perceived simplicity. If the test takes 30 seconds, the cycle cost is negligible. |
| "I'll add tests after I get it working." | Post-hoc tests don't drive the design. They chase the implementation rather than specify the contract, and routinely miss cases the implementor never thought about. | Stop. Write the failing test now. If code exists without a test, delete or comment it out and start the cycle properly. |
| "The plan doesn't mention tests, so I can skip them." | The plan describes behavior to implement, not the process to use. TDD is a process rule, not a plan artifact — it applies regardless of whether the plan mentions tests. | Write tests for every behavior the plan specifies. The plan's silence on tests is not permission to skip them. |
| "I'm just wiring things together — there's no logic to test." | Wiring code that crosses module boundaries has behavior: it connects things, passes arguments, returns results. Bugs in wiring are among the hardest to diagnose. | Apply the trivial-wiring exception only for pure re-exports or DI registration with zero branching. Everything else gets a test. |
