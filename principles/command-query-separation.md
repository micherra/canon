---
id: command-query-separation
title: Commands and Queries Don't Mix
severity: strong-opinion
scope:
  layers:
    - domain
    - data
    - api
tags:
  - side-effects
  - predictability
  - clean-code
---

A method should either change state (a command) or return information (a query), but not both. Commands do work and return void. Queries return data and have no side effects. When a method both mutates and returns, callers can't tell whether they're asking a question or issuing an order, which makes the code harder to reason about and harder to test.

## Rationale

Methods that both mutate and return create subtle coupling between "reading" and "writing." If `stack.pop()` returns the top element AND removes it, you can't inspect the top element without modifying the stack. If `map.put(key, value)` returns the previous value, callers start depending on that return value even when they only intended to set something — and now removing the return value is a breaking change.

Separating commands from queries makes code predictable: you can call any query as many times as you want without side effects, and you can call any command knowing it won't sneak data back to you through a return value you might miss.

## Examples

**Bad — method both mutates and returns:**

```typescript
class UserService {
  // Saves the user AND returns whether it was an update vs. insert
  save(user: User): boolean {
    const existing = this.db.findById(user.id);
    if (existing) {
      this.db.update(user);
      return true; // was update
    }
    this.db.insert(user);
    return false; // was insert
  }
}

// Caller: did I just ask a question or issue a command? Both.
const wasUpdate = userService.save(user);
```

**Good — separate command and query:**

```typescript
class UserService {
  // Query: check existence (no side effects)
  exists(userId: string): boolean {
    return this.db.findById(userId) !== null;
  }

  // Command: save the user (no return value needed)
  save(user: User): void {
    if (this.exists(user.id)) {
      this.db.update(user);
    } else {
      this.db.insert(user);
    }
  }
}
```

**Another common violation — pop:**

```typescript
// Bad: pop both queries and commands
const top = stack.pop(); // Returns AND removes — two things at once

// Good: separate peek (query) and remove (command)
const top = stack.peek();
stack.remove();
```

## Exceptions

Fluent/builder APIs intentionally return `this` to enable chaining (`builder.setName("x").setAge(5).build()`) — the return value is for API ergonomics, not for conveying information. Also, atomic operations like `compareAndSwap`, `getAndIncrement`, or `Map.computeIfAbsent` justifiably combine query and command for correctness in concurrent contexts.

**Related:** `no-hidden-side-effects` is the broader principle — all side effects must be visible in the function's name or signature. CQS is a specific structural rule: don't mix mutation and return values in the same method. A function can satisfy CQS (returns void, clearly a command) but violate no-hidden-side-effects if its name doesn't reveal what it mutates.
