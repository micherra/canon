/**
 * Regression guard for `loadPathAliases` against the REAL, committed root
 * `tsconfig.json` (docs/adr/0061-*.md's TypeScript 7 migration, Finding 2).
 *
 * `loadPathAliases` reads the root tsconfig.json as plain JSON — not through
 * `tsc` — so removing `baseUrl` from that file (required for TS 7, which
 * rejects it outright) could silently change which aliases the knowledge
 * graph resolves, even though `tsc` itself stays green. This test locks the
 * exact alias set the migration must preserve byte-for-byte.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadPathAliases } from "../paths.ts";

const REPO_ROOT = resolve(
  fileURLToPath(import.meta.url),
  // paths.test.ts -> __tests__ -> lib -> shared -> src -> mcp-server -> repo root
  "../../../../../..",
);

describe("loadPathAliases — root tsconfig.json regression guard", () => {
  test("resolves the 8 named aliases to mcp-server/src/* targets, unaffected by baseUrl removal", async () => {
    const aliases = await loadPathAliases(REPO_ROOT);

    // Exact set expected post-migration. Order matches tsconfig.json's
    // declaration order (parseTsconfigPaths iterates Object.entries in
    // insertion order).
    expect(aliases).toEqual([
      { prefix: "@app/", target: "mcp-server/src/app/" },
      { prefix: "@domains/", target: "mcp-server/src/domains/" },
      { prefix: "@features/", target: "mcp-server/src/features/" },
      { prefix: "@graph/", target: "mcp-server/src/graph/" },
      { prefix: "@platform/", target: "mcp-server/src/platform/" },
      { prefix: "@shared/", target: "mcp-server/src/shared/" },
      { prefix: "@tests/", target: "mcp-server/src/tests/" },
      { prefix: "@ui/", target: "mcp-server/src/ui/" },
    ]);
  });

  test("the bare '@/' alias resolves to NO entry — preserved from pre-migration behavior", async () => {
    const aliases = await loadPathAliases(REPO_ROOT);
    expect(aliases.find((a) => a.prefix === "@/")).toBeUndefined();
  });

  test("root tsconfig.json no longer declares baseUrl (required for TypeScript 7)", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(resolve(REPO_ROOT, "tsconfig.json"), "utf-8");
    const tsconfig = JSON.parse(raw);
    expect(tsconfig.compilerOptions.baseUrl).toBeUndefined();
  });
});
