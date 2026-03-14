---
id: general-purpose-modules
title: Somewhat General-Purpose Interfaces
severity: convention
scope:
  languages: []
  layers:
    - domain
    - shared
tags:
  - api-design
  - reusability
  - ousterhout
---

Design module interfaces for somewhat general use rather than hardcoding them to only the current caller's needs. The interface should make sense to someone who doesn't know the specific use case. Special-case methods that serve one caller should be replaced by general-purpose operations that serve many callers naturally.

## Rationale

Special-purpose interfaces are brittle. When the next use case arrives, the interface doesn't fit, so you add another special-case method, and the module accumulates methods that each serve one caller. A somewhat general-purpose interface anticipates natural variations without over-engineering. The key word is "somewhat" — don't build a framework, but don't hardcode to one caller's exact needs either.

This is *not* premature generalization. Premature generalization adds abstractions you don't need. This principle says: when designing the interface for the thing you *do* need, choose the general form over the specific form. `delete(range)` instead of `deleteNextChar()` costs no extra implementation effort but serves more use cases.

AI-generated code tends toward special-purpose interfaces because the LLM designs for the immediate prompt. Asked to "add delete-next-character functionality," it generates `deleteNextCharacter()` — the literal translation of the request. It doesn't step back to ask "what's the general operation here?" because it optimizes for the specific task, not for the module's long-term API.

## Examples

**Bad — interface hardcoded to one use case:**

```typescript
class TextEditor {
  deleteSelection(): void { /* ... */ }
  deleteNextCharacter(): void { /* ... */ }
  deleteToEndOfLine(): void { /* ... */ }
  deletePreviousWord(): void { /* ... */ }
  insertAtCursor(text: string): void { /* ... */ }
  insertAtLineStart(text: string): void { /* ... */ }
}
```

Six methods that each handle one specific deletion/insertion case. Adding "delete to start of line" requires a new method.

**Good — general-purpose interface:**

```typescript
class TextEditor {
  delete(range: Range): void { /* ... */ }
  insert(position: Position, text: string): void { /* ... */ }
  getRange(start: Position, end: Position): Range { /* ... */ }
}

// All the specific cases from above work naturally:
editor.delete(selection);                    // delete selection
editor.delete(cursor.to(cursor.next()));     // delete next char
editor.delete(cursor.to(lineEnd));           // delete to end of line
```

Three methods handle all deletion and insertion cases. New use cases work without API changes.

## Exceptions

Performance-critical hot paths may justify specialized methods that avoid the overhead of general-purpose abstractions. Also, if the general-purpose form requires significantly more implementation effort and you genuinely only have one use case today, the simplicity-first principle takes precedence. The value here is when the general form costs the same or less to implement.
