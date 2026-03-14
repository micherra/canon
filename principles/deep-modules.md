---
id: deep-modules
title: Deep Modules, Simple Interfaces
severity: strong-opinion
scope:
  languages: []
  layers: []
tags:
  - complexity
  - api-design
  - ousterhout
---

Modules should expose simple interfaces and hide complex implementations. A module's public API surface should be small relative to the functionality it provides. If a module's interface is nearly as complex as its implementation, it adds complexity to the system without absorbing any.

## Rationale

Shallow modules — classes or functions with many parameters, many public methods, or complex configuration requirements — push complexity onto every caller. Each user of the module must understand its full surface area. Deep modules do the opposite: they provide powerful functionality behind a simple interface, so callers get a lot of value from learning very little.

The classic example is Unix file I/O: five functions (`open`, `close`, `read`, `write`, `lseek`) hide an enormous implementation spanning filesystems, permissions, buffering, device drivers, and network protocols. Every caller gets all that power for free. A shallow alternative would expose dozens of methods for each concern.

AI-generated code tends toward shallow modules because LLMs generate what looks structurally complete — lots of small methods with minimal implementation. This creates a large surface area that costs every future prompt in context and comprehension.

## Examples

**Bad — shallow module with large interface and trivial methods:**

```typescript
class UserService {
  getUserById(id: string) { return this.db.find(id); }
  getUserByEmail(email: string) { return this.db.findByEmail(email); }
  getUserByUsername(name: string) { return this.db.findByUsername(name); }
  getUsersByRole(role: string) { return this.db.findByRole(role); }
  getUsersByStatus(status: string) { return this.db.findByStatus(status); }
  getUsersByCreatedDate(from: Date, to: Date) { return this.db.findByDate(from, to); }
  getUserCount() { return this.db.count(); }
  getUserCountByRole(role: string) { return this.db.countByRole(role); }
  // 12 more pass-through methods...
}
```

Each method does almost nothing — the interface is as complex as the implementation.

**Good — deep module with simple interface hiding real work:**

```typescript
class UserService {
  find(query: UserQuery): Promise<User[]> {
    // Internally handles: query parsing, index selection, caching,
    // pagination, permission filtering, and result transformation
    // Callers just describe what they want.
  }

  create(input: CreateUserInput): Promise<UserResult> {
    // Internally handles: validation, password hashing, uniqueness checks,
    // default role assignment, welcome email, and audit logging
  }

  deactivate(userId: string, reason: string): Promise<UserResult> {
    // Internally handles: session invalidation, scheduled data cleanup,
    // notification to admins, and audit trail
  }
}
```

Three methods, each doing substantial work. The interface is simple; the implementation is deep.

## Exceptions

Utility modules that intentionally provide a flat collection of independent functions (string helpers, math utilities) are naturally shallow and that's fine — they're not trying to hide complexity, they're providing building blocks. Also, modules at the edges of a system (HTTP handlers, CLI entry points) are often thin by design per the thin-handlers principle.
