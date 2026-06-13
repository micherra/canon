---
id: simplicity-first
title: The Simplest Thing That Could Work
severity: strong-opinion
portable: true
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

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "We might need this abstraction later." | "Later" is unpredictable. Abstractions added speculatively are often wrong when the real need arrives — and they add maintenance cost until then. | Add the abstraction when the second concrete use case exists. Not before. |
| "This pattern is standard — everyone knows the factory pattern." | Familiarity doesn't justify complexity. A pattern that requires two extra files to make a single function call has a negative return on investment. | Evaluate the pattern against this codebase's actual needs, not general conventions. |
| "It's just one more layer of indirection." | Indirection compounds. Each layer doubles the number of files a reader must open to understand a code path. Three "just one more" decisions become an onion with no core. | Name the problem the layer solves. If the name is vague, the layer isn't needed yet. |
| "The interface makes it easier to test with mocks." | Single-implementation interfaces created solely for mocking indicate the real issue is tight coupling, not missing abstractions. | Break the coupling instead: use dependency injection via function parameters or constructor arguments, not interface hierarchies. |

## Verification

- [ ] No interface has a single implementing class — grep for `implements ` and check that each interface name used after `implements` has more than one implementing class in the codebase.
- [ ] No generic type parameters that are always instantiated with the same type — check for `<T>` functions or classes where `T` is always `string` or a single domain type at every call site.
