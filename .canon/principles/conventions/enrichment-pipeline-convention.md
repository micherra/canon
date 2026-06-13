---
id: enrichment-pipeline-convention
title: Enrichment Pipeline Follows DAO + Service + Fail-Open Wrapper Shape
severity: convention
portable: false
tags: [architecture, testability, agent-behavior, diagnostics]
scope:
  file_patterns:
    - "mcp-server/src/features/diagnostics/services/**"
    - "mcp-server/src/features/diagnostics/tools/**"
    - "mcp-server/src/features/orchestration/tools/**"
    - "mcp-server/src/platform/storage/**"
    - "mcp-server/src/app/**"
  layers: []
---

When adding a new enrichment section to the `resolve_agent_skills` spawn prompt,
follow the established pipeline shape: DAO → service → fail-open wrapper → integration.

## Shape

1. **DAO** (`platform/storage/drift/`): Prepared statements in constructor, synchronous methods,
   early return for empty inputs. Accessor added to `DriftDb` as a lazy getter.

2. **Service** (`features/diagnostics/services/`): Pure functions accepting DAO as a parameter
   (not imported directly). Three functions: query function (derives keys, caps output),
   format function (markdown section, empty string on empty input), fail-open wrapper
   (`build*Section` returning `{ section: string; count: number }`).

3. **Fail-open wrapper**: Must include `console.warn("[{service-tag}] build*Section failed:", ...)`
   in the catch block. A comment-only catch is a violation of `observable-best-effort`.

4. **Integration** (`resolve-agent-skills.ts`): Add a helper function (e.g., `build*Sections()`)
   and call it from `buildFeedForwardSections()`. Section order must be maintained:
   base → corrections → pitfalls → area memory → hot-file caution → (new section appended here).

5. **Audit event**: Log `{feature}_enrichment_injected` when `count > 0` and `workspace` is present.

## Examples

Reference implementations:
- `area-memory-enrichment.ts` + `AreaMemoryDao` (added 2026-05-29)
- `pitfall-enrichment.ts` + `DriftDbSignals.getErrorFixes` (added 2026-05-22)
- `hot-file-detection.ts` + `DriftDb` (added 2026-05-29)

## Verification

- [ ] DAO lives in `platform/storage/drift/` with prepared statements and empty-input guard
- [ ] Service lives in `features/diagnostics/services/` and accepts DAO as a parameter
- [ ] Fail-open wrapper returns `{ section: string; count: number }` and catch block uses `console.warn`
- [ ] Integration point added to `resolve-agent-skills.ts` via `buildFeedForwardSections()`
- [ ] Section order maintained (base → corrections → pitfalls → area memory → hot-file caution → new)
- [ ] Audit event logged when `count > 0` and `workspace` is present

## Related

- `dao-parameter-injection-in-diagnostics-services` — specifies the DAO injection mechanism
- `observable-best-effort` — fail-open catch blocks must emit `console.warn`
- `define-errors-out-of-existence` — empty inputs return empty results, never errors
