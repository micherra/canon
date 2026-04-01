/**
 * Tests for kg-language-configs.ts
 *
 * These tests verify the structural correctness of each language config —
 * that the exported configs have the right shape, expected node kinds are
 * non-empty where applicable, and getConfigForExtension resolves correctly.
 *
 * Full extraction validation happens in wasm-03 integration tests.
 */

import { describe, expect, test } from "vitest";
import {
  getConfigForExtension,
  LANGUAGE_CONFIGS,
  type LanguageConfig,
  type NodeKindMap,
} from "../graph/kg-language-configs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasRequiredNodeKindKeys(map: NodeKindMap): boolean {
  const required: (keyof NodeKindMap)[] = [
    "functionDef",
    "classDef",
    "methodDef",
    "importStatement",
    "callExpression",
    "variableDecl",
    "exportStatement",
    "classBody",
  ];
  return required.every((k) => Array.isArray(map[k]));
}

// ---------------------------------------------------------------------------
// LANGUAGE_CONFIGS map
// ---------------------------------------------------------------------------

describe("LANGUAGE_CONFIGS", () => {
  test("contains typescript config", () => {
    expect(LANGUAGE_CONFIGS.has("typescript")).toBe(true);
  });

  test("contains tsx config", () => {
    expect(LANGUAGE_CONFIGS.has("tsx")).toBe(true);
  });

  test("contains python config", () => {
    expect(LANGUAGE_CONFIGS.has("python")).toBe(true);
  });

  test("contains bash config", () => {
    expect(LANGUAGE_CONFIGS.has("bash")).toBe(true);
  });

  test("contains java config", () => {
    expect(LANGUAGE_CONFIGS.has("java")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getConfigForExtension
// ---------------------------------------------------------------------------

describe("getConfigForExtension", () => {
  test(".ts returns typescript config", () => {
    const cfg = getConfigForExtension(".ts");
    expect(cfg).toBeDefined();
    expect(cfg!.id).toBe("typescript");
  });

  test(".tsx returns tsx config", () => {
    const cfg = getConfigForExtension(".tsx");
    expect(cfg).toBeDefined();
    expect(cfg!.id).toBe("tsx");
  });

  test(".js returns tsx config (TSX grammar is superset)", () => {
    const cfg = getConfigForExtension(".js");
    expect(cfg).toBeDefined();
    expect(cfg!.id).toBe("tsx");
  });

  test(".jsx returns tsx config", () => {
    const cfg = getConfigForExtension(".jsx");
    expect(cfg!.id).toBe("tsx");
  });

  test(".mjs returns tsx config", () => {
    const cfg = getConfigForExtension(".mjs");
    expect(cfg!.id).toBe("tsx");
  });

  test(".cjs returns tsx config", () => {
    const cfg = getConfigForExtension(".cjs");
    expect(cfg!.id).toBe("tsx");
  });

  test(".py returns python config", () => {
    const cfg = getConfigForExtension(".py");
    expect(cfg).toBeDefined();
    expect(cfg!.id).toBe("python");
  });

  test(".sh returns bash config", () => {
    const cfg = getConfigForExtension(".sh");
    expect(cfg).toBeDefined();
    expect(cfg!.id).toBe("bash");
  });

  test(".java returns java config", () => {
    const cfg = getConfigForExtension(".java");
    expect(cfg).toBeDefined();
    expect(cfg!.id).toBe("java");
  });

  test("unknown extension returns undefined", () => {
    expect(getConfigForExtension(".rb")).toBeUndefined();
    expect(getConfigForExtension(".go")).toBeUndefined();
    expect(getConfigForExtension("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TypeScript config shape
// ---------------------------------------------------------------------------

describe("typescript config", () => {
  let cfg: LanguageConfig;

  test("setup", () => {
    cfg = getConfigForExtension(".ts")!;
    expect(cfg).toBeDefined();
  });

  test("has all required node kind keys", () => {
    cfg = getConfigForExtension(".ts")!;
    expect(hasRequiredNodeKindKeys(cfg.nodeKinds)).toBe(true);
  });

  test("grammar file is tree-sitter-typescript.wasm", () => {
    cfg = getConfigForExtension(".ts")!;
    expect(cfg.grammarFile).toBe("tree-sitter-typescript.wasm");
  });

  test("functionDef includes function_declaration", () => {
    cfg = getConfigForExtension(".ts")!;
    expect(cfg.nodeKinds.functionDef).toContain("function_declaration");
  });

  test("classDef includes class_declaration", () => {
    cfg = getConfigForExtension(".ts")!;
    expect(cfg.nodeKinds.classDef).toContain("class_declaration");
  });

  test("exportStatement is non-empty", () => {
    cfg = getConfigForExtension(".ts")!;
    expect(cfg.nodeKinds.exportStatement.length).toBeGreaterThan(0);
  });

  test("has extractImport hook", () => {
    cfg = getConfigForExtension(".ts")!;
    expect(typeof cfg.hooks?.extractImport).toBe("function");
  });

  test("has isExported hook", () => {
    cfg = getConfigForExtension(".ts")!;
    expect(typeof cfg.hooks?.isExported).toBe("function");
  });

  test("has extractSpecial hook", () => {
    cfg = getConfigForExtension(".ts")!;
    expect(typeof cfg.hooks?.extractSpecial).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// TSX config shape
// ---------------------------------------------------------------------------

describe("tsx config", () => {
  test("grammar file is tree-sitter-tsx.wasm", () => {
    const cfg = getConfigForExtension(".tsx")!;
    expect(cfg.grammarFile).toBe("tree-sitter-tsx.wasm");
  });

  test("has same nodeKinds keys as typescript", () => {
    const ts = getConfigForExtension(".ts")!;
    const tsx = getConfigForExtension(".tsx")!;
    expect(Object.keys(tsx.nodeKinds).sort()).toEqual(Object.keys(ts.nodeKinds).sort());
  });

  test("nodeKinds values match typescript", () => {
    const ts = getConfigForExtension(".ts")!;
    const tsx = getConfigForExtension(".tsx")!;
    expect(tsx.nodeKinds).toEqual(ts.nodeKinds);
  });
});

// ---------------------------------------------------------------------------
// Python config shape
// ---------------------------------------------------------------------------

describe("python config", () => {
  let cfg: LanguageConfig;

  test("setup", () => {
    cfg = getConfigForExtension(".py")!;
    expect(cfg).toBeDefined();
  });

  test("has all required node kind keys", () => {
    cfg = getConfigForExtension(".py")!;
    expect(hasRequiredNodeKindKeys(cfg.nodeKinds)).toBe(true);
  });

  test("grammar file is tree-sitter-python.wasm", () => {
    cfg = getConfigForExtension(".py")!;
    expect(cfg.grammarFile).toBe("tree-sitter-python.wasm");
  });

  test("functionDef is function_definition", () => {
    cfg = getConfigForExtension(".py")!;
    expect(cfg.nodeKinds.functionDef).toContain("function_definition");
  });

  test("classDef is class_definition", () => {
    cfg = getConfigForExtension(".py")!;
    expect(cfg.nodeKinds.classDef).toContain("class_definition");
  });

  test("exportStatement is empty (Python has no exports)", () => {
    cfg = getConfigForExtension(".py")!;
    expect(cfg.nodeKinds.exportStatement).toEqual([]);
  });

  test("importStatement includes import_from_statement", () => {
    cfg = getConfigForExtension(".py")!;
    expect(cfg.nodeKinds.importStatement).toContain("import_from_statement");
  });

  test("has extractImport hook", () => {
    cfg = getConfigForExtension(".py")!;
    expect(typeof cfg.hooks?.extractImport).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Bash config shape
// ---------------------------------------------------------------------------

describe("bash config", () => {
  let cfg: LanguageConfig;

  test("setup", () => {
    cfg = getConfigForExtension(".sh")!;
    expect(cfg).toBeDefined();
  });

  test("has all required node kind keys", () => {
    cfg = getConfigForExtension(".sh")!;
    expect(hasRequiredNodeKindKeys(cfg.nodeKinds)).toBe(true);
  });

  test("grammar file is tree-sitter-bash.wasm", () => {
    cfg = getConfigForExtension(".sh")!;
    expect(cfg.grammarFile).toBe("tree-sitter-bash.wasm");
  });

  test("classDef is empty (Bash has no classes)", () => {
    cfg = getConfigForExtension(".sh")!;
    expect(cfg.nodeKinds.classDef).toEqual([]);
  });

  test("callExpression is command", () => {
    cfg = getConfigForExtension(".sh")!;
    expect(cfg.nodeKinds.callExpression).toContain("command");
  });

  test("has extractImport hook for source commands", () => {
    cfg = getConfigForExtension(".sh")!;
    expect(typeof cfg.hooks?.extractImport).toBe("function");
  });

  test("has extractSpecial hook", () => {
    cfg = getConfigForExtension(".sh")!;
    expect(typeof cfg.hooks?.extractSpecial).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Java config shape
// ---------------------------------------------------------------------------

describe("java config", () => {
  let cfg: LanguageConfig;

  test("setup", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg).toBeDefined();
  });

  test("id is java", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.id).toBe("java");
  });

  test("has all required node kind keys", () => {
    cfg = getConfigForExtension(".java")!;
    expect(hasRequiredNodeKindKeys(cfg.nodeKinds)).toBe(true);
  });

  test("grammar file is tree-sitter-java.wasm", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.grammarFile).toBe("tree-sitter-java.wasm");
  });

  test("extensions includes .java", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.extensions).toContain(".java");
  });

  test("functionDef is empty (Java has no top-level functions)", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.nodeKinds.functionDef).toEqual([]);
  });

  test("classDef includes class_declaration and interface_declaration", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.nodeKinds.classDef).toContain("class_declaration");
    expect(cfg.nodeKinds.classDef).toContain("interface_declaration");
    expect(cfg.nodeKinds.classDef).toContain("enum_declaration");
  });

  test("methodDef includes method_declaration and constructor_declaration", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.nodeKinds.methodDef).toContain("method_declaration");
    expect(cfg.nodeKinds.methodDef).toContain("constructor_declaration");
  });

  test("importStatement includes import_declaration", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.nodeKinds.importStatement).toContain("import_declaration");
  });

  test("callExpression includes method_invocation", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.nodeKinds.callExpression).toContain("method_invocation");
  });

  test("variableDecl includes field_declaration and local_variable_declaration", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.nodeKinds.variableDecl).toContain("field_declaration");
    expect(cfg.nodeKinds.variableDecl).toContain("local_variable_declaration");
  });

  test("exportStatement is empty (Java uses access modifiers)", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.nodeKinds.exportStatement).toEqual([]);
  });

  test("classBody includes class_body, interface_body, enum_body", () => {
    cfg = getConfigForExtension(".java")!;
    expect(cfg.nodeKinds.classBody).toContain("class_body");
    expect(cfg.nodeKinds.classBody).toContain("interface_body");
    expect(cfg.nodeKinds.classBody).toContain("enum_body");
  });

  test("has extractImport hook", () => {
    cfg = getConfigForExtension(".java")!;
    expect(typeof cfg.hooks?.extractImport).toBe("function");
  });

  test("has isExported hook", () => {
    cfg = getConfigForExtension(".java")!;
    expect(typeof cfg.hooks?.isExported).toBe("function");
  });

  test("has extractSpecial hook", () => {
    cfg = getConfigForExtension(".java")!;
    expect(typeof cfg.hooks?.extractSpecial).toBe("function");
  });

  test("has getEntityName hook", () => {
    cfg = getConfigForExtension(".java")!;
    expect(typeof cfg.hooks?.getEntityName).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// All configs have required shape
// ---------------------------------------------------------------------------

describe("all configs structural invariants", () => {
  test("every config has id, extensions, grammarFile, nodeKinds", () => {
    for (const [id, cfg] of LANGUAGE_CONFIGS) {
      expect(cfg.id).toBe(id);
      expect(Array.isArray(cfg.extensions)).toBe(true);
      expect(cfg.extensions.length).toBeGreaterThan(0);
      expect(typeof cfg.grammarFile).toBe("string");
      expect(cfg.grammarFile.endsWith(".wasm")).toBe(true);
      expect(hasRequiredNodeKindKeys(cfg.nodeKinds)).toBe(true);
    }
  });

  test("getConfigForExtension covers all declared extensions", () => {
    for (const cfg of LANGUAGE_CONFIGS.values()) {
      for (const ext of cfg.extensions) {
        const found = getConfigForExtension(ext);
        expect(found).toBeDefined();
      }
    }
  });
});
