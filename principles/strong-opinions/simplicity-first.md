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

## Exceptions

Security-critical paths (auth, payment, data access control) deserve explicit layering even when it feels heavy. Also, if you're building a module that genuinely has multiple implementations today (not hypothetically), an interface is earned.

**Related:** `no-dead-abstractions` and `patterns-need-justification` are specific manifestations of this principle — the first targets interfaces with single implementations, the second targets design patterns that the language already solves natively.
