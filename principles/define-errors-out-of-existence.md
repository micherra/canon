---
id: define-errors-out-of-existence
title: Define Errors Out of Existence
severity: convention
scope:
  layers:
    - domain
    - shared
tags:
  - error-handling
  - api-design
  - ousterhout
---

When possible, design interfaces so that error conditions cannot arise, rather than detecting and handling them. The best error handling code is code that doesn't need to exist. Before adding an error path, ask: "Can I change the API so this error is impossible?"

## Rationale

Every error case adds complexity — the error detection code, the recovery logic, tests for the error path, and the cognitive load on every caller who must decide how to handle it. Many error cases exist only because the API was designed with unnecessary constraints. Relaxing those constraints eliminates the error and all its associated complexity.

This complements the `errors-are-values` principle: that principle handles errors that genuinely exist. This principle asks whether they need to exist at all. Apply this principle first — eliminate what you can — then use typed results for the errors that remain.

## Examples

**Bad — API creates error conditions unnecessarily:**

```typescript
// Caller must handle the "already exists" error
async function createUser(email: string): Promise<User> {
  const existing = await findByEmail(email);
  if (existing) throw new DuplicateUserError(email);
  return await insertUser(email);
}

// Caller must handle the "not found" error
function removeFromArray<T>(arr: T[], item: T): void {
  const index = arr.indexOf(item);
  if (index === -1) throw new Error("Item not found in array");
  arr.splice(index, 1);
}
```

**Good — API eliminates the error condition:**

```typescript
// Upsert: "create or return existing" — no duplicate error possible
async function ensureUser(email: string): Promise<User> {
  return await upsertUser({ email }, { email });
}

// Remove if present — no "not found" error possible
function removeFromArray<T>(arr: T[], item: T): void {
  const index = arr.indexOf(item);
  if (index !== -1) arr.splice(index, 1);
  // Removing something that isn't there is a no-op, not an error
}
```

**Another example — file operations:**

```typescript
// Bad: throws if directory already exists
await fs.mkdir("/path/to/dir");

// Good: defines the error out of existence
await fs.mkdir("/path/to/dir", { recursive: true });
```

## Exceptions

Don't define errors out of existence when the error signals a genuine problem the caller needs to know about. If `transferFunds()` has an "insufficient balance" case, that's real business logic — the caller must handle it. This principle targets *incidental* error conditions that arise from overly strict API contracts, not essential domain errors.
