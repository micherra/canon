# Frontend Domain

## Mental Models

**The User Is Not the Developer** — Frontend code runs on hardware you don't control, on networks you can't predict, for people whose expectations are shaped by every other app they use. A component that works in your dev tools may be unusable on a slow connection, invisible to a screen reader, or broken on a viewport you didn't test. The gap between "works on my machine" and "works for users" is larger in frontend than any other domain.

**State Has Gravity** — State attracts more state. A piece of state lifted into a shared store pulls related concerns with it — loading flags, error states, staleness tracking, cache invalidation. Before lifting state, account for the full weight of what comes with it, not just the value itself. Most state is lighter than it looks and belongs closer to where it's used.

**The Browser Is a Platform, Not a Runtime** — Browsers provide layout engines, accessibility trees, navigation, input handling, storage, and animation primitives. Code that reimplements what the browser already provides (custom scrolling, custom focus management, custom routing on top of history) is competing with a platform that has more investment and more testing than your project ever will.

## Decision Frameworks

**State placement** — Progress through these levels and stop at the first one that works: component-local state for UI concerns (open/closed, hover, input value); URL parameters for state that should survive navigation or be shareable; server state libraries (React Query, SWR) for remote data with caching and revalidation; context for cross-cutting concerns shared by a subtree (theme, locale, auth); global store only for complex client-side state that multiple unrelated components mutate. Each level up adds coordination cost.

**Component granularity** — Split a component when it has multiple independent reasons to change, not when it exceeds an arbitrary line count. A 200-line component with one cohesive responsibility is better than five 40-line components that only make sense together. The test: can you name what this component does in one sentence without "and"?

**When to reach for ARIA** — Start with the native HTML element that already has the semantics you need (button, dialog, nav, details). Reach for ARIA roles only when no native element fits the interaction pattern. ARIA overrides the accessibility tree — it doesn't add behavior. A `div` with `role="button"` still needs keyboard handling, focus management, and click synthesis that a `<button>` provides for free.

## Failure Modes

**AI-generated aesthetics** — Agents default to a recognizable visual signature: purple/indigo color palettes, heavy border-radius, oversized padding, gratuitous gradients, card-heavy layouts with uniform shadows. The result looks "designed" but not designed *for this project*. Every visual choice should come from the project's design system or existing patterns, never from the agent's defaults.

**Prop drilling avoidance at all costs** — Lifting state to context or a global store to avoid passing props through two or three levels creates invisible coupling and makes data flow harder to trace. Passing props through a few levels is explicit and debuggable. The cure (global state) is often worse than the symptom (a few extra prop declarations).

**Layout by pixel** — Hardcoded pixel values for widths, heights, margins, and positions break on viewports and font sizes the developer didn't test. Layouts built with relative units (rem, %, viewport units) and intrinsic sizing (auto, min-content, flex) adapt to contexts the developer didn't anticipate.

**Event handler accumulation** — Adding listeners without cleanup creates memory leaks and ghost behavior. Components that register global listeners (window, document, resize observers, intersection observers) in mount hooks but don't clean them up in unmount hooks accumulate handlers across navigation. The symptoms are subtle — sluggishness, phantom triggers, memory growth.

## Guardrails

**Component atomization** — You should keep components focused. If you're creating a component for every HTML element or splitting a form into a component per field, you've gone too far. Components exist at the level of reusable behavior, not at the level of individual DOM nodes.

**Accessibility theater** — You should make interfaces accessible. If you're adding ARIA attributes to elements that already have native semantics (aria-label on a button that already has text content, role="link" on an anchor tag), you've gone too far. Redundant ARIA can confuse assistive technology more than missing ARIA.

**Premature memoization** — You should avoid unnecessary re-renders. If you're wrapping every component in memo and every function in useCallback without measuring a performance problem, you've gone too far. Memoization adds complexity, can prevent garbage collection, and the render you're avoiding may already be cheap.

**Design system rigidity** — You should follow the design system. If you're refusing to deviate from token values for a one-off layout that the design system doesn't cover, or creating new tokens for every edge case, you've gone too far. Design systems define the common vocabulary, not every possible expression.
