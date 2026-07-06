# T2 Probe Rubric — `leave-touched-files-better`

You are checking a single Canon engineering principle against a unified git diff.
This is a throwaway measurement instrument, not a build gate — your output is
never used to block or warn a build; it only feeds a recall/false-positive
measurement. Apply the rubric below exactly.

## The principle

**Leave Touched Files Better Than You Found Them.** Every time an agent modifies
a file — for a feature, bug fix, refactor, or test — it should leave that file a
little better than it found it: rename confusing variables, extract a gnarly
condition into a well-named helper, remove dead code, fix stale imports, tighten
loose types. Small, safe improvements as part of the same pass — not a rewrite,
not a cleanup sprint, and never in files that aren't already changing.

The constraint is deliberate: **only files already being modified in the diff.**
Do not flag anything in a file the diff does not touch.

## What "a little better" looks like (few-shot anchors)

A finding is warranted only when one of these was clearly available in a
touched file and was not taken:

1. **Rename the worst variable** — e.g. `d` → `durationMs`, `tmp` → `pendingBatch`.
2. **Extract a complex condition** — a multi-clause `if` that could become a
   well-named helper like `isEligibleForRetry()`.
3. **Remove dead code** — an unused import, an unreachable branch, a
   commented-out block, in a line the diff already touches or that sits beside
   the change.
4. **Fix stale imports** — e.g. a barrel import where the rest of the file (or
   the repo's stated convention) uses path imports.
5. **Tighten types** — an `any` that could be the actual type; a missing return
   annotation on a function the diff modifies.
6. **Delete unused variables or parameters** — when safe and obvious from the
   diff alone.

Do NOT flag: mechanical changes (version bumps, config value edits), files
where the improvement would exceed roughly 30% of that file's diff size, or
anything in a file the diff does not touch. When in doubt, do not flag —
false positives cost more here than a missed finding.

## Recent real violations of this principle (for calibration)

These are actual violation messages a Canon reviewer previously recorded for
this principle, on unrelated builds. They show the level of specificity and
the kind of "left it worse" judgment expected — not a checklist to match
verbatim:

- "auth.ts:23 imports './loopback-host.js' — the lone .js relative import among
  43 .ts imports in mcp-server/src/app. Build passes (bundler resolution), but
  it breaks the prevailing .ts convention."
- "Module header (L4-13) and runJanitor JSDoc (L498) still list three tasks;
  the diff adds a fourth (prune_husk_dirs) without updating either. Fix: add
  the new task to both doc blocks."
- "Line 61: Observable-failures convention still documents preceding-comment
  annotation style but all annotations were standardized to inline. Creates
  documentation-code inconsistency that will mislead future engineers."
- "DecisionSummary type (lines 89-94) and decision_summaries: DecisionSummary[]
  field on RunSummary (line 125) are dead code. No code produces
  DecisionSummary values -- buildRunSummary hardcodes decision_summaries: [].
  The type exists solely to type an always-empty array."

## Your task

Read the unified diff provided below. For each file the diff touches, decide
whether a clearly-available "leave it better" improvement was skipped. Emit at
most one finding per file. If no touched file has a clear miss, emit zero
findings.

## Output format

Produce your reasoning, then end your response with the verdict block
delimited exactly as shown — the delimiters must appear on their own lines
with no leading or trailing whitespace.

**No findings:**

```
---VERDICT---
VERDICT: PASS
SUMMARY: No clear leave-touched-files-better misses in the touched files.
FINDINGS:
---END_VERDICT---
```

**Findings present:**

```
---VERDICT---
VERDICT: FINDINGS
SUMMARY: 1 touched file had a clearly-available improvement left on the table.
FINDINGS:
- file_path: src/service.ts
  line: 42
  description: "Variable `d` on this touched line could be renamed to `durationMs` — the same rename the diff already applies two lines below."
---END_VERDICT---
```

The `FINDINGS:` list must use YAML-compatible indentation (2-space indent,
`key: value`). Omit `line` (write `line: null`) when the finding is
file-level rather than line-level. Always include the delimiters exactly as
shown, even when `VERDICT: PASS`.

## Diff to review

The unified diff follows, fenced below:
