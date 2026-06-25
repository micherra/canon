---
id: leave-touched-files-better
title: Leave Touched Files Better Than You Found Them
severity: strong-opinion
portable: true
scope:
  layers: []
tags:
  - code-quality
  - drift
  - agent-behavior
  - standards-alignment
---

Every time an agent modifies a file — for a feature, bug fix, refactor, or test — it should leave that file a little better than it found it. Rename confusing variables, extract a gnarly condition into a well-named helper, remove dead code, fix stale imports, tighten loose types. Small, safe improvements as part of the same pass — not a rewrite, not a cleanup sprint, and never in files you aren't already changing.

## Rationale

Codebases drift one commit at a time. No single change introduces enough debt to justify a cleanup pass, but the accumulation is what makes a codebase hard to work in six months later. The Boy Scout Rule inverts this: quality also compounds one commit at a time, as long as every change leaves the touched file slightly cleaner.

In AI-assisted development, drift accelerates. An LLM generating a new function will match the patterns it sees in the surrounding code — not the patterns the repo intends. If the existing code uses barrel imports and the repo now requires path imports, the new code will copy barrel imports, and the next agent will too. Proactive alignment at the point of touch breaks this feedback loop at near-zero cost: the file is already open, the diff is already being reviewed, and the context is fresh.

The constraint is deliberate: **only files already being modified**. Scanning for violations across the repo and fixing them in bulk is scope creep — it creates sprawling diffs that obscure the primary intent and burden reviewers. Fix-while-touching yields the same long-term improvement with a fraction of the review cost.

The source of truth for what "better" means: active Canon principles, the directory's `CLAUDE.md`, lint config (`eslint`, `tsconfig`), and good judgment. Agents should not invent standards — they should apply the documented ones and use common sense for everything else.

## What "a little better" looks like

- **Rename the worst variable** — `d` → `durationMs`, `tmp` → `pendingBatch`
- **Extract a complex condition** — a 4-clause `if` becomes a well-named helper like `isEligibleForRetry()`
- **Remove dead code** — an unused import, an unreachable branch, a commented-out block
- **Fix stale imports** — barrel imports → path imports if that's the current convention
- **Tighten types** — `any` → the actual type; missing return annotations filled in
- **Delete unused variables or parameters** — if safe and obvious
- **Make the next change easier** — shape the code so the next person touching this area has less friction than you did

These are small, safe moves. Each one takes seconds. Together they compound into a codebase that gets cleaner over time instead of dirtier.

## Examples

**Bad — agent adds a function but ignores surrounding drift:**

```typescript
// user-service.ts — being modified to add createUser()
import { db, logger, mailer } from "../index";  // barrel import — violates current convention

export async function getUser(id: any): Promise<any> {  // any — violates type standards
  const d = await db.find(id);  // cryptic name
  if (d && d.active && d.verified && !d.banned) {  // sprawling condition
    return d;
  }
  return null;
}

// New function copies the surrounding anti-patterns
export async function createUser(data: any): Promise<any> {
  const u = await db.insert(data);
  logger.info("created user");
  return u;
}
```

The agent copied every bad pattern in the file and added more of the same.

**Good — agent aligns the file while making the primary change:**

```typescript
// user-service.ts — same primary change (add createUser), file left better
import { db } from "../db/client";
import { logger } from "../infra/logger";

function isAccessible(user: User): boolean {
  return user.active && user.verified && !user.banned;
}

export async function getUser(id: UserId): Promise<User | null> {
  const user = await db.find(id);
  return user && isAccessible(user) ? user : null;
}

export async function createUser(data: CreateUserInput): Promise<User> {
  const user = await db.insert(data);
  logger.info("created user", { userId: user.id });
  return user;
}
```

The primary intent (adding `createUser`) is unchanged. The diff also renames `d` → `user`, extracts the condition, fixes imports, and tightens types. Small changes that take seconds and prevent future agents from inheriting the drift.

**Bad — agent over-reaches into unrelated files:**

```
Agent is fixing a bug in order-service.ts.
It notices user-service.ts also has stale imports, so it updates that file too.
The PR now touches 6 files instead of 1; reviewers can't tell what was the bug fix.
```

Fix the file you're in. Leave others alone.

## Exceptions

When alignment would dwarf the primary change in diff size (roughly >30% of the diff), scope cleanup down to the highest-severity issues (type safety, dead code removal) and note the remaining drift for a follow-up.

Generated files (build artifacts, auto-generated clients, protobuf outputs, ORM migrations) are exempt — alignment must happen in the source that generates them, not the output.

Mechanical changes (bumping a version string, updating a URL in config) don't require full alignment — adding unrelated cleanup to such PRs creates noise.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "Fixing that variable name isn't my job in this PR." | The file is already in your diff. The cost is near zero. Leaving it misaligned forces every future reader to decode the same bad name. | Rename it. Note the cleanup briefly in the PR description. |
| "I don't want to add noise to the diff." | A renamed variable or extracted helper in an otherwise-large diff is signal, not noise. Noise is touching unrelated files. | Keep cleanup within the file you're modifying. |
| "I'm not sure what the current standard is." | Uncertainty is a reason to look it up, not a reason to leave drift in place. | Read the relevant CLAUDE.md or principle. Apply what it says. |
| "I'll do a cleanup PR later." | Cleanup PRs almost never happen. Each deferred fix raises the probability that the next agent copies the wrong pattern. | Clean it now, in the same commit, while you're already there. |
| "Aligning types could change behavior." | Type annotation fixes don't change runtime behavior. If a type correction requires a logic change to compile, that's a bug — fix it or open an issue. | Make the type correction. |

## Related

[[refactoring-integrity]] defines what genuine improvement looks like — splits must follow real domain boundaries, not cosmetic line-count reduction. Leave-touched-files-better sets the obligation to improve while refactoring-integrity keeps the improvement substantive rather than superficial.

## Verification

- [ ] Every modified file was scanned for quick wins: confusing names, dead code, stale imports, loose types.
- [ ] Small, safe improvements were made in files already in the diff — not a rewrite, not a separate cleanup pass.
- [ ] No files outside the primary change scope were modified solely for cleanup.
- [ ] If cleanup was scoped down due to the 30% threshold, remaining drift items are noted for follow-up.
- [ ] The primary intent of the change is still clearly readable in the diff despite the cleanup.
