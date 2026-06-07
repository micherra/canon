---
id: shared-renderer-helper-placement
title: Shared Renderer Helpers — Build-Time Logic in DESIGN-SYSTEM.md, Runtime Scripts in Snippet Files
severity: convention
scope:
  file_patterns:
    - "templates/renderer-*.md"
    - "mcp-server/src/ui/snippets/**"
tags:
  - renderer
  - templates
  - ui
---

When two or more renderer templates share logic, place the canonical definition based on **execution time** — where and when the code actually runs.

**Build-time helpers** — functions the renderer agent calls while composing the HTML string (e.g., `escapeHtml`, `markdownToHtml`, `inlineFormat`). The function's *return value* appears in the emitted page; the function body does not. Canonical home: `mcp-server/src/ui/snippets/DESIGN-SYSTEM.md` under the appropriate section (currently Section E for security/escaping helpers). All four renderers already read DESIGN-SYSTEM.md in Step 1 — no new file or read step required. Templates instruct the renderer agent: "Copy the canonical definition verbatim from DESIGN-SYSTEM.md Section E into your build-time rendering script."

**Runtime page scripts** — JavaScript emitted *verbatim* into the HTML page and executed by the browser (e.g., the Canvas force-directed simulation IIFE). The function body appears in the emitted artifact and is executed by the browser at render time. Canonical home: a dedicated `.html` snippet file under `mcp-server/src/ui/snippets/`, emitted via `await readSnippet("name.html")`. See `force-graph.html` as the reference implementation.

**Discriminator (deterministic):**
- If the function body appears inside a `<script>` tag or Canvas IIFE in the emitted HTML artifact, and the browser executes it → **runtime → snippet file**.
- If the function is called by the renderer agent during template execution and its return value is interpolated into the emitted HTML string → **build-time → DESIGN-SYSTEM.md Section E**.

## Rationale

Three independent builds applied this rule correctly before any documentation existed, confirming the discriminator is stable and non-obvious:

| Instance | Helper | Execution time | Canonical home | Build |
|----------|--------|----------------|----------------|-------|
| 1 | Canvas force-directed simulation IIFE | runtime (browser-executed script) | `mcp-server/src/ui/snippets/force-graph.html` | PR #307 (improve-the-review-html-graph-context) |
| 2 | `escapeHtml` / `markdownToHtml` / `inlineFormat` | build-time (agent uses during composition) | `DESIGN-SYSTEM.md` Section E | PR from extract-the-duplicated-escapehtml-and-markdowntohtml-helper-functions |
| 3 | `markdownToHtml` GFM table support extension | build-time (agent uses during composition) | `DESIGN-SYSTEM.md` Section E | PR #336 (fix-renderer-review-template-so-the-reviewer-narrative-renders-markdown) |

The discriminator is also a refinement of `sug_WWWW1` (renderer-template-no-inline-emittable-script), which covers only the negative runtime-prohibition case. This convention adds the positive build-time placement rule.

## Examples

**Good — `escapeHtml` and `markdownToHtml` canonical in DESIGN-SYSTEM.md Section E:**
```markdown
<!-- In renderer template Step 1 -->
Copy the `escapeHtml` and `markdownToHtml` definitions from DESIGN-SYSTEM.md Section E
verbatim into your build-time rendering script. Do not re-define them inline.
```
The renderer agent copies the definition once at the start of its composition pass; the emitted HTML contains only the *result* of calling the function (escaped strings, rendered markdown), not the function body itself.

**Good — Canvas force-directed IIFE in `force-graph.html`:**
```javascript
// mcp-server/src/ui/snippets/force-graph.html
<script>
function renderForceGraph(containerId, data, options) {
  // Canvas/D3 simulation — browser executes this
  ...
}
</script>
```
Emitted via `await readSnippet("force-graph.html")` in the renderer template. The function body appears in the emitted HTML and executes in the browser.

**Bad — Re-inlining `escapeHtml` definitions per template:**
```javascript
// In renderer-review.md build-time script (WRONG)
function escapeHtml(s) { return s.replace(/&/g,'&amp;')... }
function escapeHtml(s) { return s.replace(/&/g,'&amp;')... } // also in renderer-design.md
```
Each template defines its own copy. When the canonical definition is extended (e.g., adding GFM table support), all copies must be updated independently — a maintenance hazard confirmed by Instance 3 (PR #336).

**Bad — Placing a browser-executed IIFE in DESIGN-SYSTEM.md:**
```markdown
<!-- In DESIGN-SYSTEM.md Section F (WRONG) -->
### Force Graph IIFE
<script>
function renderForceGraph(...) { /* browser-executed */ }
</script>
```
DESIGN-SYSTEM.md is read by the renderer agent at composition time, not emitted verbatim. A browser-executed script placed here would require the template to explicitly re-emit it, creating indirection. Snippet files exist precisely for this case.

## Exceptions

Single-template helpers used by exactly one renderer may stay local to that template until a second consumer appears. When a second template needs the same helper, extract it to DESIGN-SYSTEM.md Section E (if build-time) or a new snippet file (if runtime) in the same build that introduces the second consumer.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "It's just a tiny helper — inline it in the template." | The canonical `escapeHtml` was inlined in three templates before extraction; each copy drifted. Instance 3 required a GFM extension applied to all three separately. | One canonical definition, one update point. The extraction cost is paid once; the drift cost is paid forever. |
| "DESIGN-SYSTEM.md is already read, so put the IIFE there too." | DESIGN-SYSTEM.md content is consumed by the renderer agent, not emitted verbatim. A browser-executed IIFE placed there can only reach the emitted page via an explicit re-emit step. Snippet files are the purpose-built surface for verbatim emission. | Apply the discriminator: browser executes it → snippet file. |
| "Snippet files are for large scripts only; small helpers can stay inline." | Canonical placement is determined by execution time, not size. A 3-line IIFE that the browser executes belongs in a snippet file. A 50-line `markdownToHtml` that the agent calls belongs in DESIGN-SYSTEM.md. Size is irrelevant; execution site is everything. | Use the discriminator, not a size threshold. |

## Verification

- [ ] Every build-time helper shared across 2+ renderer templates has its canonical definition in DESIGN-SYSTEM.md Section E, with templates instructed to copy verbatim.
- [ ] Every browser-executed script shared across 2+ renderer templates lives in a dedicated `.html` file under `mcp-server/src/ui/snippets/`, emitted via `readSnippet`.
- [ ] New renderer helpers are classified by the discriminator (return value interpolated → build-time; body emitted to page → runtime) before deciding canonical home.
- [ ] When extracting a helper to a canonical location, all existing per-template copies are removed in the same build.
