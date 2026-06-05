# Principle Tier Routing

The writer operates in two contexts: as a **plugin maintainer** editing the portable `principles/` directory that ships with the plugin, and as a **project adopter** editing `.canon/principles/` for a local project. This reference defines how the writer detects which context it is in and routes the save accordingly.

---

## Detection

Run both shell checks once, before saving any principle:

> **Precondition**: run these checks from the repository/worktree root. `git ls-files principles/` resolves the pathspec relative to the current working directory — if run from a subdirectory it will return empty and the writer will silently fall back to installed-copy.

```sh
# tracked-source iff BOTH return non-empty / succeed:
git ls-files principles/ | head -1          # non-empty → principles/ is tracked here
test -d "$(git rev-parse --show-toplevel)/principles"  # principles/ lives under THIS worktree root
```

**tracked-source context** (plugin maintainer): both checks pass — `git ls-files` returns a filename AND the directory exists directly under the worktree root.

**installed-copy context** (project adopter): default to this whenever either check fails, errors, or returns empty — including when not inside a git repo, when `principles/` is absent from the worktree root, or when `git rev-parse --show-toplevel` errors. If in doubt, default to installed-copy.

The test is purely structural — it asks "is the portable principles directory my own tracked source?" A tracked root `principles/` directory is assumed to be the portable plugin set; an adopter whose own project happens to have a root-level git-tracked `principles/` directory would classify as tracked-source, which is harmless — the write lands in their own version-controlled tree and nothing is lost.

---

## Classification Test (tracked-source context only)

When the detection result is **tracked-source**, apply this two-question test to decide whether the new principle is **universal** (portable, ships via release) or **project-specific** (local to this repo):

1. **Would this principle constrain the code of a team that adopted Canon for an entirely unrelated project?**
   - No → project-specific (save locally).

2. **Is this principle a specialization of an existing universal principle onto this project's own internals?**
   - Yes → project-specific (save locally).

If neither condition applies, the principle is **universal**.

When the detection result is **installed-copy**, skip this test entirely — all principles save locally (see Action Table).

---

## Action Table

| Detected context | Principle type | Save destination |
|---|---|---|
| installed-copy | any | `.canon/principles/<sev>/{id}.md` |
| tracked-source | project-specific | `.canon/principles/<sev>/{id}.md` |
| tracked-source | universal | `principles/<sev>/{id}.md` |

`<sev>` is the severity subdirectory: `rules/`, `strong-opinions/`, or `conventions/`.

---

## Guardrails

**Clobber-on-update is impossible by construction.** The writer can only target an installed `principles/` directory if `git ls-files principles/` returns non-empty and the path resolves under the worktree root — conditions that are false for any installed copy. An adopter's writer therefore cannot overwrite the portable set.

**Universal writes require a justification line.** Before saving to `principles/<sev>/`, confirm the answer to classification question 1 is affirmative, then record a one-line "applies to unrelated adopters" justification in the principle-authoring SUMMARY artifact.

**apply-proposal mode requires a HITL confirm before a portable write.** In `apply-proposal` mode no human is reviewing the content interactively, so add an explicit confirmation step before writing to `principles/<sev>/`. In interactive modes (new-principle, new-agent-rule, edit) the classification conversation with the user serves as the confirmation — no extra gate is needed.

**Upstream contribution is out of scope.** An adopter who wants to contribute a local principle to the upstream plugin does so manually (e.g., via a pull request). The writer does not implement any automated upstream-PR or staged-artifact path.
