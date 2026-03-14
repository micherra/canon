---
id: prefer-immutable-data
title: Prefer Immutable Data by Default
severity: strong-opinion
scope:
  languages:
    - typescript
    - python
  layers:
    - domain
    - shared
tags:
  - immutability
  - predictability
  - clean-code
---

Variables, parameters, and data structures should be immutable by default. Use `const` over `let`, `readonly` over mutable properties, `Readonly<T>` over bare types, frozen objects over mutable ones. Mutable state should be the exception that requires justification — an explicit, scoped decision, not the default. Every mutable variable is a variable whose value you can't trust without reading every line between assignment and use.

## Rationale

Mutable state is the root cause of an entire class of bugs: stale references, race conditions, unexpected side effects from shared objects, aliasing bugs where two variables point to the same mutable object and one mutates it. Immutability eliminates all of these by making data trustworthy — once assigned, it doesn't change. *A Philosophy of Software Design* identifies unnecessary mutability as a source of cognitive load because every mutable variable forces readers to track "what is its value *right now*?"

AI-generated code defaults to `let` everywhere and builds mutable objects with mutation methods, because LLMs generate code linearly and mutation is the simplest pattern to emit token-by-token. The result is code riddled with unnecessary mutability that the developer then has to audit for safety.

## Examples

**Bad — mutable by default:**

```typescript
let user = getUser(id);          // let, but never reassigned
let items = [];                   // mutated via push
items.push(order.item);
let total = 0;                    // accumulator pattern
for (const item of items) {
  total += item.price;
}
user.status = "active";           // direct mutation of shared object

function processOrder(order: Order) {
  order.status = "processed";     // mutates the input — caller doesn't expect this
  return order;
}
```

**Good — immutable by default, mutation scoped and justified:**

```typescript
const user = getUser(id);         // const — never reassigned
const items = [order.item];       // constructed, not mutated
const total = items.reduce((sum, item) => sum + item.price, 0);

const activeUser: User = { ...user, status: "active" };  // new object, original unchanged

function processOrder(order: Readonly<Order>): Order {
  return { ...order, status: "processed" };  // returns new object, input untouched
}
```

```python
# Python: use frozen dataclasses and tuples
from dataclasses import dataclass

@dataclass(frozen=True)
class User:
    id: str
    name: str
    status: str

# Create new instance instead of mutating
active_user = User(id=user.id, name=user.name, status="active")
```

## Exceptions

Performance-critical inner loops where allocation matters (e.g., game engines, real-time audio processing) may justify mutable buffers. Builder patterns for constructing complex objects are acceptable — the mutability is scoped to the construction phase. State management stores (Redux, Zustand) have controlled mutation through reducers/actions — this is acceptable because mutation is channeled through a single controlled path.

**Related:** `no-hidden-side-effects` — mutating shared objects is a hidden side effect. `information-hiding` — immutable data simplifies the contract a module exposes.
