---
id: naming-reveals-intent
title: Naming Reveals Intent
severity: strong-opinion
portable: true
scope:
  layers: []
tags:
  - naming
  - readability
  - maintainability
---

Every identifier — function, variable, type, class, or file — must communicate what it does or represents well enough that a reader never has to open the implementation to find out. A name is a promise: the reader should be able to predict the behavior, shape, or content behind it before looking. If a name requires a comment, a Slack message, or a dive into the body to disambiguate, the name has failed at its one job.

## Rationale

Identifiers are the interface a reader actually navigates by — through autocomplete, grep, stack traces, and diffs — long before they open a file to read a body. A vague name (`data`, `handle`, `process`, `helper`, `Manager`, `doStuff`) forces every future reader, human or AI, to re-derive intent from scratch each time it's encountered, at every call site, forever. A precise name amortizes that cost once, at authoring time.

This is distinct from `[[ubiquitous-language-in-code]]`, which asks "is this the same word the domain expert would use?" — a question about matching an external vocabulary. This principle asks a narrower, universal question that applies even outside a domain-modeled codebase: "does this name, on its own, say what the thing does?" Infrastructure code with no domain (a retry wrapper, a cache key builder, a CLI flag parser) still has intent to reveal, even though it has no ubiquitous language to align with.

The failure compounds in AI-assisted codebases specifically: a code-generation agent choosing a call site, or a reviewer scanning a diff cold (see `[[agent-cold-review]]`), has only the name and the signature to reason from until it decides the body is worth reading. A name that undersells or misrepresents behavior (`validateUser` that actually mutates and saves the user) produces confidently wrong assumptions that propagate into new code before anyone re-reads the implementation.

## Examples

**Bad — names give no signal about behavior or shape:**

```typescript
function process(u: any, opts: any) {
  const flag = opts.mode === "strict";
  if (flag && !u.email) throw new Error("bad");
  u.status = "checked";
  db.save(u);
  return flag;
}

let data = fetchUsers();
let temp = data.filter((x) => x.active);
```

Nothing here tells a reader that `process` validates AND persists, that `flag` means "strict mode enabled," or that `temp` is the active-user subset.

**Good — names state behavior, role, and shape directly:**

```typescript
function validateAndSaveUser(user: User, options: ValidationOptions): boolean {
  const isStrictMode = options.mode === "strict";
  if (isStrictMode && !user.email) throw new Error("email required in strict mode");
  user.status = "checked";
  db.save(user);
  return isStrictMode;
}

const allUsers = fetchUsers();
const activeUsers = allUsers.filter((user) => user.active);
```

A reader can predict `validateAndSaveUser` both validates and persists — and returns whether strict mode applied — without opening the function body. `activeUsers` states its content; `isStrictMode` states its meaning as a boolean.

**Bad — file name is a generic bucket:**

```
src/utils.ts       // What's in here? Anything. Nothing rules it out.
src/helpers.ts     // Same problem, different word.
```

**Good — file name states its single responsibility:**

```
src/retry-with-backoff.ts
src/parse-cli-flags.ts
```

## Exceptions

Extremely short-lived, tightly-scoped local variables in a single small expression (a loop index `i`, a lambda parameter `x` in a one-line `.map(x => x * 2)`, a destructured `[a, b]` swap) do not need descriptive names — their entire scope is visible on one screen and the name's job is trivial. Well-established, universally understood short forms (`id`, `err`, `ctx`, `req`, `res` in HTTP handler code) are acceptable where the surrounding convention already fixes their meaning. A generic bucket file (`utils.ts`, `types.ts`) is acceptable only for a module that is genuinely a grab-bag by design (e.g., a barrel re-export or a single shared-types file) — not as a place to avoid deciding where new logic belongs.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "Shorter is cleaner — `usr` reads better than `user`." | Brevity that costs clarity is not economy, it's a withdrawal against every future reader who has to decode the abbreviation. The character savings are paid once; the comprehension tax is paid on every read. | Prefer the fully-spelled, unambiguous name. Reserve abbreviation for terms so standard they're effectively their own word (`id`, `URL`). |
| "The type annotation already makes it obvious." | Types describe shape, not intent. `boolean` doesn't tell a reader whether `true` means "strict mode" or "is deleted" — only the name does. | Name the variable/parameter for what the value *means*, not just what it *is*. |
| "I'll add a comment explaining what it does." | A comment is a workaround, not a fix — it can drift out of sync with the code it describes, and it doesn't help at call sites where the comment isn't visible (autocomplete, stack traces, grep results). | Rename so the code is self-explanatory first. Reserve comments for the "why," not a translation of a poorly-named "what." |
| "Everyone on the team knows `data`/`tmp`/`x2` means the active-user list here." | Tribal knowledge fails the moment a new contributor, a different AI session, or the same author six months later encounters the name without the shared context. | Name it for what it is (`activeUsers`), so the meaning travels with the identifier instead of living in someone's memory. |
| "This is just a scratch/internal variable, it doesn't need a good name." | Internal-only is not the same as short-lived-and-trivial (see `## Exceptions`). Internal variables that persist across more than a couple of lines get read and modified just as often as public ones. | Apply the same naming bar to internal variables that span more than a trivial one-line scope. |

## Verification

- [ ] No new function, method, or variable is named with a bare generic placeholder term (`data`, `temp`, `tmp`, `foo`, `bar`, `thing`, `stuff`, `obj`, `val`, `flag`, `result`) without a qualifying word that states its role — grep the diff for `\b(data|temp|tmp|thing|stuff)\b` used as a standalone identifier and confirm each hit is either an Exception-scoped short-lived local or renamed to state its content/role.
- [ ] Every new function name is a verb phrase describing what it does (`validateUser`, `computeTotal`), not a noun phrase describing only its type or domain (`userValidation`, `totalComputation`).
- [ ] Every new boolean variable, parameter, or return value reads as a yes/no question (`isActive`, `hasPermission`, `canRetry`, `shouldRetry`) — grep for boolean-typed identifiers lacking an `is`/`has`/`can`/`should`/`will` prefix.
- [ ] No new file is named with a generic bucket term (`utils.ts`, `helpers.ts`, `misc.ts`, `common.ts`) unless the `## Exceptions` justification (genuine grab-bag/barrel) applies and is documented at the point of use.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.

## Related

- [[ubiquitous-language-in-code]] — the domain-specific sibling: once a name is clear, this principle further asks whether it's the *same word the domain expert would use*. Apply this principle first (is the name clear at all?), then that one (is it the domain's word?).
- [[compute-effect-naming-convention]] — a concrete, mechanically-enforced specialization of this principle for one codebase (`mcp-server/src/**`): the `compute*`/effect-prefix convention is this principle applied to a single, high-value distinction (purity vs. side effects).
- [[deep-modules]] — a module's public interface is itself a set of names (its exported functions and types); this principle governs the clarity of each individual name that interface exposes.
