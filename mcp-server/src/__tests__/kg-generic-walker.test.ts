/**
 * Tests for kg-generic-walker.ts — config-driven AST tree-walker.
 *
 * Strict TDD: tests written first; implementation makes them pass.
 *
 * All tests parse inline source strings — no file system access.
 * Uses web-tree-sitter WASM parsers via initParsers() / getParser().
 */

import { beforeAll, describe, expect, it } from "vitest";
import { walkTree } from "../graph/kg-generic-walker.ts";
import { LANGUAGE_CONFIGS } from "../graph/kg-language-configs.ts";
import type { AdapterResult } from "../graph/kg-types.ts";
import { getParser, initParsers } from "../graph/kg-wasm-parser.ts";

beforeAll(async () => {
  await initParsers();
});

// Helper

function parseTs(source: string, filePath = "test.ts"): AdapterResult {
  const parser = getParser("typescript");
  const tree = parser.parse(source);
  const config = LANGUAGE_CONFIGS.get("typescript")!;
  return walkTree(tree, filePath, config);
}

function parsePy(source: string, filePath = "test.py"): AdapterResult {
  const parser = getParser("python");
  const tree = parser.parse(source);
  const config = LANGUAGE_CONFIGS.get("python")!;
  return walkTree(tree, filePath, config);
}

function parseBash(source: string, filePath = "test.sh"): AdapterResult {
  const parser = getParser("bash");
  const tree = parser.parse(source);
  const config = LANGUAGE_CONFIGS.get("bash")!;
  return walkTree(tree, filePath, config);
}

function parseJava(source: string, filePath = "Test.java"): AdapterResult {
  const parser = getParser("java");
  const tree = parser.parse(source);
  const config = LANGUAGE_CONFIGS.get("java")!;
  return walkTree(tree, filePath, config);
}

// TypeScript parity tests

describe("walkTree — TypeScript", () => {
  it("extracts exported function entity with correct fields", () => {
    const result = parseTs("export function add(a: number, b: number) { return a + b; }");
    expect(result.entities).toHaveLength(1);
    const fn = result.entities[0];
    expect(fn.name).toBe("add");
    expect(fn.qualified_name).toBe("test.ts::add");
    expect(fn.kind).toBe("function");
    expect(fn.line_start).toBe(1);
    expect(fn.line_end).toBe(1);
    expect(fn.is_exported).toBe(true);
    expect(fn.signature).toBeTruthy();
    expect(fn.signature).toContain("a");
  });

  it("extracts non-exported function entity", () => {
    const result = parseTs('function greet(name: string) { return "hi"; }');
    expect(result.entities).toHaveLength(1);
    const fn = result.entities[0];
    expect(fn.name).toBe("greet");
    expect(fn.is_exported).toBe(false);
    expect(fn.kind).toBe("function");
  });

  it("extracts class entity", () => {
    const result = parseTs("export class Dog { bark() {} }", "Dog.ts");
    const cls = result.entities.find((e) => e.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.name).toBe("Dog");
    expect(cls!.qualified_name).toBe("Dog.ts::Dog");
    expect(cls!.is_exported).toBe(true);
  });

  it("extracts method entities from class body", () => {
    const result = parseTs('class Animal { speak() { return "..."; } run() {} }');
    const methods = result.entities.filter((e) => e.kind === "method");
    expect(methods.length).toBeGreaterThanOrEqual(2);
    const speak = methods.find((m) => m.name === "speak");
    expect(speak).toBeDefined();
    expect(speak!.qualified_name).toBe("test.ts::Animal.speak");
    expect(speak!.kind).toBe("method");
  });

  it("produces contains edges from file to all entities", () => {
    const result = parseTs("export function foo() {} export function bar() {}");
    const containsEdges = result.intraFileEdges.filter((e) => e.edge_type === "contains");
    expect(containsEdges.length).toBeGreaterThanOrEqual(2);
    for (const edge of containsEdges) {
      expect(edge.source_qualified).toBe("test.ts");
    }
  });

  it("produces extends edge for class with superclass", () => {
    const result = parseTs("class Cat extends Animal {}");
    const extendsEdge = result.intraFileEdges.find((e) => e.edge_type === "extends");
    expect(extendsEdge).toBeDefined();
    expect(extendsEdge!.source_qualified).toBe("test.ts::Cat");
    expect(extendsEdge!.target_qualified).toContain("Animal");
  });

  it("produces implements edges for class implementing interface", () => {
    const result = parseTs("class Foo implements IFoo, IBar {}");
    const implEdges = result.intraFileEdges.filter((e) => e.edge_type === "implements");
    expect(implEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts arrow function as function entity", () => {
    const result = parseTs("const double = (x: number) => x * 2;");
    // Arrow functions assigned to const are treated as function entities
    const fn = result.entities.find((e) => e.name === "double");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("extracts exported arrow function", () => {
    const result = parseTs("export const greet = (name: string) => `Hello ${name}`;");
    const fn = result.entities.find((e) => e.name === "greet");
    expect(fn).toBeDefined();
    expect(fn!.is_exported).toBe(true);
  });

  it("extracts named import specifier", () => {
    const result = parseTs("import { foo, bar } from './utils';");
    expect(result.importSpecifiers).toHaveLength(1);
    const spec = result.importSpecifiers[0];
    expect(spec.specifier).toBe("./utils");
    expect(spec.names).toContain("foo");
    expect(spec.names).toContain("bar");
  });

  it("extracts default import specifier", () => {
    const result = parseTs("import React from 'react';");
    expect(result.importSpecifiers).toHaveLength(1);
    expect(result.importSpecifiers[0].names).toContain("React");
  });

  it("extracts namespace import specifier", () => {
    const result = parseTs("import * as fs from 'fs';");
    const spec = result.importSpecifiers[0];
    expect(spec.names[0]).toContain("* as");
    expect(spec.names[0]).toContain("fs");
  });

  it("extracts re-export specifier", () => {
    const result = parseTs("export { foo } from './bar';");
    expect(result.importSpecifiers).toHaveLength(1);
    const spec = result.importSpecifiers[0];
    expect(spec.specifier).toBe("./bar");
    expect(spec.names).toContain("foo");
  });

  it("extracts interface declaration as entity", () => {
    const result = parseTs("export interface IService { run(): void; }");
    const iface = result.entities.find((e) => e.kind === "interface");
    expect(iface).toBeDefined();
    expect(iface!.name).toBe("IService");
    expect(iface!.is_exported).toBe(true);
  });

  it("extracts type alias declaration as entity", () => {
    const result = parseTs("export type Handler = (req: Request) => Response;");
    const alias = result.entities.find((e) => e.kind === "type-alias");
    expect(alias).toBeDefined();
    expect(alias!.name).toBe("Handler");
  });

  it("extracts enum declaration as entity", () => {
    const result = parseTs("export enum Color { Red, Green, Blue }");
    const en = result.entities.find((e) => e.kind === "enum");
    expect(en).toBeDefined();
    expect(en!.name).toBe("Color");
  });

  it("extracts calls edge from function body", () => {
    const result = parseTs("function helper() {} function main() { helper(); }");
    const callEdge = result.intraFileEdges.find(
      (e) => e.edge_type === "calls" && e.source_qualified.endsWith("::main"),
    );
    expect(callEdge).toBeDefined();
    expect(callEdge!.target_qualified).toContain("helper");
  });

  it("handles empty source gracefully", () => {
    const result = parseTs("");
    expect(result.entities).toEqual([]);
    expect(result.intraFileEdges).toEqual([]);
    expect(result.importSpecifiers).toEqual([]);
  });

  it("handles whitespace-only source gracefully", () => {
    const result = parseTs("   \n\n   ");
    expect(result.entities).toEqual([]);
  });
});

// Python parity tests

describe("walkTree — Python", () => {
  it("extracts top-level function definition", () => {
    const result = parsePy('def greet(name):\n    return "hi"');
    const fn = result.entities.find((e) => e.kind === "function");
    expect(fn).toBeDefined();
    expect(fn!.name).toBe("greet");
    expect(fn!.qualified_name).toBe("test.py::greet");
    expect(fn!.kind).toBe("function");
    expect(fn!.is_exported).toBe(true); // top-level Python is exported
  });

  it("extracts class entity", () => {
    const result = parsePy("class Animal:\n    pass");
    const cls = result.entities.find((e) => e.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.name).toBe("Animal");
    expect(cls!.qualified_name).toBe("test.py::Animal");
  });

  it("extracts methods from class body", () => {
    const src = "class Dog:\n    def bark(self):\n        pass\n    def run(self):\n        pass";
    const result = parsePy(src);
    const methods = result.entities.filter((e) => e.kind === "method");
    expect(methods.length).toBeGreaterThanOrEqual(2);
    const bark = methods.find((m) => m.name === "bark");
    expect(bark).toBeDefined();
    expect(bark!.qualified_name).toBe("test.py::Dog.bark");
  });

  it("produces contains edges for Python entities", () => {
    const result = parsePy("def foo():\n    pass\ndef bar():\n    pass");
    const containsEdges = result.intraFileEdges.filter((e) => e.edge_type === "contains");
    expect(containsEdges.length).toBeGreaterThanOrEqual(2);
  });

  it("produces extends edge for class with base class", () => {
    const result = parsePy("class Cat(Animal):\n    pass");
    const ext = result.intraFileEdges.find((e) => e.edge_type === "extends");
    expect(ext).toBeDefined();
    expect(ext!.source_qualified).toContain("Cat");
  });

  it("extracts from-import specifier", () => {
    const result = parsePy("from os.path import join, exists");
    expect(result.importSpecifiers).toHaveLength(1);
    const spec = result.importSpecifiers[0];
    expect(spec.specifier).toBe("os.path");
    expect(spec.names).toContain("join");
    expect(spec.names).toContain("exists");
  });

  it("extracts plain import specifier", () => {
    const result = parsePy("import os");
    expect(result.importSpecifiers).toHaveLength(1);
    const spec = result.importSpecifiers[0];
    expect(spec.specifier).toBe("os");
    expect(spec.names).toContain("os");
  });

  it("extracts ALL_CAPS constant as variable entity", () => {
    const result = parsePy("MAX_SIZE = 100");
    const v = result.entities.find((e) => e.kind === "variable");
    expect(v).toBeDefined();
    expect(v!.name).toBe("MAX_SIZE");
    expect(v!.is_exported).toBe(true);
  });

  it("ignores lowercase variable assignments (not constants)", () => {
    const result = parsePy("foo = 42");
    const vars = result.entities.filter((e) => e.kind === "variable");
    expect(vars).toHaveLength(0);
  });

  it("detects @staticmethod decorator on method", () => {
    const src = "class MyClass:\n    @staticmethod\n    def static_method():\n        pass";
    const result = parsePy(src);
    const method = result.entities.find((e) => e.name === "static_method");
    expect(method).toBeDefined();
    if (method?.metadata) {
      const meta = JSON.parse(method.metadata);
      expect(meta.static).toBe(true);
    }
  });

  it("extracts call edges from function body", () => {
    const src = "def helper():\n    pass\n\ndef main():\n    helper()";
    const result = parsePy(src);
    const callEdges = result.intraFileEdges.filter((e) => e.edge_type === "calls");
    expect(callEdges.length).toBeGreaterThanOrEqual(1);
    const edge = callEdges.find((e) => e.source_qualified.endsWith("::main"));
    expect(edge).toBeDefined();
    expect(edge!.target_qualified).toContain("helper");
  });

  it("handles empty source gracefully", () => {
    const result = parsePy("");
    expect(result.entities).toEqual([]);
    expect(result.intraFileEdges).toEqual([]);
    expect(result.importSpecifiers).toEqual([]);
  });
});

// Bash parity tests

describe("walkTree — Bash", () => {
  it("extracts function definition", () => {
    const result = parseBash('greet() {\n  echo "hello"\n}');
    const fn = result.entities.find((e) => e.kind === "function");
    expect(fn).toBeDefined();
    expect(fn!.name).toBe("greet");
    expect(fn!.qualified_name).toBe("test.sh::greet");
    expect(fn!.is_exported).toBe(true);
  });

  it("extracts function with function keyword", () => {
    const result = parseBash('function deploy {\n  echo "deploying"\n}');
    const fn = result.entities.find((e) => e.name === "deploy");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });

  it("extracts source command as import specifier", () => {
    const result = parseBash("source ./lib.sh");
    expect(result.importSpecifiers).toHaveLength(1);
    const spec = result.importSpecifiers[0];
    expect(spec.specifier).toBe("./lib.sh");
    expect(spec.names).toContain("*");
  });

  it("extracts . (dot) source command as import specifier", () => {
    const result = parseBash(". ./helpers.sh");
    expect(result.importSpecifiers).toHaveLength(1);
    expect(result.importSpecifiers[0].specifier).toBe("./helpers.sh");
  });

  it("produces calls edge when one defined function calls another", () => {
    const src = "greet() {\n  echo hi\n}\nmain() {\n  greet\n}";
    const result = parseBash(src);
    const callEdges = result.intraFileEdges.filter((e) => e.edge_type === "calls");
    expect(callEdges.length).toBeGreaterThanOrEqual(1);
    const edge = callEdges.find(
      (e) => e.source_qualified.endsWith("::main") && e.target_qualified.endsWith("::greet"),
    );
    expect(edge).toBeDefined();
  });

  it("produces contains edges for functions", () => {
    const result = parseBash("foo() {\n  echo foo\n}\nbar() {\n  echo bar\n}");
    const containsEdges = result.intraFileEdges.filter((e) => e.edge_type === "contains");
    expect(containsEdges.length).toBeGreaterThanOrEqual(2);
  });

  it("handles empty source gracefully", () => {
    const result = parseBash("");
    expect(result.entities).toEqual([]);
    expect(result.intraFileEdges).toEqual([]);
    expect(result.importSpecifiers).toEqual([]);
  });
});

// Java parity tests

describe("walkTree — Java", () => {
  it("extracts class with methods — class entity, method entities, contains edges", () => {
    const src = [
      "public class Calculator {",
      "    public int add(int a, int b) { return a + b; }",
      "    private int multiply(int a, int b) { return a * b; }",
      "}",
    ].join("\n");
    const result = parseJava(src);

    const cls = result.entities.find((e) => e.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.name).toBe("Calculator");
    expect(cls!.is_exported).toBe(true); // public modifier

    const methods = result.entities.filter((e) => e.kind === "method");
    expect(methods.length).toBeGreaterThanOrEqual(2);

    const add = methods.find((m) => m.name === "add");
    expect(add).toBeDefined();
    expect(add!.qualified_name).toBe("Test.java::Calculator.add");

    const containsEdges = result.intraFileEdges.filter((e) => e.edge_type === "contains");
    expect(containsEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts Java import declaration — ImportSpecifier", () => {
    const result = parseJava("import java.util.List;");
    expect(result.importSpecifiers).toHaveLength(1);
    const spec = result.importSpecifiers[0];
    expect(spec.specifier).toBe("java.util");
    expect(spec.names).toContain("List");
  });

  it("extracts Java wildcard import", () => {
    const result = parseJava("import java.util.*;");
    expect(result.importSpecifiers).toHaveLength(1);
    const spec = result.importSpecifiers[0];
    expect(spec.specifier).toBe("java.util");
    expect(spec.names).toContain("*");
  });

  it("extracts interface declaration as entity", () => {
    const src = "public interface Runnable { void run(); }";
    const result = parseJava(src);
    const iface = result.entities.find((e) => e.kind === "class" && e.name === "Runnable");
    // Java interface_declaration is treated as class kind by the config
    expect(iface).toBeDefined();
  });

  it("extracts enum declaration as entity", () => {
    const src = "public enum Status { ACTIVE, INACTIVE }";
    const result = parseJava(src);
    // enum_declaration in classDef is treated as a class
    const en = result.entities.find((e) => e.name === "Status");
    expect(en).toBeDefined();
  });

  it("extracts method calls as calls edges", () => {
    const src = [
      "public class Service {",
      "    public void doWork() { this.helper(); }",
      "    private void helper() {}",
      "}",
    ].join("\n");
    const result = parseJava(src);
    const callEdges = result.intraFileEdges.filter((e) => e.edge_type === "calls");
    expect(callEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("handles empty source gracefully", () => {
    const result = parseJava("");
    expect(result.entities).toEqual([]);
    expect(result.intraFileEdges).toEqual([]);
    expect(result.importSpecifiers).toEqual([]);
  });
});
