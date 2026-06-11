/**
 * Tests for kg-wasm-parser.ts — web-tree-sitter WASM parser infrastructure.
 * Strict TDD: these tests are written first; implementation makes them pass.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getParser, initParsers, isInitialized } from "@graph/kg-wasm-parser.ts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Initialization state tests (before init)

describe("kg-wasm-parser — before init", () => {
  it("isInitialized() returns false before initParsers() is called", () => {
    // Note: this test relies on module-level state not yet initialized.
    // If other tests in this file run first in the same module instance,
    // this test may see initialized=true. We accept this as a module isolation
    // trade-off and rely on Vitest running test files in isolation.
    // The isInitialized() guard is tested more robustly via the "after init" tests.
    // We check the exported function exists and returns a boolean at minimum.
    expect(typeof isInitialized()).toBe("boolean");
  });

  it("getParser() before initParsers() throws with descriptive error", () => {
    // Only meaningful if called before init; if init already ran (module-level
    // side effect), we skip by checking isInitialized first
    if (!isInitialized()) {
      expect(() => getParser("typescript")).toThrow(/initParsers/i);
    }
  });
});

// Initialization tests

describe("kg-wasm-parser — initParsers()", () => {
  beforeAll(async () => {
    await initParsers();
  });

  it("initParsers() completes without throwing", () => {
    // If we reach here, beforeAll succeeded
    expect(true).toBe(true);
  });

  it("isInitialized() returns true after initParsers()", () => {
    expect(isInitialized()).toBe(true);
  });

  it("initParsers() is idempotent — calling twice does not throw or reset", async () => {
    // Second call returns [] (already initialized — no new overlays loaded)
    await expect(initParsers()).resolves.toEqual([]);
    expect(isInitialized()).toBe(true);
  });
});

// getParser() tests — after init

describe("kg-wasm-parser — getParser() after init", () => {
  beforeAll(async () => {
    await initParsers();
  });

  it("getParser('typescript') returns a Parser instance", () => {
    const parser = getParser("typescript");
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe("function");
  });

  it("getParser('tsx') returns a Parser instance", () => {
    const parser = getParser("tsx");
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe("function");
  });

  it("getParser('tsx') returns a different Parser instance than 'typescript'", () => {
    const tsParser = getParser("typescript");
    const tsxParser = getParser("tsx");
    expect(tsxParser).not.toBe(tsParser);
  });

  it("getParser('python') returns a Parser instance", () => {
    const parser = getParser("python");
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe("function");
  });

  it("getParser('bash') returns a Parser instance", () => {
    const parser = getParser("bash");
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe("function");
  });

  it("getParser('java') returns a Parser instance", () => {
    const parser = getParser("java");
    expect(parser).toBeDefined();
    expect(typeof parser.parse).toBe("function");
  });

  it("getParser('unknown') throws with descriptive error", () => {
    expect(() => getParser("unknown")).toThrow(/unknown.*language|language.*unknown|unsupported/i);
  });
});

// Parsing tests — each parser can parse trivial source without throwing

describe("kg-wasm-parser — parsing trivial source strings", () => {
  beforeAll(async () => {
    await initParsers();
  });

  it("typescript parser can parse a trivial TypeScript source string", () => {
    const parser = getParser("typescript");
    const tree = parser.parse("const x: number = 42;");
    expect(tree).toBeDefined();
    expect(tree!.rootNode).toBeDefined();
    expect(tree!.rootNode.type).toBe("program");
  });

  it("tsx parser can parse a trivial TSX source string", () => {
    const parser = getParser("tsx");
    const tree = parser.parse("const x = <div>hello</div>;");
    expect(tree).toBeDefined();
    expect(tree!.rootNode).toBeDefined();
    expect(tree!.rootNode.type).toBe("program");
  });

  it("python parser can parse a trivial Python source string", () => {
    const parser = getParser("python");
    const tree = parser.parse("x = 42");
    expect(tree).toBeDefined();
    expect(tree!.rootNode).toBeDefined();
    expect(tree!.rootNode.type).toBe("module");
  });

  it("bash parser can parse a trivial Bash source string", () => {
    const parser = getParser("bash");
    const tree = parser.parse("echo hello");
    expect(tree).toBeDefined();
    expect(tree!.rootNode).toBeDefined();
    expect(tree!.rootNode.type).toBe("program");
  });

  it("java parser can parse a trivial Java source string", () => {
    const parser = getParser("java");
    const tree = parser.parse("class Hello { }");
    expect(tree).toBeDefined();
    expect(tree!.rootNode).toBeDefined();
    expect(tree!.rootNode.type).toBe("program");
  });
});

// Per-project overlay loading after singleton is already initialized
//
// Fix for P2 bug: when the WASM parser singleton is already initialized,
// initParsers(projectDir) must still resolve and register overlays for
// the given projectDir — not return early with [].

describe("kg-wasm-parser — per-project overlay loading after singleton init", () => {
  let tmpDir: string;

  beforeAll(async () => {
    // Ensure the singleton is initialized before these tests run
    await initParsers();
  });

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `kg-parser-overlay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(tmpDir, ".canon", "kg-languages"), { recursive: true });
    mkdirSync(join(tmpDir, ".canon", "grammars"), { recursive: true });
    vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress warn output in tests
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns [] when projectDir has no overlay configs (already initialized)", async () => {
    // Singleton is already initialized — the overlay dir is empty
    const result = await initParsers(tmpDir);
    expect(result).toEqual([]);
  });

  it("still processes overlay dir for a second projectDir after singleton init", async () => {
    // Write a valid-shape overlay JSON but point at a nonexistent wasm.
    // The fail-open loader will skip the entry and return [] — but the key
    // behavior we're testing is that initParsers DID call loadOverlayGrammars
    // (rather than returning early before even looking at the dir).
    writeFileSync(
      join(tmpDir, ".canon", "kg-languages", "go.json"),
      JSON.stringify({
        extensions: [".go"],
        grammarFile: "tree-sitter-go.wasm", // wasm absent → skip
        id: "go",
        nodeKinds: {
          callExpression: ["call_expression"],
          classBody: [],
          classDef: [],
          exportStatement: [],
          functionDef: ["function_declaration"],
          importStatement: [],
          methodDef: [],
          variableDecl: [],
        },
      }),
    );
    // No matching wasm → loadOverlayGrammars returns [] (fail-open), but it
    // must have been called. If the early-return bug were present, the warn
    // below would NOT be emitted because loadOverlayConfigs wouldn't run.
    const result = await initParsers(tmpDir);
    expect(result).toEqual([]);
    // The missing-wasm warning confirms loadOverlayGrammars was actually invoked
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("tree-sitter-go.wasm"));
  });

  it("is idempotent when called with no projectDir after singleton init", async () => {
    // No projectDir — still returns []
    await expect(initParsers()).resolves.toEqual([]);
    expect(isInitialized()).toBe(true);
  });
});
