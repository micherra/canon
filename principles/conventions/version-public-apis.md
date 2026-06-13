---
id: version-public-apis
title: Version Public-Facing APIs from Day One
severity: convention
portable: true
scope:
  layers:
    - api
tags:
  - api-design
  - backward-compatibility
  - architecture
---

Public-facing APIs — endpoints consumed by external clients, mobile apps, third-party integrations, or other teams' services — must be versioned from their first release. Include a version identifier in the URL path (`/v1/orders`), header (`API-Version: 2024-01-15`), or content type (`application/vnd.myapp.v1+json`). Internal APIs between tightly coupled services owned by the same team may skip versioning if they deploy together, but any API crossing a team or deployment boundary needs a version.

## Rationale

Adding versioning after the fact is painful — you have to retrofit every endpoint, update every client, and deal with the unversioned endpoints that are now implicitly "v0." Starting with `/v1/` costs nothing and gives you a clean path to introduce breaking changes later without breaking existing clients. *Building Microservices* identifies API versioning as one of the cheapest upfront investments with the highest payoff when systems evolve.

The alternative — breaking changes to unversioned APIs — forces synchronized deployment of all clients, which is the opposite of the independence that APIs are supposed to provide. Even "we'll never need v2" projects eventually need v2.

AI-generated code almost never includes API versioning because LLMs generate the simplest working endpoint and versioning isn't part of the functional requirement. The result is `/api/orders` instead of `/api/v1/orders`, and the team pays for it 6 months later.

## Examples

**Bad — unversioned API:**

```typescript
// No version — breaking changes will break all clients simultaneously
app.get("/api/orders", getOrders);
app.post("/api/orders", createOrder);

// Even worse: version added inconsistently after the fact
app.get("/api/orders", getOrdersLegacy);       // unversioned = v1?
app.get("/api/v2/orders", getOrdersV2);         // now you have both
```

**Good — versioned from the start:**

```typescript
// URL path versioning (most common, most visible)
const v1 = express.Router();
v1.get("/orders", getOrders);
v1.post("/orders", createOrder);
app.use("/api/v1", v1);

// When v2 is needed: add it alongside v1, deprecate v1 on a timeline
const v2 = express.Router();
v2.get("/orders", getOrdersV2);  // new response shape
app.use("/api/v2", v2);
```

```typescript
// Date-based versioning (Stripe-style, good for gradual evolution)
app.use((req, res, next) => {
  req.apiVersion = req.headers["api-version"] || "2024-01-15";
  next();
});
```

## Exceptions

Internal APIs between services owned by the same team that deploy atomically (monorepo with shared deployment). Prototype/experimental APIs explicitly marked as unstable (`/beta/...` or `/experimental/...`). GraphQL APIs where the schema evolves additively (fields are added, never removed) — though even GraphQL benefits from a deprecation strategy.

**Related:** `backward-compatible-schema-changes` — versioning is the escape hatch when you can't make a change backward-compatible. Both principles protect existing consumers from breaking changes.

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
