---
id: naming-reveals-intent
title: Names Should Reveal Intent, Not Implementation
severity: convention
scope:
  layers: []
tags:
  - naming
  - readability
  - ai-code-quality
---

Name functions, variables, and modules for what they accomplish, not how they work. A reader (human or AI) should understand the purpose of a symbol without reading its implementation.

## Rationale

AI-generated code tends toward generic or implementation-leaking names: `processData`, `handleResult`, `UserManager`, `utils`. These names force every future reader to open the function to understand it. In an AI-assisted workflow, vague names compound — the next prompt generates equally vague code because the context is ambiguous.

## Examples

**Bad — vague names force the reader to open the function:**

```typescript
// What does "process" mean? Validate? Transform? Save? All three?
async function processUser(data: unknown) {
  const result = handleData(data);
  if (result.status) {
    await saveItem(result);
  }
  return result;
}

// What's in utils? Everything and nothing.
// utils.ts
export function format(d: Date): string { /* ... */ }
export function check(u: User): boolean { /* ... */ }
export function transform(input: string): Output { /* ... */ }
```

**Good — names reveal what the code accomplishes:**

```typescript
// Clear: this validates a registration and persists it if valid
async function registerNewUser(registrationForm: RegistrationInput) {
  const validated = validateRegistration(registrationForm);
  if (validated.ok) {
    await persistUser(validated.data);
  }
  return validated;
}

// invoice-formatting.ts — the filename tells you the scope
export function formatDueDate(date: Date): string { /* ... */ }
export function isOverdue(invoice: Invoice): boolean { /* ... */ }
export function calculateLateFee(invoice: Invoice): Money { /* ... */ }
```

**Bad — boolean names that don't read as questions:**

```typescript
const data = true;
const status = false;
const check = user.verified && subscription.active;
```

**Good — booleans read as yes/no questions:**

```typescript
const isLoading = true;
const hasPermission = false;
const canAccessPremiumContent = user.verified && subscription.active;
```

## Exceptions

Loop variables (`i`, `j`), short-lived lambda parameters (`x => x.id`), and well-established conventions (`err`, `ctx`, `req`, `res`) are fine.
