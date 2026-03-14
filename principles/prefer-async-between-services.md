---
id: prefer-async-between-services
title: Prefer Asynchronous Communication Between Services
severity: convention
scope:
  layers:
    - domain
    - infra
tags:
  - microservices
  - communication
  - decoupling
---

Service-to-service communication should default to asynchronous patterns — events, message queues, event streams — unless temporal coupling is genuinely required. Synchronous calls between services create cascading failure risk, tight deployment coupling, and latency accumulation. Every synchronous inter-service call should have a documented justification for why asynchronous communication won't work.

## Rationale

*Building Microservices* dedicates an entire chapter to inter-service communication patterns. Synchronous calls between services mean that if service B is down, service A's request fails too — even if service A could have queued the work and responded to the user. A chain of synchronous calls (A → B → C → D) means the slowest service determines the response time and any single failure takes down the entire chain.

Asynchronous communication decouples both availability and latency: service A publishes an event and moves on. Service B processes it when ready. If B is temporarily down, the message waits in the queue. Neither service needs to know the other's deployment schedule or availability.

The failure mode: the checkout flow synchronously calls inventory, payment, notification, and analytics services in sequence. Total latency: 200ms + 300ms + 150ms + 100ms = 750ms. When the analytics service has a slow GC pause, checkout takes 3 seconds. When the notification service is down for maintenance, checkout fails entirely — even though "send receipt email" is not essential to completing a purchase.

## Examples

**Bad — synchronous chain for side-effect operations:**

```typescript
// Every service call must succeed for the order to complete
async function placeOrder(order: Order): Promise<OrderResult> {
  await inventoryService.reserve(order.items);      // Sync call #1
  await paymentService.charge(order.total);          // Sync call #2
  await notificationService.sendConfirmation(order); // Sync call #3
  await analyticsService.trackOrder(order);          // Sync call #4
  return { ok: true, orderId: order.id };
  // If notification service is slow, the whole order is slow
  // If analytics service is down, the order fails
}
```

**Good — asynchronous communication for non-blocking operations:**

```typescript
// Core operation is synchronous; side effects are async events
async function placeOrder(order: Order): Promise<OrderResult> {
  // Only the essential operations are synchronous
  const reserved = await inventoryService.reserve(order.items);
  if (!reserved.ok) return { ok: false, error: "insufficient_inventory" };

  const payment = await paymentService.charge(order.total);
  if (!payment.ok) {
    await inventoryService.release(order.items); // Compensate
    return { ok: false, error: "payment_failed" };
  }

  // Non-essential operations published as events
  await eventBus.publish("order.placed", {
    orderId: order.id,
    items: order.items,
    total: order.total,
  });
  // Notification and analytics services consume this event independently

  return { ok: true, orderId: order.id };
}
```

## Exceptions

Queries where the user is actively waiting for a response — search, lookups, real-time data — legitimately need synchronous calls. Authentication and authorization checks must be synchronous (you can't defer "is this user allowed?" to later). The principle targets command-side operations (create, update, notify) between services, not read-side operations. Services within the same bounded context that are always deployed together may use synchronous calls without the coupling downsides.

**Related:** `handle-partial-failure` applies to the synchronous calls that remain — those calls still need timeouts, retries, and circuit breakers to prevent cascading failures.
