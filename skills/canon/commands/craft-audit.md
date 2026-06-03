---
description: Audit craft quality of high-impact codebase areas against the Canon rubric
argument-hint: "[area-or-path | --limit N]"
allowed-tools: [Read, Grep, Glob, mcp__canon__graph_query, mcp__canon__get_file_context, mcp__canon__semantic_search]
model: sonnet
---

Evaluate existing code in high-impact areas against the Canon craft rubric and persist the results. Run this command periodically to track craft quality trends independently of build flows.

**Negative scope**: This command does NOT modify any source code, does NOT gate or block builds, and does NOT run automatically — it is an on-demand diagnostic only.

## Instructions

### Step 1: Parse arguments

From `${ARGUMENTS}`, extract:
- **Explicit area or path**: a subsystem key (e.g., `features/orchestration`) or file path. When provided, audit only that area.
- **`--limit N`**: maximum number of areas to audit (default: 5). Ignored when an explicit area is given.

If `${ARGUMENTS}` is empty, proceed with the default flow (Step 2, no explicit area).

### Step 2: Select high-impact areas

**When an explicit area or path was given in Step 1:**
- Derive the subsystem key (strip `mcp-server/src/`, `tools/`, `services/`, `__tests__/` path segments; take the directory path).
- Use that single area as the audit target. Skip Step 2 graph query.

**When no explicit area was given:**
- Call `mcp__canon__graph_query` with `query_type: "blast_radius"` to find high-impact files. Use `options.limit: 50` to get enough signal.
- From the returned file list, the audit service `selectAuditAreas` logic applies: map each file to its subsystem key via the same rules as `deriveSubsystemKey`, deduplicate, and take the top `N` (where N = `--limit` value, default 5).
- State which areas were selected and why (e.g., "top 5 areas by blast radius: features/orchestration, platform/storage/drift, ...").

### Step 3: Rate each area

For each selected area:

1. Use `mcp__canon__get_file_context` on 2–3 representative files in the area to understand the structure, imports, and exports.
2. Use `Read` or `Grep` to read the most important source files in the area (prefer the highest-impact files identified by the graph query).
3. Rate the area across all 6 Canon craft dimensions using the same rubric as the reviewer:

| Dimension | What to assess |
|-----------|---------------|
| **simplicity** | Is the code the simplest thing that works? No unnecessary abstractions, frameworks, or indirection. |
| **cohesion** | Does each function/module do one thing? Are responsibilities grouped sensibly? |
| **interface-depth** | Are interfaces narrow and deep? Is complexity hidden behind simple APIs? |
| **naming** | Are names precise and in the project's ubiquitous language? Do names reveal intent? |
| **locality** | Is related code co-located? Can you read and change a behavior without jumping across files? |
| **predictability** | Does the code behave as the name/docs promise? No hidden side effects? |

For each dimension, assign:
- **band**: `"strong"` / `"adequate"` / `"weak"` / `"n-a"`
- **evidence**: 1–2 sentences citing specific code patterns, function names, or structural observations
- **principle_refs**: relevant Canon principle IDs (e.g., `"simplicity-first"`, `"information-hiding"`)

Compute an optional **rollup score** (1–3 ordinal mean) as the mean of rated dimensions' band ordinals (strong=3, adequate=2, weak=1, n-a excluded). Omit the rollup when all dimensions are n-a. This matches the scale used by `craftBandOrdinal` in craft-rubric.ts and the reviewer agent.

### Step 4: Persist each area's profile

For each rated area, call the audit service to persist the profile. Since this command runs as an agent (not a TypeScript process), log the profile data you would persist and note that the caller (the MCP tool or the /canon:craft-audit automation layer) invokes `persistAuditProfile` with:

```
subsystem_key: <derived key>
ratings: [{ dimension, band, evidence?, principle_refs? }, ...]
rollup: <computed rollup>
source: "audit"   ← always
flow: undefined   ← never set by audit
run_id: undefined ← never set by audit
```

If you are running inside the Canon MCP server context (i.e., the tool implementation calls this service directly), the write happens automatically. If you are operating as a slash-command agent without direct service access, output the profile data in structured form so the caller can persist it.

### Step 5: Report results

Present a per-area craft profile summary:

```markdown
## /canon:craft-audit Results

Audited N area(s) — {timestamp}

### {subsystem_key}

| Dimension | Band | Evidence |
|-----------|------|----------|
| simplicity | adequate | ... |
| cohesion | strong | ... |
| interface-depth | weak | ... |
| naming | adequate | ... |
| locality | strong | ... |
| predictability | adequate | ... |

**Rollup score**: 2.33

**Top finding**: {one-sentence summary of the most important craft observation}
**Suggested follow-up**: {one actionable improvement, or "none identified"}
```

After all areas: summarize which area has the weakest craft (lowest rollup or most `weak` bands) and suggest it as the priority for a future improvement build.

**Reminder**: This audit does NOT modify code, does NOT block builds, and does NOT run automatically. It is a read-only diagnostic snapshot.
