---
title: Refactoring Patterns Domain
description: Refactoring as the earned third step of red-green-refactor, not an afterthought.
---

# Refactoring Patterns Domain

## Mental Models

**Refactoring Is the Third Step, Not an Afterthought** — In red-green-refactor, refactoring is earned by a passing test suite. Green tests give permission to restructure fearlessly because any regression surfaces immediately. Skipping the refactor step accumulates structural debt behind a green test suite — you have a safety net you never use, and the code degrades incrementally with each feature added. The discipline only works if you take all three steps.

**Extract, Don't Abstract Prematurely** — The first refactoring move is almost always extraction: pull out a function, a module, a type. Abstraction — interface, generic, pattern — comes only after you see 3+ concrete instances and can name what actually varies. One concrete case gives you nothing to abstract over. Two cases give you a guess. Three cases give you a pattern you can extract without over-constraining the fourth.

## Decision Frameworks

**What to refactor after green** — Four signals warrant refactoring: Duplication (the same 3+ lines appear in 2+ places — extract a function); shallow modules (a module's interface is as complex as its implementation — there is no depth being hidden, so the abstraction adds no value); feature envy (a function that uses more of another module's data than its own — it belongs in that other module); primitive obsession (passing 3+ related primitives where a named type would clarify intent and prevent argument-order bugs).

**When NOT to refactor** — The test is green but the code is read-once: a migration script, a one-time data fix, a spike prototype. Refactoring read-once code is polishing a throwaway. Also skip when you are mid-red: never restructure code while tests are failing. Earn the green first, then restructure with the safety net in place.

## Failure Modes

**Premature abstraction** — Introducing an interface after the first implementation. With one concrete case and zero variation, the abstraction adds indirection without earning generality. Future implementations must conform to an interface designed for a single example, which is often the wrong shape. The rule of three exists precisely to prevent this: wait for the third case before you name the pattern.

**Refactoring without green** — Restructuring code while tests are red or absent. Without a safety net, the refactoring introduces bugs invisibly. When tests eventually fail, you cannot tell whether the failure was introduced by the refactoring or was pre-existing. The discipline of red-green-refactor exists to keep the refactoring step safe; violating the sequence eliminates the safety.

## Guardrails

**One refactoring at a time** — Each refactoring is a separate commit or a separate green-to-green cycle. Combining rename, extract, and move in one step makes it impossible to bisect if something breaks. Small, named refactoring steps make the history readable and reversals surgical. If a single refactoring commit touches more than one structural concern, split it.

**Refactoring changes structure, not behavior** — If your "refactoring" requires changing a test assertion, it is not a refactoring. Either the original test was wrong, or you changed observable behavior. Refactoring is behavior-preserving by definition. Any required test change is a signal to stop and reconsider: either revert or acknowledge that you are making a behavioral change and treat it as a separate commit.
