---
id: managed-artifact-class-shape
title: New Artifact Classes and Instances Mirror the Nearest Existing Shape
severity: convention
portable: true
scope:
  layers: []
  file_patterns:
    - "mcp-server/src/shared/matcher.ts"
    - "mcp-server/src/shared/routine.ts"
    - "mcp-server/src/features/loops/load-loops.ts"
    - "mcp-server/src/app/register-*.ts"
    - "mcp-server/src/app/create-server.ts"
    - "mcp-server/src/features/loops/**"
    - "mcp-server/src/features/routines/**"
    - "mcp-server/src/features/principles/**"
    - "loops/*.md"
    - "routines/*.md"
    - "principles/**"
related:
  - simplicity-first
promoted_from: watch_WWWWWWW1
---

When adding a new filesystem-resident artifact class to the MCP server, clone the nearest existing class loader rather than inventing new loading or registration infrastructure. The same applies one abstraction level up: when adding a new instance within an existing artifact class, mirror the body idiom of the nearest known-good sibling.

## Rationale

Canon has three filesystem-resident artifact classes: principles (`principles/`), loops (`loops/`), and routines (`routines/`). Every one was built by cloning the prior class's loader shape — not by inventing parallel infrastructure. The result is a predictable, auditable registry pattern any contributor can extend with confidence.

The five-element shape that emerged organically across all three classes is:

1. **Loader function** (`loadAll*` or `loadXxxFromDir`): reads a directory of `.md` files, parses gray-matter frontmatter, returns a typed list. Modelled on `mcp-server/src/shared/matcher.ts:loadMdFilesFromDir` (line 156) and `loadAllPrinciples` (line 368).
2. **Error channels**: returns `{ valid, invalid }` (or equivalent) so callers can observe failures without crashing. ENOENT is swallowed to an empty registry — same sentinel as `matcher.ts`.
3. **Gray-matter parsing**: reuses the shared `gray-matter` dependency already in use — no new parser library introduced.
4. **Registration factory** (`register-*.ts`): a single exported `registerXxxTools(server: McpServer)` function, wired into `mcp-server/src/app/create-server.ts` as the Nth tool group. See `register-loops.ts`, `register-routines.ts`, `register-principles.ts`.
5. **MCP tool pair** (`list_*` / `get_*`): the public surface, explicitly modelled as peers of `list_principles` / `get_principles`.

The project-local-first precedence rule also applies: project `<class>/` overrides plugin-bundled `<class>/`, with name-conflict resolution in favor of the project. (`loadAllRoutines` in `mcp-server/src/shared/routine.ts` is the reference implementation.)

**At the instance level**, the same principle applies within a class. A new self-paced loop mirrors `loops/session-watch.md`'s observe→diff→surface→write→terminate + ScheduleWakeup re-arm skeleton. An interval loop mirrors `loops/ship-watch.md`. Mirroring the sibling's body idiom is the fastest path to a correct, ADR-compliant instance.

Not reinventing yields compounding dividends: a reader who understands one loader understands all of them; a test suite for one pattern covers the others; a bug found in one shape is easy to audit across siblings.

## Examples

**Bad — invents a parallel loader for a new `templates/` artifact class:**

```typescript
// mcp-server/src/features/templates/load-templates.ts
import { readFile } from "fs/promises";
import TOML from "@iarna/toml";  // ← new parser, new dependency

export async function loadTemplates(dir: string) {
  // custom TOML parsing, custom error model, no { valid, invalid } channels
  const raw = await readFile(join(dir, "index.toml"), "utf-8");
  return TOML.parse(raw).templates;
}
```

```typescript
// mcp-server/src/app/create-server.ts
// ← templates tools added inline here rather than in a register-templates.ts factory
server.tool("list_templates", ..., async () => { /* inline, not in register file */ });
```

**Good — clones the existing loader shape for a new `templates/` artifact class:**

```typescript
// mcp-server/src/features/templates/load-templates.ts
// Modelled directly on mcp-server/src/shared/matcher.ts loadMdFilesFromDir
// and mcp-server/src/shared/routine.ts loadAllRoutines

import matter from "gray-matter";   // ← same dependency already in use
import { readdir, readFile } from "fs/promises";

export interface LoadTemplatesResult {
  valid: Template[];
  invalid: Array<{ file: string; error: string }>;
}

export async function loadTemplatesFromDir(dir: string): Promise<LoadTemplatesResult> {
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    const valid: Template[] = [];
    const invalid: Array<{ file: string; error: string }> = [];
    for (const file of files) {
      const raw = await readFile(join(dir, file), "utf-8");
      const { data, content } = matter(raw);
      const result = parseTemplate(data, content);
      if (result.ok) valid.push(result.value);
      else invalid.push({ file, error: result.error });
    }
    return { valid, invalid };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { valid: [], invalid: [] };
    throw err;
  }
}

export async function loadAllTemplates(
  projectDir: string,
  pluginDir: string
): Promise<Template[]> {
  // project-local-first: project templates/ overrides plugin templates/
  const pluginTemplates = await loadTemplatesFromDir(join(pluginDir, "templates"));
  const projectTemplates = await loadTemplatesFromDir(join(projectDir, "templates"));
  const seen = new Map(pluginTemplates.valid.map((t) => [t.name, t]));
  for (const t of projectTemplates.valid) seen.set(t.name, t); // project wins on name conflict
  return [...seen.values()];
}
```

```typescript
// mcp-server/src/app/register-templates.ts  ← factory file mirrors register-routines.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadAllTemplates } from "@features/templates/load-templates.ts";

export function registerTemplateTools(server: McpServer): void {
  server.tool("list_templates", ..., async ({ projectDir, pluginDir }) => {
    const templates = await loadAllTemplates(projectDir, pluginDir);
    return { templates };
  });
  server.tool("get_template", ..., async ({ name, projectDir, pluginDir }) => {
    const templates = await loadAllTemplates(projectDir, pluginDir);
    return templates.find((t) => t.name === name) ?? null;
  });
}
```

```typescript
// mcp-server/src/app/create-server.ts  ← wired in as the Nth tool group
import { registerTemplateTools } from "./register-templates.ts";
// ...
registerTemplateTools(server);
```

**Good — new self-paced loop mirrors `session-watch.md` body idiom:**

```yaml
# loops/my-new-watch.md (excerpt)
---
mode: self-paced
guardrails:
  mutates_build: false
schedule:
  initial_delay_seconds: 300
  active_delay_seconds: 900
---
# Observe
Call list_* to snapshot current state (read-only).
# Diff
Compare to prior snapshot at ${state.path}.
# Surface
If condition met: write summary to ${state.path}/surface.md
  ORCHESTRATOR_ACTION: <action> field=<field> loop=my-new-watch
  Self-terminate.
# Re-arm
ScheduleWakeup({ delaySeconds: active_delay_seconds, prompt: "Run one tick of Canon loop my-new-watch..." })
```

## Exceptions

- **In-memory-only registries**: If the new class has no filesystem representation (e.g., a registry built entirely from database rows or env vars), the loadAll*/gray-matter pattern does not apply.
- **Deliberately different shape with documented rationale**: If the existing loader shape is genuinely wrong for the new class — for example, the new class requires streaming parsing or a binary format — document the reason in the class's DESIGN.md or the implementing ADR. The deviation is then exempt from this convention. The key word is *documented*: an undocumented departure is not an exception, it is a violation.
- **Instance body mirroring caveat**: Mirroring a sibling's body idiom guarantees the self-contained body is correct; it does NOT guarantee the dispatch/tap layer wiring is correct. Cross-cutting wiring (e.g. which lifecycle hook fires the new loop, how `ORCHESTRATOR_ACTION` is consumed) must be verified independently. See open watch_MMMMMMMMMMMM1.

## Counter-Pattern

Inventing a parallel loader, parser, or registration mechanism when a known-good one already exists for a neighboring class. Indicators: a new YAML/TOML/JSON parser dependency where `gray-matter` already covers the use case; a new tool-registration helper instead of a `register-*.ts` factory; a new override-precedence algorithm instead of the project-local-first pattern from `loadAllRoutines`.

## Verification

- [ ] New artifact class has a `register-<class>.ts` factory wired into `create-server.ts`: `grep -rn "register<Class>Tools" mcp-server/src/app/create-server.ts` returns a match.
- [ ] Loader uses `gray-matter` for frontmatter parsing (no new parser library introduced): `grep -rn "gray-matter" mcp-server/src/features/<class>/` returns a match.
- [ ] Loader returns `{ valid, invalid }` or equivalent error channels and swallows `ENOENT` to empty registry.
- [ ] MCP tools are named `list_<class>` / `get_<class>` (peer naming with `list_principles` / `get_principles`).
- [ ] If a new loop: body follows observe→diff→surface→terminate + ScheduleWakeup re-arm skeleton of the nearest sibling loop.
- [ ] Any documented exception names the concrete reason the existing shape is wrong.
