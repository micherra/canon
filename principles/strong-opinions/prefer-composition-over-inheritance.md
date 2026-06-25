---
id: prefer-composition-over-inheritance
title: Prefer Composition Over Inheritance
severity: strong-opinion
portable: true
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

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "Inheritance is cleaner here — the subclass only adds two methods." | Adding two methods to a parent class means the subclass inherits all future changes to the parent. "Clean" today becomes fragile base class debt tomorrow. | Use composition: give the class the two behaviors it needs as injected components, not as a parent's methods. |
| "It's just one level of inheritance — not a deep hierarchy." | Every hierarchy starts at one level. The problem isn't today's depth; it's that inheritance invites extension at each level. One level becomes three in six months. | Prefer composition from the start. Adding composition later is straightforward; refactoring a deep hierarchy is not. |
| "The base class is small — it barely adds anything." | A small base class that "barely adds anything" is either useful (in which case, why not just import the functions directly?) or vestigial (in which case, delete it). | Import the shared logic as functions or inject it as a dependency. Inheritance is not the right tool for sharing utility logic. |
| "Extending the base class is the established pattern in this codebase." | Inherited patterns should be evaluated, not perpetuated. If the existing pattern creates tight coupling and deep hierarchies, adding to it compounds the technical debt. | Note the deviation in a code comment, use composition for new code, and flag the existing pattern for refactoring. |

## Verification

- [ ] No class `extends` another application class (non-framework) with more than one level of depth — grep for `extends` in non-test TypeScript files, excluding known framework base classes (Error, React.Component, etc.), and check for multi-level chains.
- [ ] No subclass overrides more than 30% of parent methods — for any `extends` relationship found, compare the method count of the parent against the number of `override` or same-named methods in the child.

## Related

- [[patterns-need-justification]] — many classical inheritance-based patterns (Template Method, Strategy via subclassing) lose their justification when the language offers first-class functions; composition and this principle are the modern alternative.
- [[information-hiding]] — composition hides the implementation of each injected dependency behind its own interface; inheritance exposes the parent's internals to every subclass, violating the principle.
