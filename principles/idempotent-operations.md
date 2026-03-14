---
id: idempotent-operations
title: Retryable Operations Must Be Idempotent
severity: strong-opinion
scope:
  layers:
    - api
    - domain
tags:
  - distributed-systems
  - reliability
  - data-intensive
---

Any operation that may be retried — message handlers, webhook processors, API endpoints that create resources, payment processing, job queue workers — must be idempotent. Executing the same operation twice with the same input must produce the same result as executing it once. Use idempotency keys, UPSERT patterns, deduplication checks, or naturally idempotent operations (like setting a value rather than incrementing it).

## Rationale

*Designing Data-Intensive Applications* explains that in distributed systems, at-least-once delivery is the norm. Networks, load balancers, and message brokers all retry failed or timed-out requests. A message that appeared to fail may have actually succeeded — the acknowledgment was lost. Without idempotency, retries cause duplicate side effects: double charges, duplicate records, extra notifications.

The failure mode: a payment webhook fires, your handler processes it and charges the customer, but the response times out before Stripe receives the acknowledgment. Stripe retries the webhook. Your handler processes it again. The customer is charged twice. With an idempotency key (the webhook's event ID), the second processing is a no-op.

## Examples

**Bad — non-idempotent operation that will be retried:**

```typescript
// Webhook handler creates a payment record on every call
app.post("/webhooks/stripe", async (req, res) => {
  const event = req.body;
  // If this webhook is retried, we create duplicate payments
  await db.payment.create({
    data: {
      orderId: event.data.orderId,
      amount: event.data.amount,
      status: "completed",
    },
  });
  await sendReceiptEmail(event.data.orderId);  // Duplicate email too
  res.status(200).send("ok");
});

// Job worker that increments a counter (not idempotent)
async function processAnalyticsEvent(event: AnalyticsEvent) {
  await db.metrics.update({
    where: { metricId: event.metricId },
    data: { count: { increment: 1 } },  // Double-counted on retry
  });
}
```

**Good — idempotent operations safe for retry:**

```typescript
// Webhook handler uses event ID as idempotency key
app.post("/webhooks/stripe", async (req, res) => {
  const event = req.body;
  // UPSERT: second call with same event ID is a no-op
  const result = await db.payment.upsert({
    where: { stripeEventId: event.id },
    create: {
      stripeEventId: event.id,
      orderId: event.data.orderId,
      amount: event.data.amount,
      status: "completed",
    },
    update: {},  // Already exists — do nothing
  });

  // Only send email if this is a new payment
  if (result.wasCreated) {
    await sendReceiptEmail(event.data.orderId);
  }
  res.status(200).send("ok");
});

// Job worker uses SET instead of INCREMENT (naturally idempotent)
async function processAnalyticsEvent(event: AnalyticsEvent) {
  await db.metrics.upsert({
    where: { metricId: event.metricId, eventId: event.id },
    create: { metricId: event.metricId, eventId: event.id, value: event.value },
    update: {},  // Already processed — skip
  });
}
```

## Exceptions

Read-only operations (queries, lookups) are naturally idempotent and don't need explicit handling. Operations within a single database transaction that will be fully rolled back on failure are safe — the retry starts from scratch. Truly internal function calls within a single process that cannot be externally retried don't need idempotency keys.
