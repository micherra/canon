---
id: structured-logging-with-levels
title: Log Structured Events at the Right Level
severity: convention
scope:
  languages: []
  layers:
    - api
    - domain
    - infra
tags:
  - observability
  - debugging
  - operations
---

Log entries must be structured (key-value pairs or JSON, not interpolated strings) and use the correct severity level. `ERROR` means something is broken and needs attention. `WARN` means something is degraded but the system handled it. `INFO` means a significant business event occurred. `DEBUG` means a developer needs this for troubleshooting. Misusing levels — logging expected conditions as `ERROR`, using `INFO` for debugging noise, or logging sensitive data at any level — makes logs useless for the people who need them most: on-call engineers at 3 AM.

## Rationale

Unstructured logs (`console.log("Processing order " + orderId)`) can't be searched, filtered, aggregated, or alerted on. Structured logs (`{ event: "order.processing", orderId, userId, amount }`) can. This is the difference between "grep through 10GB of text" and "query for all orders over $1000 that failed in the last hour."

Level discipline matters because alerting depends on it. If `ERROR` fires for expected conditions (user typos, expired tokens, 404s), the on-call team learns to ignore errors. When a real error occurs, it drowns in the noise. *The Art of Monitoring* identifies log level misuse as a primary cause of alert fatigue.

AI-generated code defaults to `console.log` and `console.error` with string interpolation, producing unstructured, incorrectly-leveled logs that are useless in production.

## Examples

**Bad — unstructured, wrong levels:**

```typescript
// String interpolation — can't query or filter
console.log("Processing order " + orderId + " for user " + userId);
console.log("Order total: $" + total);

// Wrong levels
console.error("User not found: " + userId);  // NOT an error — expected case
console.log("Database connection failed");     // IS an error — logged as info
console.info("Query took " + ms + "ms");       // Debug noise at info level
```

**Good — structured, correct levels:**

```typescript
// Structured key-value logging
logger.info("order.processing", { orderId, userId, amount, itemCount: items.length });

// Correct levels
logger.warn("user.not_found", { userId, source: "getProfile" });     // expected but notable
logger.error("database.connection_failed", { host, port, error: err.message });  // needs attention
logger.debug("query.executed", { sql: query, durationMs: ms });      // dev-only detail

// Business events at INFO — the audit trail
logger.info("order.completed", { orderId, userId, total, paymentMethod });
logger.info("user.registered", { userId, source: "signup_form" });
```

**Level guide:**

| Level | Meaning | Alert? | Example |
|-------|---------|--------|---------|
| `ERROR` | Something is broken, needs human attention | Yes — page/alert | DB down, payment gateway unreachable, unhandled exception |
| `WARN` | Degraded but handled, may need attention | Maybe — threshold | Rate limit hit, retry succeeded, fallback used, cache miss |
| `INFO` | Significant business event | No — audit trail | Order placed, user registered, deployment completed |
| `DEBUG` | Developer troubleshooting detail | No — disabled in prod | SQL queries, request/response bodies, internal state |

## Exceptions

Prototype/script code where structured logging is overhead. CLI tools where human-readable output is the product. Test code where `console.log` for debugging is acceptable (but should be removed before merge).

**Related:** `no-hidden-side-effects` — logging should be the only side effect of a query/read operation. `secrets-never-in-code` — never log secrets, tokens, passwords, or PII at any level.
