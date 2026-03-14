---
id: no-hidden-side-effects
title: No Hidden Side Effects
severity: strong-opinion
scope:
  languages: []
  layers: []
tags:
  - side-effects
  - predictability
  - clean-code
---

Functions should not modify state beyond what their name and signature promise. If a function called `validateEmail()` also normalizes the email, sends an analytics event, and updates a cache, those are hidden side effects. Every side effect must be visible — either in the function's name, its documented return type, or its parameter list.

## Rationale

Hidden side effects make code unpredictable. A developer reads `validate(input)` and assumes it's a pure check — but it also mutates `input`, logs to a database, and triggers a webhook. Now code that calls `validate()` in a test is making network requests. Code that calls it twice is double-logging. Code that calls it in a loop is hammering an external service.

The problem compounds in AI-assisted development. An LLM generating code that calls `validate()` has no way to know about the hidden side effects unless they're visible in the signature or name. It will generate code that assumes `validate` is safe to call freely, and the hidden effects will produce bugs that are nearly impossible to diagnose from the call site.

## Examples

**Bad — function has hidden side effects:**

```typescript
function checkPassword(userId: string, password: string): boolean {
  const user = db.findById(userId);
  const isValid = bcrypt.compareSync(password, user.passwordHash);

  // Hidden side effect #1: modifies database
  if (!isValid) {
    user.failedAttempts += 1;
    db.update(user);
  }

  // Hidden side effect #2: locks account (major state change!)
  if (user.failedAttempts >= 5) {
    user.lockedUntil = Date.now() + 30 * 60 * 1000;
    db.update(user);
  }

  // Hidden side effect #3: logs analytics
  analytics.track("password_check", { userId, success: isValid });

  return isValid;
}
```

The name says "check" — a query. But it modifies the database, locks accounts, and sends analytics.

**Good — side effects are explicit and separated:**

```typescript
// Pure query — no side effects
function verifyPassword(passwordHash: string, attempt: string): boolean {
  return bcrypt.compareSync(attempt, passwordHash);
}

// Explicit command — name declares the side effect
function recordFailedLogin(userId: string): LoginAttemptResult {
  const attempts = await incrementFailedAttempts(userId);
  if (attempts >= 5) {
    await lockAccount(userId, { duration: "30m" });
    return { locked: true, attempts };
  }
  return { locked: false, attempts };
}

// Orchestrator makes the flow visible
async function handleLoginAttempt(userId: string, password: string) {
  const user = await findUser(userId);
  const isValid = verifyPassword(user.passwordHash, password);

  if (!isValid) {
    const result = await recordFailedLogin(userId);
    await trackEvent("failed_login", { userId });
    return { ok: false, locked: result.locked };
  }

  await resetFailedAttempts(userId);
  await trackEvent("successful_login", { userId });
  return { ok: true };
}
```

Every side effect is visible: `recordFailedLogin` clearly modifies state, `trackEvent` clearly sends analytics, and the orchestrator shows the full picture.

## Exceptions

Logging and telemetry at a debug/trace level are acceptable hidden side effects — they observe the system without changing its behavior. Memoization and caching are also acceptable: the function's observable behavior is the same, the cache is an optimization detail. The line is: if removing the side effect would change the program's functional behavior, it must be visible.

**Related:** `command-query-separation` addresses a specific case of side-effect discipline — separating state changes (commands) from data retrieval (queries). This principle is broader: a command may have multiple side effects, all of which must be visible in its name. CQS forbids mixing mutation and return values; this principle forbids hiding any mutation behind a misleading name.
