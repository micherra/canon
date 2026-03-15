---
id: handle-partial-failure
title: Handle Partial Failure in Distributed Calls
severity: strong-opinion
scope:
  layers:
    - domain
    - api
    - infra
tags:
  - distributed-systems
  - reliability
  - data-intensive
---

Code making distributed calls — HTTP requests, gRPC calls, message queue operations, cross-service database queries — must handle partial failure: timeouts, retries with exponential backoff, circuit breaking, and graceful degradation. A function that calls an external service without a timeout is a production incident waiting to happen. Assume every network call can fail, hang indefinitely, or return garbage.

## Rationale

*Designing Data-Intensive Applications* and *Building Microservices* both emphasize that partial failure is the defining characteristic of distributed systems. A network call can succeed, fail, or — worst of all — hang indefinitely with no response. Without timeouts, a single slow dependency cascades into a full system outage as threads, connections, and memory pool up waiting for a response that never comes.

The failure mode: service A calls service B with no timeout. Service B's database is slow today. Service A's thread pool fills up with requests waiting for B. Service A stops responding. Service C, which depends on A, also stops responding. A single slow database query has taken down three services. A 5-second timeout on the call to B would have contained the blast radius.

## Examples

**Bad — distributed call with no failure handling:**

```typescript
// No timeout, no retry, no error handling
async function getUser(userId: string): Promise<User> {
  const response = await fetch(`http://user-service/users/${userId}`);
  return response.json(); // What if the service is down? What if it hangs?
}

// Chained calls where any failure cascades
async function processOrder(orderId: string) {
  const order = await fetch(`http://order-service/orders/${orderId}`).then(r => r.json());
  const inventory = await fetch(`http://inventory-service/check/${order.productId}`).then(r => r.json());
  const payment = await fetch(`http://payment-service/charge`, {
    method: "POST",
    body: JSON.stringify({ amount: order.total }),
  }).then(r => r.json());
  // If any call hangs, everything hangs. No timeouts, no fallbacks.
}
```

**Good — resilient distributed calls:**

```typescript
// Timeout, retry with backoff, and typed error handling
async function getUser(userId: string): Promise<UserResult> {
  try {
    const response = await fetch(`http://user-service/users/${userId}`, {
      signal: AbortSignal.timeout(5000),  // 5 second timeout
    });

    if (!response.ok) {
      return { ok: false, error: classifyHttpError(response.status) };
    }

    return { ok: true, data: await response.json() };
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "network_error" };
  }
}

// Circuit breaker pattern for repeated failures
const userServiceBreaker = new CircuitBreaker(getUser, {
  failureThreshold: 5,     // Open after 5 failures
  resetTimeout: 30_000,    // Try again after 30 seconds
  fallback: (userId) => ({ ok: false, error: "service_unavailable" }),
});
```

## Exceptions

Local function calls and in-process operations do not need distributed failure handling. Calls to co-located databases with well-understood, bounded latency may use simpler timeout strategies (though they still need timeouts). Startup initialization code that must connect to dependencies before serving traffic can use longer timeouts and fail-fast rather than degrade.

**Related:** `prefer-async-between-services` reduces the need for this principle by converting synchronous calls to async events — but the synchronous calls that remain still need full partial-failure handling.
