/**
 * Tests for kg-adapter-registry.ts
 *
 * Covers the two P2 bug fixes:
 *
 * Fix 1 (extension shadowing): registerOverlayAdapters must reject any overlay
 *   extension that collides with a built-in extension. The built-in adapter must
 *   remain untouched (fail-open: extension skipped, warn logged).
 *
 * Fix 2 (non-built-in extensions): overlay extensions that do NOT collide with
 *   built-ins are registered normally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter, getLanguage, registerOverlayAdapters } from "../kg-adapter-registry.ts";
import type { LanguageConfig } from "../kg-language-configs.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

/** A fake overlay config for a non-built-in language (Go) */
function makeGoConfig(extensions: string[]): LanguageConfig {
  return {
    extensions,
    grammarFile: "tree-sitter-go.wasm",
    id: "go",
    nodeKinds: VALID_NODE_KINDS,
  };
}

/** A fake overlay config that claims a built-in extension */
function makeRogueConfig(extensions: string[]): LanguageConfig {
  return {
    extensions,
    grammarFile: "tree-sitter-rogue.wasm",
    id: "rogue-lang",
    nodeKinds: VALID_NODE_KINDS,
  };
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {
    // suppress output in tests
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Fix 2: overlay with built-in extension is rejected ──────────────────────

describe("registerOverlayAdapters — extension collision with built-in", () => {
  it("does not replace the built-in adapter for .ts when overlay lists .ts", () => {
    const builtinTsAdapter = getAdapter(".ts");
    expect(builtinTsAdapter).toBeDefined();

    const rogueConfig = makeRogueConfig([".ts"]);
    registerOverlayAdapters([rogueConfig]);

    // Built-in adapter must be the exact same reference — it was NOT replaced
    expect(getAdapter(".ts")).toBe(builtinTsAdapter);
  });

  it("logs a warning when an overlay extension collides with a built-in", () => {
    const rogueConfig = makeRogueConfig([".ts"]);
    registerOverlayAdapters([rogueConfig]);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("rogue-lang"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(".ts"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("built-in wins"));
  });

  it("does not replace .py adapter when overlay lists .py", () => {
    const builtinPyAdapter = getAdapter(".py");
    expect(builtinPyAdapter).toBeDefined();

    registerOverlayAdapters([makeRogueConfig([".py"])]);

    expect(getAdapter(".py")).toBe(builtinPyAdapter);
  });

  it("does not replace .sh adapter when overlay lists .sh", () => {
    const builtinShAdapter = getAdapter(".sh");
    expect(builtinShAdapter).toBeDefined();

    registerOverlayAdapters([makeRogueConfig([".sh"])]);

    expect(getAdapter(".sh")).toBe(builtinShAdapter);
  });

  it("rejects only the colliding extension — non-colliding extension in same config is registered", () => {
    // .ts collides; .go does not
    const mixedConfig: LanguageConfig = {
      ...makeGoConfig([".go", ".ts"]),
      // Override id so we don't interfere with a real go overlay
      id: "go-mixed",
    };

    registerOverlayAdapters([mixedConfig]);

    // .ts must remain the built-in adapter
    const builtinTsAdapter = getAdapter(".ts");
    expect(builtinTsAdapter).toBeDefined();
    // The adapter for .go should now be registered (getParser will throw at
    // parse time since "go-mixed" parser isn't loaded, but registration itself
    // should succeed for the non-colliding extension)
    expect(getAdapter(".go")).toBeDefined();

    // getLanguage falls back to overlayLangMap for newly registered extensions
    expect(getLanguage(".go")).toBe("go-mixed");

    // Clean up: there's no public API to remove, but since the module is shared
    // we verify the built-in is unaffected and accept .go stays registered.
  });

  it("getLanguage still returns 'typescript' for .ts after a collision attempt", () => {
    registerOverlayAdapters([makeRogueConfig([".ts"])]);
    expect(getLanguage(".ts")).toBe("typescript");
  });
});

// ─── Non-colliding overlays register normally ─────────────────────────────────

describe("registerOverlayAdapters — non-colliding extension", () => {
  it("registers an adapter for a new extension (.rb) without warning", () => {
    const rubyConfig: LanguageConfig = {
      extensions: [".rb"],
      grammarFile: "tree-sitter-ruby.wasm",
      id: "ruby-test",
      nodeKinds: VALID_NODE_KINDS,
    };

    registerOverlayAdapters([rubyConfig]);

    expect(console.warn).not.toHaveBeenCalled();
    // Adapter is registered (getParser("ruby-test") would throw at parse time,
    // but the adapter object itself is registered)
    expect(getAdapter(".rb")).toBeDefined();
    expect(getLanguage(".rb")).toBe("ruby-test");
  });
});
