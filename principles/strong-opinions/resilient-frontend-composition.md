---
id: resilient-frontend-composition
title: A Failing Module Must Not Break the Page
severity: strong-opinion
scope:
  layers:
    - ui
  file_patterns:
    - "src/**"
    - "packages/**"
    - "apps/**"
tags:
  - ui
  - micro-frontends
  - reliability
  - error-handling
---

When composing a page from multiple frontend modules, a failure in one module — a JavaScript error, a failed network request, a timeout — must not crash the entire page. Each module boundary should have an error boundary or equivalent isolation mechanism so the rest of the application continues to function. The user loses one widget, not the whole experience.

## Rationale

*The Art of Micro Frontends* provides a clear litmus test for well-designed micro frontends: turn one off. Is the overall application still technically working? If not, the architecture is too tightly coupled. This principle extends the microservices concept of failure isolation to the frontend: just as one backend service going down shouldn't cascade into a full outage, one UI module failing shouldn't produce a white screen.

The risk increases with independent deployment. When modules are deployed by different teams on different schedules, version mismatches and runtime errors become routine, not exceptional. A module that worked in isolation during Team B's testing may fail when composed with Team A's latest deployment. Without error boundaries, a `TypeError` in the recommendation carousel takes down the checkout page.

AI-generated code almost never adds error boundaries between composed modules — it assembles the happy path and moves on. This makes every module a single point of failure for the entire page.

## Examples

**Bad — one module's error crashes the page:**

```tsx
function ProductPage() {
  return (
    <div>
      <ProductDetails productId={id} />
      <RecommendationCarousel productId={id} />  {/* throws → white screen */}
      <ReviewSection productId={id} />
      <AddToCart productId={id} />
    </div>
  );
}
```

A runtime error in `RecommendationCarousel` propagates up and unmounts the entire `ProductPage`, including the critical `AddToCart` button.

**Good — each module boundary is isolated:**

```tsx
function ProductPage() {
  return (
    <div>
      <ProductDetails productId={id} />
      <ModuleBoundary name="recommendations" fallback={<RecommendationPlaceholder />}>
        <RecommendationCarousel productId={id} />
      </ModuleBoundary>
      <ModuleBoundary name="reviews" fallback={<ReviewPlaceholder />}>
        <ReviewSection productId={id} />
      </ModuleBoundary>
      <AddToCart productId={id} />
    </div>
  );
}

interface ModuleBoundaryProps {
  name: string;
  fallback: ReactNode;
  children: ReactNode;
}

function ModuleBoundary({ name, fallback, children }: ModuleBoundaryProps) {
  return (
    <ErrorBoundary
      fallback={fallback}
      onError={(error) => reportModuleFailure(name, error)}
    >
      <Suspense fallback={fallback}>
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}
```

Recommendations failing shows a placeholder. The product details, reviews, and add-to-cart button remain fully functional. The error is reported for the owning team to investigate.

## Exceptions

Modules that are genuinely critical to the page's core purpose — the `AddToCart` button on a product page, the message composer in a chat app — may warrant failing the whole page rather than showing a broken partial experience. In these cases, the error boundary should be at the page level, not the module level. The principle applies to auxiliary and composable modules, not to the page's primary interactive element.

**Related:** `deploy-frontend-modules-independently` describes the deployment model that makes failure isolation necessary. `isolate-frontend-runtime-state` explains why modules must not share state, which is the precondition for isolated failure.
