---
id: simplicity-first
title: The Simplest Thing That Could Work
severity: strong-opinion
scope:
  layers: []
tags:
  - simplicity
  - architecture
  - ai-code-quality
---

When choosing between approaches, pick the one with fewer concepts, fewer files, and fewer layers of indirection. Add complexity only when the current approach has demonstrably failed — not when you anticipate it might.

## Rationale

AI-generated code has a strong bias toward over-engineering. Left unchecked, an LLM will produce abstractions "just in case," add factory patterns for single implementations, and create folder hierarchies that anticipate scale you'll never reach.

Every layer of abstraction is a tax on future comprehension. In a codebase that's primarily AI-generated and AI-maintained, comprehension cost is paid by every future prompt — both human and machine. Simplicity is a direct investment in the productivity of the entire AI-assisted workflow.

## Examples

**Bad — premature abstraction:**

```typescript
// Factory pattern for a single implementation
interface NotificationStrategy {
  send(user: User, message: string): Promise<void>;
}

class EmailNotificationStrategy implements NotificationStrategy {
  async send(user: User, message: string) {
    await sendEmail(user.email, message);
  }
}

class NotificationFactory {
  static create(type: string): NotificationStrategy {
    switch (type) {
      case "email": return new EmailNotificationStrategy();
      default: throw new Error(`Unknown: ${type}`);
    }
  }
}

const notifier = NotificationFactory.create("email");
await notifier.send(user, "Welcome!");
```

**Good — direct and obvious:**

```typescript
// Just call the function. Add the abstraction when you have two notification channels.
await sendEmail(user.email, "Welcome!");
```

This includes dead abstractions: every interface, base class, and generic type parameter must have more than one concrete user *today*. If an interface has a single implementation, it's not an abstraction — it's indirection. Don't create `IUserRepository` with a single `PrismaUserRepository`. Just export the functions directly and add the interface when the second implementation arrives.

## Exceptions

Security-critical paths (auth, payment, data access control) deserve explicit layering even when it feels heavy. Also, if you're building a module that genuinely has multiple implementations today (not hypothetically), an interface is earned. Interfaces required by DI frameworks are acceptable.

**Related:** `patterns-need-justification` applies the same lens to design patterns rather than interfaces.
