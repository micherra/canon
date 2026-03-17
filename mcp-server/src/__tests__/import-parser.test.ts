import { describe, it, expect } from "vitest";
import { extractImports, resolveImport, parseTsconfigPaths } from "../graph/import-parser.js";

describe("extractImports — JS/TS", () => {
  it("extracts ES module imports", () => {
    const code = `
import { foo } from './foo';
import bar from '../bar';
import * as baz from './baz/index';
`;
    const imports = extractImports(code, "src/test.ts");
    expect(imports).toContain("./foo");
    expect(imports).toContain("../bar");
    expect(imports).toContain("./baz/index");
  });

  it("extracts dynamic imports", () => {
    const code = `
const mod = await import('./dynamic');
import('./another-dynamic');
`;
    const imports = extractImports(code, "src/test.ts");
    expect(imports).toContain("./dynamic");
    expect(imports).toContain("./another-dynamic");
  });

  it("extracts require calls", () => {
    const code = `
const fs = require('fs');
const local = require('./local');
`;
    const imports = extractImports(code, "src/test.js");
    expect(imports).toContain("fs");
    expect(imports).toContain("./local");
  });

  it("extracts re-exports", () => {
    const code = `export { foo } from './foo';`;
    const imports = extractImports(code, "src/index.ts");
    expect(imports).toContain("./foo");
  });

  it("handles mixed import styles", () => {
    const code = `
import { a } from './a';
const b = require('./b');
export { c } from './c';
`;
    const imports = extractImports(code, "src/test.ts");
    expect(imports).toHaveLength(3);
  });

  it("ignores non-JS files", () => {
    const code = `import foo from './bar'`;
    const imports = extractImports(code, "src/test.go");
    expect(imports).toHaveLength(0);
  });
});

describe("extractImports — Python", () => {
  it("extracts from...import statements", () => {
    const code = `
from os.path import join
from .utils import helper
`;
    const imports = extractImports(code, "src/test.py");
    expect(imports).toContain("os.path");
    expect(imports).toContain(".utils");
  });

  it("extracts import statements", () => {
    const code = `
import os
import json
`;
    const imports = extractImports(code, "src/test.py");
    expect(imports).toContain("os");
    expect(imports).toContain("json");
  });
});

describe("resolveImport", () => {
  const allFiles = new Set([
    "src/foo.ts",
    "src/bar/index.ts",
    "src/baz.tsx",
    "src/utils/helper.ts",
  ]);

  it("resolves relative import with extension", () => {
    const result = resolveImport("./foo", "src/main.ts", allFiles);
    expect(result).toBe("src/foo.ts");
  });

  it("resolves relative import to index file", () => {
    const result = resolveImport("./bar", "src/main.ts", allFiles);
    expect(result).toBe("src/bar/index.ts");
  });

  it("resolves relative import with tsx extension", () => {
    const result = resolveImport("./baz", "src/main.ts", allFiles);
    expect(result).toBe("src/baz.tsx");
  });

  it("resolves parent directory imports", () => {
    const result = resolveImport("../foo", "src/bar/main.ts", allFiles);
    expect(result).toBe("src/foo.ts");
  });

  it("returns null for non-relative imports (packages)", () => {
    const result = resolveImport("react", "src/main.ts", allFiles);
    expect(result).toBeNull();
  });

  it("returns null for unresolvable imports", () => {
    const result = resolveImport("./nonexistent", "src/main.ts", allFiles);
    expect(result).toBeNull();
  });

  it("resolves path alias imports", () => {
    const aliases = [{ prefix: "@/", target: "src/" }];
    const result = resolveImport("@/utils/helper", "src/app/page.ts", allFiles, aliases);
    expect(result).toBe("src/utils/helper.ts");
  });

  it("resolves path alias to index file", () => {
    const result = resolveImport("@/bar", "src/app/page.ts", allFiles, [
      { prefix: "@/", target: "src/" },
    ]);
    expect(result).toBe("src/bar/index.ts");
  });

  it("resolves path alias with tsx extension", () => {
    const result = resolveImport("@/baz", "src/app/page.ts", allFiles, [
      { prefix: "@/", target: "src/" },
    ]);
    expect(result).toBe("src/baz.tsx");
  });

  it("returns null for unmatched alias prefix", () => {
    const result = resolveImport("~/foo", "src/main.ts", allFiles, [
      { prefix: "@/", target: "src/" },
    ]);
    expect(result).toBeNull();
  });

  it("returns null for npm packages even with aliases", () => {
    const result = resolveImport("react", "src/main.ts", allFiles, [
      { prefix: "@/", target: "src/" },
    ]);
    expect(result).toBeNull();
  });
});

describe("parseTsconfigPaths", () => {
  it("parses standard @/* alias", () => {
    const aliases = parseTsconfigPaths({ "@/*": ["./src/*"] });
    expect(aliases).toEqual([{ prefix: "@/", target: "src/" }]);
  });

  it("parses alias with baseUrl", () => {
    const aliases = parseTsconfigPaths({ "@/*": ["./components/*"] }, "src");
    expect(aliases).toEqual([{ prefix: "@/", target: "src/components/" }]);
  });

  it("parses multiple aliases", () => {
    const aliases = parseTsconfigPaths({
      "@/*": ["./src/*"],
      "~/*": ["./lib/*"],
    });
    expect(aliases).toHaveLength(2);
    expect(aliases[0]).toEqual({ prefix: "@/", target: "src/" });
    expect(aliases[1]).toEqual({ prefix: "~/", target: "lib/" });
  });

  it("ignores non-wildcard patterns", () => {
    const aliases = parseTsconfigPaths({ "@utils": ["./src/utils"] });
    expect(aliases).toHaveLength(0);
  });

  it("ignores empty targets", () => {
    const aliases = parseTsconfigPaths({ "@/*": [] });
    expect(aliases).toHaveLength(0);
  });
});
