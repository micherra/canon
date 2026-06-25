---
id: consistent-abstraction-levels
title: Each Function Operates at One Abstraction Level
severity: strong-opinion
portable: true
scope:
  layers: []
tags:
  - readability
  - functions
  - ousterhout
  - clean-code
  - separation-of-concerns
  - testability
---

Each function should operate at a single, consistent level of abstraction. Don't mix high-level orchestration calls with low-level operations in the same function body. If adjacent lines of code are at different abstraction levels — one line calls `processOrder()` and the next does `str.split(",").map(Number).filter(n => n > 0)` — the function is mixing levels.

## Rationale

When a function mixes abstraction levels, the reader must constantly shift mental context between "what does this function accomplish" and "how does this low-level detail work." This makes the function harder to understand, harder to modify, and harder to verify. The high-level flow gets buried in implementation details.

This is also a signal that the function does too much. If you find raw string manipulation, direct database queries, and business logic in the same function, each of those concerns should be in its own function at the appropriate level.

This principle generalizes `thin-handlers` (which applies only to HTTP handlers) to all functions. The same pattern — separate orchestration from implementation — applies everywhere.

AI-generated code routinely mixes abstraction levels because LLMs generate code linearly, top-to-bottom. When asked to "create a user registration function," the LLM inlines validation regex, password hashing, SQL queries, and email HTML templates into one function — it produces whatever the next line of code should be without stepping back to ask "what level am I operating at?"

## Examples

**Bad — mixed abstraction levels:**

```typescript
async function processNewUser(rawInput: string) {
  // High level: parse input
  const data = JSON.parse(rawInput);

  // Low level: manual validation
  if (!data.email || !data.email.includes("@") || data.email.length > 255) {
    throw new Error("Invalid email");
  }
  const normalizedEmail = data.email.trim().toLowerCase();

  // High level: check existence
  const existing = await userRepository.findByEmail(normalizedEmail);
  if (existing) return existing;

  // Low level: hash password with specific algorithm
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(data.password, salt, 100000, 64, "sha512").toString("hex");

  // High level: save user
  const user = await userRepository.create({
    email: normalizedEmail,
    passwordHash: `${salt}:${hash}`,
  });

  // Low level: construct email HTML
  const html = `<h1>Welcome ${data.name}</h1><p>Click <a href="https://app.example.com/verify?token=${user.verifyToken}">here</a></p>`;
  await sendEmail(normalizedEmail, "Welcome!", html);

  return user;
}
```

**Good — consistent abstraction level:**

```typescript
async function processNewUser(rawInput: string) {
  const input = parseUserInput(rawInput);
  const validated = validateNewUser(input);
  const existing = await userRepository.findByEmail(validated.email);
  if (existing) return existing;
  const user = await userRepository.create(validated);
  await sendWelcomeEmail(user);
  return user;
}
```

Each line is at the same level — named operations that describe *what* happens. The *how* lives in each function's implementation.

A common violation is fat HTTP handlers. Route controllers and API entry points should do three things: validate input, call a service, and return a response. Business logic belongs in service modules, not handler files. If your handler inlines database calls, transformation logic, and conditional business rules, it's mixing orchestration with implementation.

## Exceptions

Small utility functions that do one concrete thing (parse a date, format a number) naturally work at a single low level — that's fine. The principle targets orchestration functions that mix levels, not leaf functions that implement one detail. Trivial endpoints with no business logic (health checks, simple lookups under ~15 lines) don't need the indirection.

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

## Related

- [[functions-do-one-thing]] — a function mixing abstraction levels is usually doing more than one thing; consistent abstraction levels and single responsibility are two diagnostics for the same structural failure.
- [[information-hiding]] — abstraction-level consistency is the runtime expression of information hiding: low-level details belong in the implementing function, not exposed at the orchestrating level.
