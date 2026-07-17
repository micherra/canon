<!--
review-corpus-shapes.md — the CHECKED-IN corpus contract fixture.

Every review shape MEASURED in the real archived corpus (PROBE-FINDINGS Findings 1 and 5),
pinned here with a known-expected id per shape. `review-format-contract.test.ts` feeds each
block through the SHIPPED parser and asserts the expected id falls out.

WHY THIS FILE IS CHECKED IN: the gate must never read `.canon/history/`. That directory is
gitignored, machine-specific, and ABSENT IN CI — a gate anchored to it passes locally and is
a silent no-op in CI, a green check asserting nothing. That is the same silent-failure shape
as the bug this gate exists to prevent.

WHY BLOCKS, NOT ONE REVIEW.md: `extractViolationsSection` matches only the FIRST
`#### Violations` section of a document (non-global match, terminated by the next heading).
A single literal REVIEW.md therefore cannot exercise six violation tables — only the first
would ever parse, and the other five assertions would be vacuous. Each block below is a
complete standalone mini-review; the test splits on the `=== SHAPE: <name> ===` delimiter
and parses each independently.

ADDING A SHAPE: add a block here AND its expected id in the test's EXPECTED map. A block
with no expectation fails the suite (see "every fixture block has an expectation").
-->

=== SHAPE: canonical-4col ===
---
verdict: WARNING
files-reviewed: 2
principles-checked: 8
---

#### Violations
| Principle | Severity | Location | Confidence |
|-----------|----------|----------|------------|
| errors-are-values | rule | `src/a.ts:10` | HIGH |

=== SHAPE: minimal-3col ===
---
verdict: WARNING
files-reviewed: 1
principles-checked: 3
---

#### Violations
| Principle | Severity | Location |
|-----------|----------|----------|
| single-source-of-truth | convention | `src/b.ts:22` |

=== SHAPE: full-6col-escaped-pipe ===
---
verdict: BLOCKING
files-reviewed: 4
principles-checked: 12
---

#### Violations
| Principle | Severity | Location | Confidence | Description | Fix |
|-----------|----------|----------|------------|-------------|-----|
| fail-closed-by-default | rule | `hooks/gate.sh:4` | {HIGH\|MEDIUM\|LOW} | gate fails open | invert the guard |

=== SHAPE: file-column-5col ===
---
verdict: WARNING
files-reviewed: 2
principles-checked: 6
---

#### Violations
| Principle | Severity | File | Description | Fix |
|-----------|----------|------|-------------|-----|
| tests-are-deterministic | convention | `src/c.test.ts:9` | reads Date.now() | thread now in |

=== SHAPE: ordinal-location-5col ===
---
verdict: WARNING
files-reviewed: 3
principles-checked: 7
---

#### Violations
| # | Principle | Severity | Location | Description |
|---|-----------|----------|----------|-------------|
| 1 | validate-at-trust-boundaries | rule | `src/d.ts:31` | overlay text trusted |

=== SHAPE: ordinal-file-6col ===
---
verdict: WARNING
files-reviewed: 2
principles-checked: 5
---

#### Violations
| # | Principle | Severity | File | Description | Fix |
|---|-----------|----------|------|-------------|-----|
| 1 | observable-best-effort | convention | `src/e.ts:12` | silent skip | count the outcome |

=== SHAPE: prose-row-rejected ===
---
verdict: WARNING
files-reviewed: 1
principles-checked: 2
---

#### Violations
| Principle | Severity | Location | Confidence |
|-----------|----------|----------|------------|
| Robust git-failure degradation | rule | `src/f.ts:1` | HIGH |
| noExcessiveLinesPerFile | rule | `src/f.ts:2` | LOW |

=== SHAPE: honored-shapes ===
---
verdict: CLEAN
files-reviewed: 2
principles-checked: 9
---

#### Honored
- **fail-closed-by-default**
- **errors-are-values**: gate returns a Result
- **single-source-of-truth** — one writer for the closed domain
- tests-are-deterministic (rule)
- **DOCUMENTED FAIL-OPEN on the new git-log call**
