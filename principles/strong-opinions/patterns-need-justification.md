---
id: patterns-need-justification
title: Every Pattern Must Justify Its Complexity
severity: strong-opinion
scope:
  layers: []
tags:
  - patterns
  - simplicity
  - refactoring-guru
---

Every design pattern introduces indirection, abstraction, and complexity. A pattern is justified only when two conditions are met: (1) the problem it solves is present *today*, not hypothetically, and (2) the programming language doesn't provide a simpler built-in mechanism that achieves the same goal. Before implementing a Strategy, Observer, Factory, or Decorator, ask: "Does my language already solve this?"

## Rationale

Design patterns were cataloged in 1994 for C++ and Smalltalk. Modern languages have first-class functions, closures, mixins, decorators, generators, async/await, and event systems that eliminate the need for many classical patterns. A Strategy pattern in Java requires an interface and implementation classes. In TypeScript or Python, it's a callback parameter. An Observer in Java requires a Subject and Observer interface. In JavaScript, it's `EventEmitter.on()`.

AI-generated code is especially prone to pattern overuse. LLMs have seen thousands of examples of pattern implementations in training data, so they readily generate Factory classes, Strategy hierarchies, and Observer boilerplate even when the language provides simpler alternatives. Each unnecessary pattern adds classes, interfaces, and indirection that cost comprehension.

This complements `no-dead-abstractions` (which targets interfaces with single implementations). This principle targets patterns more broadly — even a well-implemented pattern is wrong if the language provides a simpler alternative.

## Examples

**Bad — Strategy pattern when a function parameter suffices:**

```typescript
interface SortStrategy {
  sort(items: number[]): number[];
}

class AscendingSortStrategy implements SortStrategy {
  sort(items: number[]): number[] { return [...items].sort((a, b) => a - b); }
}

class DescendingSortStrategy implements SortStrategy {
  sort(items: number[]): number[] { return [...items].sort((a, b) => b - a); }
}

class Sorter {
  constructor(private strategy: SortStrategy) {}
  sort(items: number[]): number[] { return this.strategy.sort(items); }
}

const sorter = new Sorter(new AscendingSortStrategy());
```

**Good — use the language's built-in mechanism:**

```typescript
function sortItems(items: number[], compare: (a: number, b: number) => number): number[] {
  return [...items].sort(compare);
}

sortItems(data, (a, b) => a - b); // ascending
sortItems(data, (a, b) => b - a); // descending
```

**Bad — Observer pattern when EventEmitter exists:**

```typescript
interface Observer { update(event: string, data: unknown): void; }
interface Subject {
  attach(observer: Observer): void;
  detach(observer: Observer): void;
  notify(event: string, data: unknown): void;
}
// + concrete implementations...
```

**Good — use built-in event system:**

```typescript
const emitter = new EventEmitter();
emitter.on("orderCreated", (order) => sendConfirmation(order));
emitter.on("orderCreated", (order) => updateInventory(order));
emitter.emit("orderCreated", order);
```

## Exceptions

Patterns are justified when they solve a real, present problem that language features don't address well. A genuine Factory Method is warranted when subclasses need to create different product types and the creation logic is complex. A genuine Decorator is warranted when you need to dynamically compose behaviors at runtime in a way that function composition can't express cleanly. The test: would removing the pattern make the code significantly harder to extend for a use case that exists *today*?
