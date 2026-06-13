---
id: wrap-external-exceptions
title: Wrap External Exceptions at the Boundary
severity: strong-opinion
portable: true
scope:
  layers: []
  tags:
    - error-handling
tags:
  - error-handling
  - encapsulation
  - clean-code
---

When calling third-party libraries or external services, catch their specific exceptions at the boundary and convert them into domain-appropriate types. Callers should never see `PrismaClientKnownRequestError`, `AxiosError`, or `sqlite3.IntegrityError` — they should see domain errors like `DuplicateEntryError` or result types like `{ ok: false, error: "service_unavailable" }`.

## Rationale

Letting library-specific exceptions propagate through your codebase creates invisible coupling to that library. Business logic ends up catching `Prisma.PrismaClientKnownRequestError` with error code `"P2002"` — and now your business logic is coupled to Prisma's error taxonomy. Swapping Prisma for Drizzle means hunting through every catch block in the codebase.

Wrapping at the boundary creates a clean seam: the data layer translates library errors into domain concepts, and the rest of the code only knows about domain errors. This complements `errors-are-values` — wrap the external exception into your typed result pattern.

## Examples

**Bad — library exceptions leak through the codebase:**

```typescript
// In the service layer — knows about Prisma internals
async function createUser(email: string): Promise<User> {
  try {
    return await prisma.user.create({ data: { email } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        throw new Error("User already exists");
      }
    }
    throw error;
  }
}

// In the handler — also knows about Axios internals
async function fetchWeather(city: string) {
  try {
    const response = await axios.get(`${API_URL}/weather?city=${city}`);
    return response.data;
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 429) {
      throw new Error("Rate limited");
    }
    throw error;
  }
}
```

**Good — exceptions wrapped at the boundary:**

```typescript
// data/user-repository.ts — the boundary wraps Prisma errors
async function createUser(email: string): Promise<UserResult> {
  try {
    const user = await prisma.user.create({ data: { email } });
    return { ok: true, data: user };
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      return { ok: false, error: "duplicate_email" };
    }
    return { ok: false, error: "data_access_error", cause: error };
  }
}

// services/weather.ts — the boundary wraps HTTP errors
async function fetchWeather(city: string): Promise<WeatherResult> {
  try {
    const response = await httpClient.get(`/weather?city=${city}`);
    return { ok: true, data: response.data };
  } catch (error) {
    return { ok: false, error: classifyHttpError(error) };
  }
}

// Service layer only sees domain types — no library coupling
```

## Exceptions

If you're writing a thin wrapper library whose entire purpose is to expose a third-party API (e.g., a logging facade), wrapping every error may add unnecessary indirection. Also, in prototype or throwaway code, the boundary discipline may not be worth the investment.

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
