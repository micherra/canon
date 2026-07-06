---
id: grey-box-module
title: Grey-Box Modules — Human Owns the Interface, AI Fills the Body
severity: strong-opinion
scope:
  layers: []
tags:
  - architecture
  - api-design
  - agent-behavior
  - ai-navigability
---

A module is a *grey box* when its public interface, its types, and its test suite are authored and owned by the human (or architect agent), and only its implementation body is filled by the AI (or engineer agent). The test suite is the contract that lets a reviewer trust an implementation they have not read. Neither black box (trust nothing, read everything) nor white box (no boundary, everything exposed) — grey: the seams are human-owned and tested, the fill is delegated.

## Rationale

AI-generated implementations cannot be trusted by inspection alone. Reading every line of generated code to verify correctness defeats the productivity benefit of delegation. The grey-box model resolves this: if the human owns the interface and the test cases that the implementation must satisfy, the reviewer's job becomes verifying that the tests are correct and complete — not that the implementation is. A correct, thorough test suite is a trust contract that scales.

This is the model Canon uses for itself. The architect writes `DESIGN.md` — the public interface, type signatures, acceptance criteria, and behavioral test cases. The engineer fills the implementation body. The reviewer reads the design and the tests, not the implementation internals. The test suite is the contract; the engineer's output is trusted through it.

The failure mode is the black box: the AI generates interface, implementation, and tests together with no human anchor. Now every artifact is suspect — the tests may be written to match the implementation rather than to specify correct behavior. There is nothing the reviewer can trust without reading everything.

The complementary principles are `information-hiding` (the interface is small; the body is hidden) and `deep-modules` (the interface is simple; the implementation is deep). The test suite IS the fitness function for this boundary — it enforces that the implementation satisfies the contract the human specified. See `architectural-fitness-functions` for the general pattern.

## Examples

**Bad — AI generates interface, implementation, and tests together; nothing anchors correctness:**

```typescript
// AI generates all three at once — tests match implementation, not spec
export function parseWorkspaceId(raw: string): WorkspaceId {
  return raw.split("/").slice(-1)[0] as WorkspaceId;
}

test("parseWorkspaceId works", () => {
  // Test was written to match the implementation's behavior, not the spec
  expect(parseWorkspaceId("main/my-feature")).toBe("my-feature");
  // Edge cases the AI didn't think of are simply missing
});
```

No human reviewed what `WorkspaceId` should mean, what the edge cases are, or whether the test actually covers the contract.

**Good — architect owns the interface and test contract; engineer fills the body:**

```typescript
// architect writes: types + signature + test cases (the grey-box seam)
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

/** Extract the workspace id from a canonical path: "main/slug" → "slug".
 *  Returns null for paths that do not match the canonical form. */
export function parseWorkspaceId(raw: string): WorkspaceId | null;

// architect writes the test cases as specification:
test("extracts workspace id from canonical path", () => {
  expect(parseWorkspaceId("main/my-feature")).toBe("my-feature");
});
test("returns null for non-canonical paths", () => {
  expect(parseWorkspaceId("not-canonical")).toBeNull();
  expect(parseWorkspaceId("")).toBeNull();
  expect(parseWorkspaceId("a/b/c")).toBeNull(); // too many segments
});

// engineer fills only the body — reviewer trusts via the test contract above
export function parseWorkspaceId(raw: string): WorkspaceId | null {
  const parts = raw.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return parts[1] as WorkspaceId;
}
```

The reviewer reads the architect's signature and test cases to establish trust. The implementation body is delegation detail.

## Exceptions

Throwaway scripts, spikes, and proof-of-concept code where no reviewer trust is needed and the output will not be merged. Also applies to code that is small enough that reading the implementation is faster than writing a test suite for it — typically under ~15 lines with a single clear behavior.

## Related

- [[information-hiding]] — the grey-box seam IS information hiding applied: the interface is small and human-owned, the implementation body is hidden from the reviewer's trust calculus.
- [[deep-modules]] — the grey-box model works precisely because the module is deep: a shallow module has no implementation worth delegating, and nothing meaningful to hide behind the test contract.
- [[per-folder-public-interface]] — the single folder entry point is the structural enforcement of the grey-box boundary; the public interface file is the grey-box seam at the module-folder level.
