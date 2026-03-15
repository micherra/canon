---
id: decompose-by-domain-not-layer
title: Decompose by Business Domain, Not Technical Layer
severity: strong-opinion
scope:
  layers:
    - domain
tags:
  - architecture
  - modularity
  - hard-parts
---

When splitting systems into services or modules, decompose by business capability — orders, payments, inventory, shipping — not by technical layer — validation, database, notifications, logging. Each service or module should represent one business capability end-to-end, owning its own validation, data access, and business logic. A "validation service" or "notification service" that serves multiple domains creates a cross-cutting dependency that every other service must coordinate through.

## Rationale

*Software Architecture: The Hard Parts* identifies technical decomposition as one of the most common architectural mistakes. When a system is split by technical layer, every business feature requires changes to multiple services: add a field to the "data service," update the "validation service," modify the "notification service." These services become coordination bottlenecks — every team needs the notification team to make changes before they can ship a feature.

Domain decomposition keeps each service's changes localized. The Payments team can add a new payment method without involving any other team — they own the validation, storage, and notifications for payments. This is also the organizing principle behind Conway's Law: system boundaries should align with team boundaries, and teams should own business capabilities, not technical layers.

The failure mode: the team creates a "Notification Service" that sends emails, SMS, and push notifications for all domains. Now the Orders team needs a new order confirmation template. They open a ticket for the Notification team. The Notification team has a backlog of requests from five other teams. The feature ships three sprints late because of a cross-team dependency on a shared technical service.

## Examples

**Bad — decomposed by technical layer:**

```
services/
  validation-service/     # Validates input for ALL domains
    src/
      order-validator.ts
      payment-validator.ts
      user-validator.ts
  data-service/           # Database access for ALL domains
    src/
      order-repository.ts
      payment-repository.ts
      user-repository.ts
  notification-service/   # Sends notifications for ALL domains
    src/
      order-notifications.ts
      payment-notifications.ts
      user-notifications.ts
```

Every feature touches three services. Every team depends on every other team.

**Good — decomposed by business domain:**

```
services/
  orders/                 # Owns everything about orders
    src/
      domain/
        order.ts
        order-validator.ts
      data/
        order-repository.ts
      notifications/
        order-confirmation.ts
  payments/               # Owns everything about payments
    src/
      domain/
        payment.ts
        payment-validator.ts
      data/
        payment-repository.ts
      notifications/
        receipt-sender.ts
  users/                  # Owns everything about users
    src/
      domain/
        user.ts
        user-validator.ts
      data/
        user-repository.ts
      notifications/
        welcome-email.ts
```

Each service is self-contained. Adding a new order notification requires changes only to the orders service.

## Exceptions

Genuinely shared infrastructure — logging, monitoring, authentication, API gateways — may be centralized as platform capabilities. The distinction: platform services provide generic capabilities (send an email, write a log) without domain logic; domain services contain business rules. A centralized email-sending library or infrastructure is fine; a centralized "order notification" service is not. Also, very small teams or early-stage products may keep everything in a monolith — the principle guides how to organize modules within the monolith, not a mandate to adopt microservices.
