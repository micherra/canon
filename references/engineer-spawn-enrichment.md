---
name: engineer-spawn-enrichment
description: >-
  Full engineer spawn enrichment texts for the five build-shape triggers:
  fast-path (4+ files), learner-proposal retroactive grep, dead-code-removal
  grep sweep, wiring-task tool-allowlist verification, and hook-bypass-fix
  posture guidance.
---

# Engineer Spawn Enrichment

<!-- Managed by Canon. Manual edits are preserved. -->

**Purpose**: Verbatim enrichment texts to append to the engineer spawn prompt based on build shape. Read BEFORE spawning an engineer when the build matches one of the five triggers. See `CLAUDE.md` § Setup (Trivial path) for the trigger table and inline pointer.

**Fast-path enrichment**: For 4+ files or 2+ workstreams, include in engineer spawn prompt: scope summary, key files with one-line purpose, known gotchas.

**Learner-proposal enrichment**: When the build addresses learner findings, add to the engineer spawn prompt: "After implementing each proposal, grep the same file and related files in the same directory for existing instances of the violation pattern. Apply the fix retroactively to every instance found. List retroactive fixes in the Criteria Coverage table."

**Dead-code-removal enrichment**: For builds that delete symbols, functions, types, or directory paths, add to the engineer spawn prompt: "After deleting each symbol, grep the full codebase for: (1) the symbol name as a string literal (catches constant arrays and config entries), (2) the TypeScript type name (catches orphan type declarations whose value-producers were deleted), (3) any directory path strings being removed (catches docstrings and comments). List all additional deletions in the Criteria Coverage table."

**Wiring-task enrichment**: The standing dead-wire gate (Step Enforcement Contracts → Verify step) now enforces new-export reachability automatically; the manual checks below remain engineer-facing guidance for closing wiring ACs with explicit evidence. When the build spec requires that agent X calls tool Y (new or pre-existing), add to the engineer spawn prompt: "Before closing any AC that says agent X must call tool Y, verify: (1) `awk '/^tools:/{in_tools=1; next} in_tools && /^[^ \t]/{exit} in_tools{print}' agents/X.md | grep '  - mcp__canon__Y$'` returns a match — this confirms Y is in the `tools:` allowlist, not merely mentioned in the description or body; (2) `grep -rn '"Y"' mcp-server/src/app/register-*.ts` (quoted-string form in registration files) returns a non-empty result — a match only in a doc comment or non-registration file does not satisfy this condition. Both checks are required. List the command output as evidence in the Criteria Coverage table."

**Hook-bypass-fix enrichment**: For safety-hook bypass fixes, add to the engineer spawn prompt: "Prefer a vocabulary-free / fail-closed-on-unrecognized predicate over an enumerated wrapper/token list — each new list item closes one form and opens the next unlisted one. If this fix is the Nth patch of the same bypass class, treat it as a posture rethink, not another enumeration (see `.canon/principles/conventions/security-hook-parser-allowlist-posture.md`, watch_UUUUUUUU2)."
