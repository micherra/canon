---
id: prefer-composition-over-inheritance
title: Prefer Composition Over Inheritance
severity: strong-opinion
scope:
  layers: []
tags:
  - patterns
  - coupling
  - refactoring-guru
---

Favor object composition and delegation over class inheritance for behavior reuse. Inheritance creates tight coupling between parent and child: the child depends on the parent's implementation details, the hierarchy is rigid and hard to change, and deep inheritance chains make behavior difficult to trace. Use composition — give objects the behaviors they need as components — unless there is a genuine "is-a" relationship where the subclass reuses most of the parent's behavior without overriding it.

## Rationale

Inheritance is the strongest form of coupling in object-oriented code. A subclass inherits not just the parent's interface but its implementation, internal state, and assumptions. When the parent changes, the child can break in surprising ways (the fragile base class problem). Deep hierarchies (`AdminUser extends User extends BaseEntity extends Auditable extends Serializable`) make it nearly impossible to understand what a class actually does without reading five files.

Composition achieves the same code reuse with much weaker coupling. Instead of inheriting `Serializable`, a class *contains* a serializer. Instead of extending `BaseEntity` for audit fields, a class delegates to an audit tracker. Each composed component can be tested, replaced, and understood independently.

AI-generated code heavily favors inheritance because training data is full of textbook OOP examples. Asked to "add audit logging to User," the LLM generates `class User extends AuditableEntity` rather than injecting an `AuditTracker` — the `extends` keyword is the shortest path to reuse in the training distribution, even though it creates the tightest possible coupling.

## Examples

**Bad — behavior reuse through deep inheritance:**

```typescript
class BaseEntity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  save() { /* ... */ }
  delete() { /* ... */ }
}

class AuditableEntity extends BaseEntity {
  auditLog: AuditEntry[];
  logChange(change: string) { /* ... */ }
}

class SoftDeletableEntity extends AuditableEntity {
  deletedAt: Date | null;
  override delete() { this.deletedAt = new Date(); this.save(); }
}

class User extends SoftDeletableEntity {
  email: string;
  name: string;
  // User inherits: id, createdAt, updatedAt, auditLog, deletedAt,
  // save(), delete(), logChange() — most of which it didn't ask for
}
```

**Good — behavior reuse through composition:**

```typescript
class User {
  id: string;
  email: string;
  name: string;

  private persistence: EntityPersistence;
  private audit: AuditTracker;
  private softDelete: SoftDelete;

  constructor(deps: { persistence: EntityPersistence; audit: AuditTracker }) {
    this.persistence = deps.persistence;
    this.audit = deps.audit;
    this.softDelete = new SoftDelete(deps.persistence);
  }

  async save() {
    await this.persistence.save(this);
    this.audit.log("saved");
  }

  async delete() {
    await this.softDelete.markDeleted(this.id);
    this.audit.log("deleted");
  }
}
```

Each behavior (persistence, auditing, soft-delete) is an independent, testable component. User can use exactly the behaviors it needs without inheriting unrelated ones.

## Exceptions

Framework-mandated inheritance (React class components in legacy code, Django views, Java servlets) is acceptable — you can't avoid it. True "is-a" relationships where a subclass genuinely *is* a specialized version of the parent — and uses most of its behavior unchanged — are fine for inheritance. The test: does the subclass override more than ~30% of the parent's methods? If yes, it's not really an "is-a" — it's using inheritance to borrow a few methods, which composition does better.
