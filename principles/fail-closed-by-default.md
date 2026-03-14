---
id: fail-closed-by-default
title: Fail Closed by Default
severity: rule
scope:
  languages: []
  layers:
    - api
    - infra
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
