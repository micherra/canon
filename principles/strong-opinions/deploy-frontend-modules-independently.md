---
id: deploy-frontend-modules-independently
title: Deploy Frontend Modules Independently
severity: strong-opinion
scope:
  layers:
    - ui
    - infra
  file_patterns:
    - "src/**"
    - "packages/**"
    - "apps/**"
    - "**/*.config.*"
tags:
  - ui
  - micro-frontends
  - deployment
  - modularity
---

Each frontend module — a micro frontend, a feature package, or a shared component library — should be deployable on its own without requiring coordinated releases of other modules. If shipping a change to the checkout flow requires simultaneously deploying the product catalog and the user profile, the architecture has failed to deliver the core benefit of modularization.

## Rationale

Independent deployment is the single most important property of a micro-frontend architecture. *The Art of Micro Frontends* and *Modern Front-End Architecture* both treat it as the non-negotiable constraint from which all other design decisions follow. If you can deploy independently, you can scale teams independently. If you can't, you have a distributed monolith — all the operational complexity of micro frontends with none of the organizational benefits.

Independent deployability forces good architecture. It means modules can't share build artifacts, can't import each other's internals, can't rely on coordinated database migrations, and can't assume a specific version of a sibling is running. These constraints eliminate entire categories of coupling that would otherwise accumulate silently.

The practical test from *Modern Front-End Architecture*: can Team A deploy to production on a Tuesday afternoon while Team B is on vacation? If the answer is no, the modules aren't truly independent.

## Examples

**Bad — build-time coupling prevents independent deployment:**

```jsonc
// package.json — Module A directly imports Module B
{
  "dependencies": {
    "@company/module-b": "^2.3.0"  // pinned to a specific version range
  }
}
```

```typescript
// Module A imports Module B's internals
import { CartContext } from "@company/module-b/src/context/CartContext";
import { formatPrice } from "@company/module-b/src/utils/currency";

function OrderSummary() {
  const cart = useContext(CartContext);  // breaks if Module B restructures
  return <span>{formatPrice(cart.total)}</span>;
}
```

Deploying Module B with a new internal structure breaks Module A. They must release together.

**Good — runtime integration with contracts:**

```typescript
// Module A loads Module B at runtime, no build-time dependency
const CartWidget = lazy(() => loadRemoteModule("cart", "./CartWidget"));

function OrderSummary() {
  return (
    <ErrorBoundary fallback={<CartUnavailable />}>
      <Suspense fallback={<CartSkeleton />}>
        <CartWidget onTotalChange={handleTotalChange} />
      </Suspense>
    </ErrorBoundary>
  );
}
```

```typescript
// Shared contract is minimal — just the props interface
interface CartWidgetProps {
  onTotalChange: (total: number) => void;
}
```

Module B can deploy a completely new internal implementation. As long as it honors the `CartWidgetProps` contract, Module A doesn't notice.

## Exceptions

Early-stage products with one team don't need micro frontends — a well-structured monolith with clear module boundaries is simpler and sufficient. Shared design-system libraries that version semantically and publish as packages are an acceptable build-time dependency, since they change infrequently and are consumed as a stable interface, not coupled internals. The overhead of independent deployment infrastructure (separate CI pipelines, module federation, runtime loading) must be justified by team scale — typically three or more teams working on the same product.
