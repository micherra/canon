---
id: no-dead-abstractions
title: No Dead Abstractions
severity: strong-opinion
scope:
  layers: []
tags:
  - simplicity
  - architecture
  - ai-code-quality
---

Every interface, base class, generic type parameter, and abstraction layer must have more than one concrete user *today*. If an interface has a single implementation, it's not an abstraction — it's indirection.

## Rationale

LLMs love generating interfaces. They'll produce `IUserRepository` with a single `PrismaUserRepository`, `BaseService<T>` extended by one service, and generic wrappers instantiated with one type. Each doubles the surface area without providing any polymorphic benefit. When the second implementation arrives, the pre-built interface almost never fits.

## Examples

**Bad — interface with single implementation:**

```typescript
interface IUserRepository {
  findById(id: string): Promise<User | null>;
  create(data: CreateUserInput): Promise<User>;
}
class PrismaUserRepository implements IUserRepository { /* ... */ }
// Only ever used as: const repo: IUserRepository = new PrismaUserRepository();
```

**Good — direct module:**

```typescript
export async function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}
export async function createUser(data: CreateUserInput): Promise<User> {
  return prisma.user.create({ data });
}
```

## Exceptions

Interfaces required by DI frameworks are acceptable. Interfaces for external service clients can be justified for testing — but prefer a thin wrapper function you can stub.

**Related:** `simplicity-first` is the broader principle this derives from — every layer of abstraction must earn its keep. `patterns-need-justification` applies the same lens to design patterns rather than interfaces.
