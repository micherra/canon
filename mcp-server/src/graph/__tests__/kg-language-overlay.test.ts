/**
 * Tests for the KG project-local language overlay mechanism.
 *
 * Covers the six cases specified in lsp-recommender-kg-PLAN.md:
 * 1. Valid overlay entry → returned; extension resolves via getConfigForExtension
 * 2. Missing paired wasm → entry SKIPPED (fail-open), returns [], no throw
 * 3. Malformed JSON / missing nodeKinds role → SKIPPED, no throw
 * 4. Built-in id collision (overlay claims id 'typescript') → built-in wins
 * 5. KG integrity: broken overlay doesn't break built-in language resolution
 * 6. Empty / absent overlay dir → []
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// For KG-integrity tests we also test mergeOverlayIntoConfigs / getConfigForExtension
import {
  getConfigForExtension,
  LANGUAGE_CONFIGS,
  mergeOverlayIntoConfigs,
} from "../kg-language-configs.ts";
// We test loadOverlayConfigs in isolation — no WASM loading needed.
import { loadOverlayConfigs } from "../kg-language-overlay.ts";

// ─── Test fixture helpers ─────────────────────────────────────────────────

/** Minimal valid NodeKindMap for a test overlay language */
const VALID_NODE_KINDS = {
  callExpression: ["call_expression"],
  classBody: [],
  classDef: [],
  exportStatement: [],
  functionDef: ["function_declaration"],
  importStatement: [],
  methodDef: [],
  variableDecl: [],
};

/** Create a temporary project directory with .canon subdirs */
function makeTmpProject(): string {
  const dir = join(
    tmpdir(),
    `kg-overlay-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, ".canon", "kg-languages"), { recursive: true });
  mkdirSync(join(dir, ".canon", "grammars"), { recursive: true });
  return dir;
}

function writeOverlayJson(dir: string, filename: string, data: unknown): void {
  writeFileSync(join(dir, ".canon", "kg-languages", filename), JSON.stringify(data));
}

function touchGrammarFile(dir: string, name: string): void {
  writeFileSync(join(dir, ".canon", "grammars", name), "stub wasm bytes");
}

/** Set of all built-in language ids */
const BUILTIN_IDS = new Set(LANGUAGE_CONFIGS.keys());

// ─── Shared test state ────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTmpProject();
  vi.spyOn(console, "warn").mockImplementation(() => {
    // suppress overlay warning output in tests
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── Case 1: Valid overlay entry ──────────────────────────────────────────

describe("case 1: valid overlay entry", () => {
  it("returns the config when json + wasm both valid", () => {
    const entry = {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: VALID_NODE_KINDS,
    };
    writeOverlayJson(tmpDir, "go.json", entry);
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("go");
    expect(result[0].extensions).toEqual([".go"]);
    expect(result[0].grammarFile).toBe("tree-sitter-go.wasm");
    expect(result[0].nodeKinds.functionDef).toEqual(["function_declaration"]);
  });

  it("merging a valid overlay makes getConfigForExtension resolve the extension", () => {
    const entry = {
      extensions: [".rb"],
      grammarFile: "tree-sitter-ruby.wasm",
      id: "ruby",
      nodeKinds: VALID_NODE_KINDS,
    };
    writeOverlayJson(tmpDir, "ruby.json", entry);
    touchGrammarFile(tmpDir, "tree-sitter-ruby.wasm");

    const configs = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    // Merge into the shared config map (this is what initParsers does)
    mergeOverlayIntoConfigs(configs);

    expect(getConfigForExtension(".rb")).toBeDefined();
    expect(getConfigForExtension(".rb")?.id).toBe("ruby");

    // Clean up: remove from LANGUAGE_CONFIGS so we don't pollute other tests
    LANGUAGE_CONFIGS.delete("ruby");
  });
});

// ─── Case 2: Missing paired wasm → SKIPPED ───────────────────────────────

describe("case 2: missing paired wasm", () => {
  it("returns [] when wasm file does not exist", () => {
    writeOverlayJson(tmpDir, "go.json", {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: VALID_NODE_KINDS,
    });
    // No grammar file written

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);

    expect(result).toHaveLength(0);
  });

  it("logs a warning for the skipped entry", () => {
    writeOverlayJson(tmpDir, "go.json", {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: VALID_NODE_KINDS,
    });

    loadOverlayConfigs(tmpDir, BUILTIN_IDS);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("tree-sitter-go.wasm"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("skipping"));
  });

  it("does not throw", () => {
    writeOverlayJson(tmpDir, "go.json", {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: VALID_NODE_KINDS,
    });

    expect(() => loadOverlayConfigs(tmpDir, BUILTIN_IDS)).not.toThrow();
  });
});

// ─── Case 3: Malformed JSON / missing nodeKinds role → SKIPPED ───────────

describe("case 3: malformed config", () => {
  it("skips a file with invalid JSON", () => {
    writeFileSync(join(tmpDir, ".canon", "kg-languages", "bad.json"), "{ not valid json");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("failed to parse"));
  });

  it("skips an entry missing a required nodeKinds role", () => {
    const nodeKindsMissingClassDef = { ...VALID_NODE_KINDS };
    // @ts-expect-error -- intentionally malformed for test
    delete nodeKindsMissingClassDef.classDef;

    writeOverlayJson(tmpDir, "go.json", {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: nodeKindsMissingClassDef,
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("classDef"));
  });

  it("skips an entry where nodeKinds role has non-string values", () => {
    writeOverlayJson(tmpDir, "go.json", {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: { ...VALID_NODE_KINDS, functionDef: [42, true] },
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
  });

  it("skips an entry with missing id", () => {
    writeOverlayJson(tmpDir, "bad.json", {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      nodeKinds: VALID_NODE_KINDS,
      // id is missing
    });

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
  });

  it("does not throw for any of these malformed inputs", () => {
    writeFileSync(join(tmpDir, ".canon", "kg-languages", "bad.json"), "not json at all");
    expect(() => loadOverlayConfigs(tmpDir, BUILTIN_IDS)).not.toThrow();
  });
});

// ─── Case 4: Built-in id collision → built-in wins ───────────────────────

describe("case 4: built-in id collision", () => {
  it("drops an overlay entry that claims a built-in id", () => {
    // 'typescript' is a built-in — overlay must be rejected
    writeOverlayJson(tmpDir, "ts-overlay.json", {
      extensions: [".tscustom"],
      grammarFile: "tree-sitter-typescript.wasm",
      id: "typescript", // collision!
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-typescript.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("collides with a built-in"));
  });

  it("the built-in typescript config is unaffected after collision attempt", () => {
    writeOverlayJson(tmpDir, "ts-overlay.json", {
      extensions: [".tscustom"],
      grammarFile: "tree-sitter-typescript.wasm",
      id: "typescript",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-typescript.wasm");

    loadOverlayConfigs(tmpDir, BUILTIN_IDS);

    // Built-in TypeScript config still resolves correctly
    const tsConfig = getConfigForExtension(".ts");
    expect(tsConfig).toBeDefined();
    expect(tsConfig?.id).toBe("typescript");
    expect(tsConfig?.grammarFile).toBe("tree-sitter-typescript.wasm");
    // The built-in has real hooks — confirm they weren't replaced
    expect(tsConfig?.hooks?.extractImport).toBeTypeOf("function");
  });
});

// ─── Case 5: KG integrity — broken overlay doesn't break built-in ────────

describe("case 5: KG integrity", () => {
  it("built-in typescript extension still resolves with a broken overlay present", () => {
    // Write a completely broken overlay file
    writeFileSync(
      join(tmpDir, ".canon", "kg-languages", "broken.json"),
      "{ this is totally invalid json !!",
    );
    // Also write a valid-shape overlay with missing wasm
    writeOverlayJson(tmpDir, "nogram.json", {
      extensions: [".nolang"],
      grammarFile: "nonexistent.wasm",
      id: "nolang",
      nodeKinds: VALID_NODE_KINDS,
    });

    // Despite broken overlays, loadOverlayConfigs must not throw
    let result: ReturnType<typeof loadOverlayConfigs>;
    expect(() => {
      result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    }).not.toThrow();

    // No overlay configs returned
    expect(result!).toHaveLength(0);

    // Built-in language configs are still accessible
    expect(getConfigForExtension(".ts")).toBeDefined();
    expect(getConfigForExtension(".ts")?.id).toBe("typescript");
    expect(getConfigForExtension(".py")).toBeDefined();
    expect(getConfigForExtension(".py")?.id).toBe("python");

    // LANGUAGE_CONFIGS still has all 5 built-ins
    expect(LANGUAGE_CONFIGS.has("typescript")).toBe(true);
    expect(LANGUAGE_CONFIGS.has("tsx")).toBe(true);
    expect(LANGUAGE_CONFIGS.has("python")).toBe(true);
    expect(LANGUAGE_CONFIGS.has("bash")).toBe(true);
    expect(LANGUAGE_CONFIGS.has("java")).toBe(true);
  });

  it("mergeOverlayIntoConfigs with empty array leaves built-ins unchanged", () => {
    const tsBefore = getConfigForExtension(".ts");
    mergeOverlayIntoConfigs([]);
    const tsAfter = getConfigForExtension(".ts");

    expect(tsAfter).toBe(tsBefore); // same reference
    expect(tsAfter?.id).toBe("typescript");
  });
});

// ─── Case 7: Charset constraint — id field ────────────────────────────────

describe("case 7: charset constraint on id (^[a-z0-9_-]+$)", () => {
  it("rejects id containing injection-shaped characters (semicolon)", () => {
    writeOverlayJson(tmpDir, "bad-id.json", {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go; rm -rf /",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("skipping"));
  });

  it("rejects id containing uppercase characters", () => {
    writeOverlayJson(tmpDir, "bad-id-upper.json", {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "Go",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
  });

  it("rejects id containing spaces", () => {
    writeOverlayJson(tmpDir, "bad-id-space.json", {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "my lang",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
  });

  it("accepts a valid lowercase id matching ^[a-z0-9_-]+$", () => {
    writeOverlayJson(tmpDir, "valid-id.json", {
      extensions: [".go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("go");
  });

  it("accepts id with hyphens and underscores", () => {
    writeOverlayJson(tmpDir, "valid-id-hyph.json", {
      extensions: [".my"],
      grammarFile: "tree-sitter-my-lang.wasm",
      id: "my-lang_2",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-my-lang.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("my-lang_2");
  });
});

// ─── Case 8: Charset constraint — extensions field ────────────────────────

describe("case 8: charset constraint on extensions (^\\.[a-z0-9]+$)", () => {
  it("rejects an extension containing injection-shaped characters (semicolon)", () => {
    writeOverlayJson(tmpDir, "bad-ext.json", {
      extensions: [".go; system()"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("skipping"));
  });

  it("rejects an extension without a leading dot", () => {
    writeOverlayJson(tmpDir, "bad-ext-nodot.json", {
      extensions: ["go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
  });

  it("rejects an extension containing uppercase characters", () => {
    writeOverlayJson(tmpDir, "bad-ext-upper.json", {
      extensions: [".Go"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
  });

  it("accepts valid extensions matching ^\\.[a-z0-9]+$", () => {
    writeOverlayJson(tmpDir, "valid-ext.json", {
      extensions: [".go", ".gox"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(1);
    expect(result[0].extensions).toEqual([".go", ".gox"]);
  });

  it("rejects the entire entry when any one extension fails charset check (fail-closed)", () => {
    writeOverlayJson(tmpDir, "mixed-ext.json", {
      extensions: [".go", ".GO"],
      grammarFile: "tree-sitter-go.wasm",
      id: "go",
      nodeKinds: VALID_NODE_KINDS,
    });
    touchGrammarFile(tmpDir, "tree-sitter-go.wasm");

    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toHaveLength(0);
  });
});

// ─── Case 6: Empty / absent overlay dir → [] ─────────────────────────────

describe("case 6: empty or absent overlay dir", () => {
  it("returns [] for an empty kg-languages directory", () => {
    // tmpDir has the kg-languages dir created but empty
    const result = loadOverlayConfigs(tmpDir, BUILTIN_IDS);
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });

  it("returns [] when .canon/kg-languages directory does not exist", () => {
    // Create a project dir WITHOUT the kg-languages subdir
    const bareDir = join(tmpdir(), `bare-project-${Date.now()}`);
    mkdirSync(bareDir, { recursive: true });

    try {
      const result = loadOverlayConfigs(bareDir, BUILTIN_IDS);
      expect(result).toEqual([]);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("does not throw for absent directory", () => {
    const bareDir = join(tmpdir(), `bare-project-${Date.now()}`);
    mkdirSync(bareDir, { recursive: true });

    try {
      expect(() => loadOverlayConfigs(bareDir, BUILTIN_IDS)).not.toThrow();
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});
