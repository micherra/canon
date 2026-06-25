---
id: no-hidden-side-effects
title: No Hidden Side Effects
severity: strong-opinion
portable: true
scope:
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

## Related

[[command-query-separation]] addresses a specific case of side-effect discipline — separating state changes (commands) from data retrieval (queries). This principle is broader: a command may have multiple side effects, all of which must be visible in its name. CQS forbids mixing mutation and return values; this principle forbids hiding any mutation behind a misleading name. [[measure-before-optimizing]] — speculative caching and memoization introduced without measurement are hidden side effects; measure first to confirm the optimization is needed before introducing the state change.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This principle is too strict for this case." | Principles prevent common failure modes specifically in edge cases and delivery pressure, where shortcuts look most attractive. | Apply the principle unless a concrete, bounded exception is documented under `## Exceptions`. |
| "We'll clean it up after this ships." | Deferred quality work usually becomes permanent debt and normalizes repeated violations. | Implement the compliant approach now, or record an explicit follow-up with owner and due date. |
| "Code review can catch this later." | Manual review is inconsistent under time pressure and cannot replace explicit constraints. | Encode compliance in code structure, tests, or linting so violations fail fast and repeatably. |
| "This is just a small change, so the rule doesn't matter." | Small changes accumulate into systemic drift when principles are waived incrementally. | Hold small changes to the same bar and verify the invariant still holds after each change. |

## Verification

- [ ] Updated files satisfy this principle's core constraint in behavior and structure.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.
- [ ] Tests, lints, or checks were added/updated where needed so regressions are detectable.
