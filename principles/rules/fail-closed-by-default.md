---
id: fail-closed-by-default
title: Fail Closed by Default
severity: rule
scope:
  layers:
    - api
    - infra
  tags:
    - security
    - boundary
tags:
  - security
  - reliability
  - cloud-security
---

When a system component fails — authentication service down, authorization check throws, rate limiter unreachable, feature flag service unavailable — the default behavior must be to deny access, reject the request, or disable the feature. Fail-open (allowing access when the check fails) must be an explicit, documented decision with a justification, never the implicit consequence of a caught exception or a missing default case.

## Rationale

Fail-open creates a perverse incentive: the easiest way to bypass security is to make it fail. A DDoS against the auth service grants everyone admin access. A misconfigured rate limiter allows unlimited requests. A crashed feature flag service enables every experimental feature in production. *Practical Cloud Security* identifies fail-open as a design flaw that converts reliability incidents into security incidents.

The danger is that fail-open is often the *unintentional* default. A try/catch around an authorization check that returns `true` in the catch block. A rate limiter that defaults to "allow" when Redis is down. A feature flag check that defaults to `enabled` when the config service is unreachable. These aren't deliberate decisions — they're the path of least resistance when writing error handling.

AI-generated code almost always fails open because LLMs optimize for "the code works" and a catch block that returns `true`/allows access is the simplest way to handle an error without breaking the happy path.

## Examples

**Bad — fail-open (implicit or accidental):**

```typescript
async function isAuthorized(user: User, resource: string): Promise<boolean> {
  try {
    return await authService.checkPermission(user, resource);
  } catch (error) {
    console.error("Auth service error:", error);
    return true;  // FAIL OPEN — auth service down = everyone authorized
  }
}

function getRateLimit(clientId: string): number {
  try {
    return rateLimiter.getLimit(clientId);
  } catch {
    return Infinity;  // FAIL OPEN — rate limiter down = no limits
  }
}
```

**Good — fail-closed, with explicit fail-open only where justified:**

```typescript
async function isAuthorized(user: User, resource: string): Promise<boolean> {
  try {
    return await authService.checkPermission(user, resource);
  } catch (error) {
    console.error("Auth service error — denying access:", error);
    return false;  // FAIL CLOSED — auth service down = deny access
  }
}

function getRateLimit(clientId: string): number {
  try {
    return rateLimiter.getLimit(clientId);
  } catch {
    return DEFAULT_STRICT_LIMIT;  // FAIL CLOSED — use conservative default
  }
}

// Explicit, documented fail-open (justified: read-only public content)
function getPublicContent(id: string): Content | null {
  try {
    if (!featureFlags.isEnabled("new-content-layout")) return getLegacyContent(id);
    return getNewContent(id);
  } catch {
    // INTENTIONAL FAIL-OPEN: public read-only content, no security impact.
    // Prefer showing content over showing an error page.
    return getLegacyContent(id);
  }
}
```

## Exceptions

Public, read-only endpoints where denying access has a worse user impact than allowing it (e.g., a public homepage). Graceful degradation paths where the fallback is a reduced-functionality mode, not full access. Health check endpoints that should remain accessible during partial outages. In all cases, the fail-open must be **documented in a code comment** explaining why.

**Related:** `handle-partial-failure` — addresses the mechanics of handling failure (timeouts, retries, circuit breaking); this principle addresses the *policy* (deny vs allow when the check itself fails). `secrets-never-in-code` — both are security principles; a fail-open auth check is as dangerous as a leaked credential.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The catch block handles the error — I'm logging it." | Logging the error and then returning `true` / allowing access is fail-open regardless of the log. The catch block must deny, not just observe. | Return `false`, throw a service-unavailable error, or return a deny response in every catch block for security checks. |
| "Returning `null` is fine — the caller will check for it." | Null as a success-neutral value is fail-open if the caller treats null as non-denial. The caller may not check, or may treat null as "no opinion = allow." | Return an explicit denial value. Don't rely on the caller to interpret null correctly. |
| "If auth is down, we shouldn't block all users." | Availability and security are in tension here, and the principle resolves it: security wins by default. Documented exceptions exist for public content, not for authenticated operations. | Fail closed. Return a 503 with a message explaining auth is unavailable. Users wait; the system stays secure. |
| "It's just feature flags — not real security." | Feature flags gate features, A/B tests, and sometimes billing-restricted functionality. Fail-open on a feature flag can expose unreleased or paid features to all users. | Default to the safe state: disable the feature when the flag service is unreachable, not enable it. |

## Verification

- [ ] No catch block in auth or permission code returns a truthy / allow value — grep for `catch` in auth-related files and check that no catch body returns `true`, `null`, or an allow-access value without a `// INTENTIONAL FAIL-OPEN` comment.
- [ ] No catch block silently swallows errors without a deny outcome — grep for empty catch blocks (`catch {` or `catch (e) {` followed immediately by `}`) in security-sensitive modules.
- [ ] All intentional fail-open paths have a documented justification comment containing `INTENTIONAL FAIL-OPEN` — grep for fail-open patterns in catch blocks and confirm each has this comment.
