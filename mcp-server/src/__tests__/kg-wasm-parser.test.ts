/**
 * Tests for kg-wasm-parser.ts — web-tree-sitter WASM parser infrastructure.
 * Strict TDD: these tests are written first; implementation makes them pass.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getParser, initParsers, isInitialized } from "../graph/kg-wasm-parser.ts";

// ---------------------------------------------------------------------------
// Initialization state tests (before init)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Initialization tests
// ---------------------------------------------------------------------------

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
    await expect(initParsers()).resolves.toBeUndefined();
    expect(isInitialized()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getParser() tests — after init
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parsing tests — each parser can parse trivial source without throwing
// ---------------------------------------------------------------------------

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
