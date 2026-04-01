/**
 * Integration tests for the tree-sitter WASM migration.
 *
 * Tests cross-task boundaries that implementors could not cover in unit tests:
 *
 *   1. Adapter registry → WASM parser → generic walker (full parse path for Java,
 *      Python, and TypeScript through getAdapter())
 *   2. getAdapter and getLanguage coverage for .java (declared Known Gap, wasm-04)
 *   3. Concurrent initParsers() calls (declared Known Gap, wasm-01)
 *   4. AdapterResult shape contract — entities, importSpecifiers, fileEdges all
 *      populated correctly by the WASM-backed adapter
 *
 * All tests use inline source strings — no filesystem access.
 * WASM grammars are loaded once via beforeAll(initParsers).
 */

import { beforeAll, describe, expect, test } from "vitest";
import { getAdapter, getLanguage } from "../graph/kg-adapter-registry.ts";
import { initParsers, isInitialized } from "../graph/kg-wasm-parser.ts";

// ---------------------------------------------------------------------------
// One-time WASM initialization for all suites in this file
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initParsers();
});

// ===========================================================================
// 1. getAdapter and getLanguage coverage for .java
//    Known Gap declared in wasm-04: "Java adapter parse behavior is not exercised
//    by the integration tests (no .java fixture files exist in the test suite)"
// ===========================================================================

describe("Adapter Registry — Java extension coverage", () => {
  test("getAdapter returns a LanguageAdapter for .java", () => {
    const adapter = getAdapter(".java");
    expect(adapter, 'getAdapter(".java") should return a defined adapter').toBeDefined();
    expect(typeof adapter!.parse).toBe("function");
  });

  test('getLanguage maps .java to "java"', () => {
    expect(getLanguage(".java")).toBe("java");
  });

  test("Java adapter is distinct from TypeScript and Python adapters", () => {
    const javaAdapter = getAdapter(".java");
    const tsAdapter = getAdapter(".ts");
    const pyAdapter = getAdapter(".py");
    expect(javaAdapter).not.toBe(tsAdapter);
    expect(javaAdapter).not.toBe(pyAdapter);
  });
});

// ===========================================================================
// 2. End-to-end Java parsing through adapter registry
//    Cross-task boundary: kg-adapter-registry → kg-wasm-parser → kg-generic-walker
// ===========================================================================

describe('End-to-end Java parsing via getAdapter(".java").parse()', () => {
  test("parses a Java class and extracts class entity", () => {
    const adapter = getAdapter(".java")!;
    const source = `
public class UserService {
  public void createUser(String name) { }
}`;
    const result = adapter.parse("src/UserService.java", source);

    expect(result).toBeDefined();
    expect(Array.isArray(result.entities)).toBe(true);
    const cls = result.entities.find((e) => e.name === "UserService");
    expect(cls, "expected UserService class entity").toBeDefined();
    expect(cls!.kind).toBe("class");
    expect(cls!.qualified_name).toBe("src/UserService.java::UserService");
  });

  test("parses a Java class and extracts method entities", () => {
    const adapter = getAdapter(".java")!;
    const source = `
public class Calculator {
  public int add(int a, int b) { return a + b; }
  public int subtract(int a, int b) { return a - b; }
}`;
    const result = adapter.parse("src/Calculator.java", source);

    const methods = result.entities.filter((e) => e.kind === "method");
    expect(methods.length).toBeGreaterThanOrEqual(2);
    expect(methods.some((m) => m.name === "add")).toBe(true);
    expect(methods.some((m) => m.name === "subtract")).toBe(true);
  });

  test("parses a Java import declaration and produces an importSpecifier", () => {
    const adapter = getAdapter(".java")!;
    const source = `
import java.util.List;
import java.util.Map;

public class Service {
  public void run() { }
}`;
    const result = adapter.parse("src/Service.java", source);

    expect(Array.isArray(result.importSpecifiers)).toBe(true);
    const specs = result.importSpecifiers;
    // Java import: specifier = package path (e.g. "java.util"), names = [class name] (e.g. ["List"])
    expect(specs.some((s) => s.specifier === "java.util" && s.names.includes("List"))).toBe(true);
    expect(specs.some((s) => s.specifier === "java.util" && s.names.includes("Map"))).toBe(true);
  });

  test("returns contains edges (intraFileEdges) from file to class entities", () => {
    const adapter = getAdapter(".java")!;
    const source = `public class Hello { public void sayHi() { } }`;
    const result = adapter.parse("Hello.java", source);

    // intraFileEdges is the AdapterResult field; contains edges are built by walkTree
    const containsEdges = result.intraFileEdges.filter((e) => e.edge_type === "contains");
    expect(containsEdges.length).toBeGreaterThan(0);
  });

  test("handles empty Java file without throwing", () => {
    const adapter = getAdapter(".java")!;
    expect(() => adapter.parse("Empty.java", "")).not.toThrow();
    const result = adapter.parse("Empty.java", "");
    expect(Array.isArray(result.entities)).toBe(true);
  });

  test("handles Java interface declaration as an extracted entity", () => {
    const adapter = getAdapter(".java")!;
    const source = `public interface Runnable { void run(); }`;
    const result = adapter.parse("src/Runnable.java", source);

    // Java interface_declaration is placed in classDef in the language config,
    // so it is extracted via extractClassEntity() and receives kind='class'.
    // This is the documented design: Java has no separate "interface" kind in the walker.
    const iface = result.entities.find((e) => e.name === "Runnable");
    expect(iface, "expected Runnable entity").toBeDefined();
    expect(iface!.qualified_name).toBe("src/Runnable.java::Runnable");
  });

  test("handles Java enum declaration as an extracted entity", () => {
    const adapter = getAdapter(".java")!;
    const source = `public enum Status { ACTIVE, INACTIVE }`;
    const result = adapter.parse("src/Status.java", source);

    // enum_declaration is in classDef config, so extracted via extractClassEntity().
    const enumEntity = result.entities.find((e) => e.name === "Status");
    expect(enumEntity, "expected Status entity").toBeDefined();
    expect(enumEntity!.qualified_name).toBe("src/Status.java::Status");
  });
});

// ===========================================================================
// 3. End-to-end Python parsing through adapter registry
//    Fills gap: section 10 only tests empty file for Python; no entity extraction
//    tested through registry
// ===========================================================================

describe('End-to-end Python parsing via getAdapter(".py").parse()', () => {
  test("parses a Python function and extracts function entity", () => {
    const adapter = getAdapter(".py")!;
    const source = `def compute(x, y):\n    return x + y\n`;
    const result = adapter.parse("src/math.py", source);

    expect(Array.isArray(result.entities)).toBe(true);
    const fn = result.entities.find((e) => e.name === "compute");
    expect(fn, "expected compute function entity").toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.qualified_name).toBe("src/math.py::compute");
  });

  test("parses a Python class and extracts class entity", () => {
    const adapter = getAdapter(".py")!;
    const source = `class UserModel:\n    def __init__(self):\n        pass\n`;
    const result = adapter.parse("src/models.py", source);

    const cls = result.entities.find((e) => e.name === "UserModel");
    expect(cls, "expected UserModel class entity").toBeDefined();
    expect(cls!.kind).toBe("class");
  });

  test("parses Python from-import and extracts importSpecifier", () => {
    const adapter = getAdapter(".py")!;
    const source = `from os.path import join, exists\n\ndef build_path():\n    return join('a', 'b')\n`;
    const result = adapter.parse("src/utils.py", source);

    const specs = result.importSpecifiers;
    expect(specs.length).toBeGreaterThan(0);
    // Python from-import: specifier = module path (e.g. "os.path"), names = imported names
    const fromSpec = specs.find((s) => s.specifier === "os.path");
    expect(fromSpec, 'expected import specifier with specifier="os.path"').toBeDefined();
    expect(fromSpec!.names).toContain("join");
    expect(fromSpec!.names).toContain("exists");
  });

  test("extracts ALL_CAPS Python constant as variable entity", () => {
    const adapter = getAdapter(".py")!;
    const source = `MAX_RETRIES = 5\ndefault_timeout = 30\n`;
    const result = adapter.parse("src/config.py", source);

    const constant = result.entities.find((e) => e.name === "MAX_RETRIES");
    expect(constant, "expected MAX_RETRIES constant entity").toBeDefined();
    expect(constant!.kind).toBe("variable");

    // Lowercase variable should not be extracted
    const lower = result.entities.find((e) => e.name === "default_timeout");
    expect(lower).toBeUndefined();
  });
});

// ===========================================================================
// 4. End-to-end TypeScript parsing through adapter registry
//    Verifies the adapter registry → WASM parser → walker cross-task boundary
//    for TypeScript (primary migration target)
// ===========================================================================

describe('End-to-end TypeScript parsing via getAdapter(".ts").parse()', () => {
  test("parses exported TypeScript function and extracts entity", () => {
    const adapter = getAdapter(".ts")!;
    const source = `export function greet(name: string): string { return \`Hello \${name}\`; }`;
    const result = adapter.parse("src/greet.ts", source);

    const fn = result.entities.find((e) => e.name === "greet");
    expect(fn, "expected greet function entity").toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.is_exported).toBe(true);
    expect(fn!.qualified_name).toBe("src/greet.ts::greet");
  });

  test("parses TypeScript class with methods and extracts all entities", () => {
    const adapter = getAdapter(".ts")!;
    const source = `
export class AuthService {
  login(user: string): boolean { return true; }
  logout(): void { }
}`;
    const result = adapter.parse("src/auth.ts", source);

    const cls = result.entities.find((e) => e.name === "AuthService");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
    expect(cls!.is_exported).toBe(true);

    const methods = result.entities.filter((e) => e.kind === "method");
    expect(methods.some((m) => m.name === "login")).toBe(true);
    expect(methods.some((m) => m.name === "logout")).toBe(true);
  });

  test("parses TypeScript import statement and extracts importSpecifiers", () => {
    const adapter = getAdapter(".ts")!;
    const source = `import { readFile, writeFile } from 'node:fs/promises';`;
    const result = adapter.parse("src/io.ts", source);

    const specs = result.importSpecifiers;
    expect(specs.length).toBeGreaterThan(0);
    // TypeScript import: specifier = module path, names = named imports
    const fsSpec = specs.find((s) => s.specifier === "node:fs/promises");
    expect(fsSpec, 'expected import specifier with specifier="node:fs/promises"').toBeDefined();
    expect(fsSpec!.names).toContain("readFile");
    expect(fsSpec!.names).toContain("writeFile");
  });

  test("parses TypeScript interface declaration", () => {
    const adapter = getAdapter(".ts")!;
    const source = `export interface Repository<T> { findById(id: string): T; }`;
    const result = adapter.parse("src/types.ts", source);

    const iface = result.entities.find((e) => e.name === "Repository");
    expect(iface, "expected Repository interface entity").toBeDefined();
    expect(iface!.kind).toBe("interface");
    expect(iface!.is_exported).toBe(true);
  });

  test("TSX adapter (.tsx extension) parses JSX content without throwing", () => {
    const adapter = getAdapter(".tsx")!;
    const source = `export function Button({ label }: { label: string }) { return <button>{label}</button>; }`;
    const result = adapter.parse("src/Button.tsx", source);

    const fn = result.entities.find((e) => e.name === "Button");
    expect(fn, "expected Button function entity").toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.is_exported).toBe(true);
  });
});

// ===========================================================================
// 5. Concurrent initParsers() calls
//    Known Gap declared in wasm-01: "No test for calling initParsers() from two
//    concurrent async contexts simultaneously"
// ===========================================================================

describe("initParsers() concurrent call safety", () => {
  test("concurrent initParsers() calls both resolve without error", async () => {
    // Both calls should succeed because the second call returns early via the
    // `if (initialized) return` guard once the first completes, or races safely.
    const [result1, result2] = await Promise.allSettled([initParsers(), initParsers()]);
    expect(result1.status).toBe("fulfilled");
    expect(result2.status).toBe("fulfilled");
    expect(isInitialized()).toBe(true);
  });

  test("initParsers() called many times concurrently all succeed", async () => {
    const calls = Array.from({ length: 10 }, () => initParsers());
    const results = await Promise.allSettled(calls);
    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }
    expect(isInitialized()).toBe(true);
  });
});

// ===========================================================================
// 6. AdapterResult shape contract — cross-task interface validation
//    Verifies that the AdapterResult produced by wasm-04 (registry/makeAdapter)
//    satisfies the shape expected by consumers (kg-pipeline, kg-store).
// ===========================================================================

describe("AdapterResult shape contract across task boundaries", () => {
  test("AdapterResult has required top-level fields for TypeScript", () => {
    const adapter = getAdapter(".ts")!;
    const result = adapter.parse("src/x.ts", "export const x = 1;");

    // AdapterResult contract: entities, intraFileEdges, importSpecifiers
    expect(result).toHaveProperty("entities");
    expect(result).toHaveProperty("importSpecifiers");
    expect(result).toHaveProperty("intraFileEdges");
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.importSpecifiers)).toBe(true);
    expect(Array.isArray(result.intraFileEdges)).toBe(true);
  });

  test("AdapterResult has required top-level fields for Python", () => {
    const adapter = getAdapter(".py")!;
    const result = adapter.parse("src/x.py", "x = 1");

    expect(result).toHaveProperty("entities");
    expect(result).toHaveProperty("importSpecifiers");
    expect(result).toHaveProperty("intraFileEdges");
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.intraFileEdges)).toBe(true);
  });

  test("AdapterResult has required top-level fields for Java", () => {
    const adapter = getAdapter(".java")!;
    const result = adapter.parse("X.java", "public class X { }");

    expect(result).toHaveProperty("entities");
    expect(result).toHaveProperty("importSpecifiers");
    expect(result).toHaveProperty("intraFileEdges");
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.intraFileEdges)).toBe(true);
  });

  test("entity records have required fields for pipeline consumption", () => {
    const adapter = getAdapter(".ts")!;
    const source = "export function pipeline(): void { }";
    const result = adapter.parse("src/pipeline.ts", source);

    const fn = result.entities.find((e) => e.name === "pipeline");
    expect(fn).toBeDefined();

    // Fields required by kg-store.insertEntity (KgStore contract)
    expect(typeof fn!.name).toBe("string");
    expect(typeof fn!.qualified_name).toBe("string");
    expect(typeof fn!.kind).toBe("string");
    expect(typeof fn!.line_start).toBe("number");
    expect(typeof fn!.line_end).toBe("number");
    expect(typeof fn!.is_exported).toBe("boolean");
    expect(typeof fn!.is_default_export).toBe("boolean");
  });
});
