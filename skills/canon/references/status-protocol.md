# Status Reporting Protocol

Every Canon agent reports a status keyword to the orchestrator. The orchestrator lowercases the keyword and matches it against the current state's transition map.

## Valid Status Keywords

Report exactly ONE of these in ALL CAPS as the last substantive line of your output.

### Universal statuses (available to all agents)

| Status | When to Use | Transition |
|--------|------------|------------|
| **DONE** | Work completed successfully | `done` |
| **DONE_WITH_CONCERNS** | Completed, but flagging a risk or issue for attention. Include concern text — it's appended to `board.json concerns[]` | `done` |
| **BLOCKED** | Cannot proceed — needs external input, missing dependency, or unresolvable error | `blocked` → `hitl` |
| **NEEDS_CONTEXT** | Missing required template, input, or context that should have been provided | `hitl` |

### Agent-specific statuses

| Status | Used By | When to Use | Transition |
|--------|---------|------------|------------|
| **CLEAN** | reviewer, security | Zero violations / zero findings | `clean` |
| **WARNING** | reviewer | Strong-opinion violations only, no rule violations | `warning` |
| **BLOCKING** | reviewer | At least one rule-severity violation | `blocking` |
| **ALL_PASSING** | tester | All tests pass, no implementation issues | `all_passing` |
| **IMPLEMENTATION_ISSUE** | tester | Tests fail due to implementation bugs | `implementation_issue` |
| **FIXED** | fixer | Violation fully resolved and committed | `done` (alias) |
| **PARTIAL_FIX** | fixer | Some violations fixed, others remain for next iteration | `done` (alias) |
| **CANNOT_FIX** | fixer | Cannot resolve automatically — needs human or architectural change | `cannot_fix` |
| **FINDINGS** | security | Non-critical findings exist but nothing blocks the pipeline | `done` (alias) |
| **CRITICAL** | security | At least one critical finding — blocks the pipeline | `critical` |
| **UPDATED** | scribe | At least one document was modified | `updated` |
| **NO_UPDATES** | scribe | All changes were internal/test-only, no doc updates needed | `no_updates` |
| **HAS_QUESTIONS** | architect | Unresolved questions requiring user input before design can proceed | `has_questions` |

## Decision Guide

When unsure which status to report:

- **BLOCKED vs DONE_WITH_CONCERNS**: BLOCKED = you cannot produce working output. DONE_WITH_CONCERNS = output is complete and usable, but you're flagging something.
- **BLOCKED vs NEEDS_CONTEXT**: BLOCKED = you understand the task but hit an obstacle. NEEDS_CONTEXT = you don't have enough information to even start meaningfully.
- **FIXED vs PARTIAL_FIX**: FIXED = all violations in your assignment are resolved. PARTIAL_FIX = some are resolved, others remain (they'll be retried in the next iteration).
- **CANNOT_FIX vs BLOCKED**: CANNOT_FIX = you understand the violation but it requires changes beyond your scope (architectural redesign, user decision). BLOCKED = something unexpected prevents you from working.

## Format

End your output with a clear status line:

```
Status: DONE
```

or embedded in a summary:

```
All tests pass. No implementation issues found.
Status: ALL_PASSING
```

The orchestrator scans for the status keyword — make it unambiguous.
