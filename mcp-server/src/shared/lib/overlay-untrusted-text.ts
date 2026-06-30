/**
 * Boundary module for untrusted overlay free-text fields.
 *
 * Implements the opaque-box `UntrustedText` type (NOT a `string` subtype — see
 * PROBE-FINDINGS and ADR-0026) that makes a raw-emit sink a `tsc` TS2322 error.
 *
 * The sole owner of `._v`. All external callers must go through:
 *   - `brandUntrusted`         — stamp at the load boundary (parser.ts / routine.ts only)
 *   - `renderUntrusted*`       — model-facing unwrap (fences project-local content)
 *   - `rawUntrustedForStructuralUse` — audited escape hatch for non-model-facing use
 *   - `mapUntrusted`           — brand-preserving transform for structural operations
 *
 * Pure, leaf, no I/O. Lives in shared/lib/ per deep-modules convention.
 */

import { fenceUntrustedOverlay } from "./overlay-fence.ts";

// The unique symbol tag makes UntrustedText an OPAQUE object — NOT a `string`
// subtype. Assigning it to a `string` field is TS2322. This is the load-bearing
// property proven by PROBE-FINDINGS Result 2.
//
// Must be a concrete `const` (not `declare const`) so the symbol exists at runtime
// when tsx/esbuild transpiles the module. `declare const` is stripped by esbuild
// and causes `ReferenceError: untrustedTag is not defined` at test time.
const untrustedTag: unique symbol = Symbol("UntrustedText");

/**
 * Opaque box for genuinely free-text overlay fields (title, body,
 * anti_rationalization, verification). The only way to extract a model-emittable
 * `string` is via `renderUntrusted*`. A raw-emit sink is a TS2322 error.
 *
 * ADR-0026: use an opaque object box, NOT a `string &` intersection brand.
 * The intersection brand is a `string` subtype and enforces nothing at a sink.
 */
export type UntrustedText = {
  readonly [untrustedTag]: "UntrustedText";
  /** Raw string — readable ONLY inside this module. */
  readonly _v: string;
};

// ---------------------------------------------------------------------------
// Branding — load boundary only
// ---------------------------------------------------------------------------

/**
 * Stamp a raw string as untrusted. Call ONLY in parser.ts / routine.ts at the
 * single load boundary, never in sink code.
 */
export function brandUntrusted(s: string): UntrustedText {
  return { [untrustedTag]: "UntrustedText", _v: s } as UntrustedText;
}

// ---------------------------------------------------------------------------
// Brand-preserving transform — for extractSummary / filterBodyBySections
// ---------------------------------------------------------------------------

/**
 * Apply a pure string transform to the wrapped value without unwrapping into a
 * plain `string`. The result stays branded so the SINK still must `render` it.
 * Use for `extractSummary`, `filterBodyBySections`, and similar structural ops.
 */
export function mapUntrusted(v: UntrustedText, fn: (raw: string) => string): UntrustedText {
  return brandUntrusted(fn(v._v));
}

// ---------------------------------------------------------------------------
// Model-facing render — the ONLY path to a model-emittable string
// ---------------------------------------------------------------------------

/**
 * Unwrap for model-facing output. source-aware:
 *   - "project"   → `fenceUntrustedOverlay(raw, { source: ref })`
 *   - "plugin" / undefined → passthrough (trusted, no fence)
 *
 * This is the single composition point with `fenceUntrustedOverlay`. The
 * existing fence is unchanged; this module just makes calling it the only way
 * out of the box.
 */
export function renderUntrusted(
  v: UntrustedText,
  opts: { source?: "project" | "plugin"; ref: string },
): string {
  if (opts.source === "project") {
    return fenceUntrustedOverlay(v._v, { source: opts.ref });
  }
  return v._v;
}

/**
 * Model-facing projection unwrap — composes `# ${heading}\n\n${body}` then
 * renders once as a whole-projection fence. Heading is optional; when omitted
 * the projection is `${body}` only.
 *
 * project → fenced whole-projection; plugin / undefined → passthrough.
 */
export function renderUntrustedProjection(
  parts: { heading?: UntrustedText; body: UntrustedText },
  opts: { source?: "project" | "plugin"; ref: string },
): string {
  const rawBody = parts.heading ? `# ${parts.heading._v}\n\n${parts.body._v}` : parts.body._v;
  if (opts.source === "project") {
    return fenceUntrustedOverlay(rawBody, { source: opts.ref });
  }
  return rawBody;
}

// ---------------------------------------------------------------------------
// Audited escape hatch — non-model-facing structural use ONLY
// ---------------------------------------------------------------------------

/**
 * AUDITED ESCAPE HATCH — non-model-facing structural use ONLY.
 *
 * Returns the raw string value. Use ONLY when the value is consumed by a
 * non-model-facing operation (lint key computation, disk recipe, body-section
 * splitting). Every call site is asserted non-model-facing by
 * overlay-sink-coverage.test.ts; adding a new call site here requires adding
 * a corresponding sink-coverage assertion.
 *
 * The greppable name is intentional — searching `rawUntrustedForStructuralUse`
 * returns exactly the audit list.
 */
export function rawUntrustedForStructuralUse(v: UntrustedText): string {
  return v._v;
}
