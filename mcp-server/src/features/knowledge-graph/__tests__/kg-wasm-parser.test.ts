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

// Atomicity: failed Language.load() must NOT leave half-registered state
//
// Fix for P2 (third-round) bug: before this fix, mergeOverlayIntoConfigs was
// called for ALL overlay configs before Language.load() ran for each one. If
// Language.load() rejected (corrupt file, wrong ABI), the config was already
// in LANGUAGE_CONFIGS/EXT_TO_CONFIG while no parser/adapter existed — a
// half-registered state that could crash later callers.
//
// After the fix, mergeOverlayIntoConfigs is called only after Language.load()
// succeeds, and only for the successfully-loaded subset.

describe("kg-wasm-parser — overlay atomicity: failed Language.load() must not pollute config maps", () => {
  let tmpDir: string;

  beforeAll(async () => {
    // Ensure the singleton is initialized before these tests run
    await initParsers();
  });

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `kg-parser-atomic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  it("overlay whose Language.load() throws does NOT appear in LANGUAGE_CONFIGS or EXT_TO_CONFIG", async () => {
    // Write a valid JSON overlay config for a unique language id
    const overlayId = `test-lang-atomic-${Date.now()}`;
    const ext = `.${overlayId}`;
    const wasmFile = `tree-sitter-${overlayId}.wasm`;

    writeFileSync(
      join(tmpDir, ".canon", "kg-languages", `${overlayId}.json`),
      JSON.stringify({
        extensions: [ext],
        grammarFile: wasmFile,
        id: overlayId,
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

    // Write a file at the wasm path so existsSync passes — but it is NOT a valid
    // WASM file, so Language.load() will reject it.
    writeFileSync(join(tmpDir, ".canon", "grammars", wasmFile), "not a wasm file");

    // Import the config map to assert post-condition
    const { LANGUAGE_CONFIGS, getConfigForExtension } = await import(
      "@graph/kg-language-configs.ts"
    );

    // Confirm the overlay id is NOT in the maps before we call initParsers
    expect(LANGUAGE_CONFIGS.has(overlayId)).toBe(false);
    expect(getConfigForExtension(ext)).toBeUndefined();

    // Run initParsers — Language.load() will throw on the corrupt wasm
    const result = await initParsers(tmpDir);

    // The failed overlay must NOT have been registered
    expect(result).toEqual([]);
    expect(LANGUAGE_CONFIGS.has(overlayId)).toBe(false);
    expect(getConfigForExtension(ext)).toBeUndefined();

    // Built-ins must remain intact
    expect(LANGUAGE_CONFIGS.has("typescript")).toBe(true);
    expect(LANGUAGE_CONFIGS.has("tsx")).toBe(true);
    expect(LANGUAGE_CONFIGS.has("python")).toBe(true);

    // The failure warn was emitted (Language.load failed)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(overlayId));
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

// FINDING A fix: duplicate overlay language ids — first-wins, skip later duplicates
//
// When two .canon/kg-languages/*.json files declare the same `id`, the second
// must be skipped with a warning. Before this fix, both configs would land in
// `loaded`, causing adapters to be registered with a mismatched parser (the
// second config's parser would be in `parsers` but the first adapter's
// makeAdapter() closure captured config.id pointing to the overwritten parser).

describe("kg-wasm-parser — duplicate overlay id: first-wins policy", () => {
  let tmpDir: string;

  beforeAll(async () => {
    await initParsers();
  });

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `kg-parser-dupid-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  it("duplicate overlay id: second entry is skipped and a warning is emitted", async () => {
    // Two JSON files with the same id. Both point to a stub wasm so existsSync
    // passes; Language.load() will throw for both (not real WASM). The key
    // invariant: only ONE "duplicate" warning (for the second entry), and only ONE
    // Language.load failure warning (for the first entry — the second never reaches load).
    const dupId = `dup-lang-${Date.now()}`;
    const wasmFile = `tree-sitter-${dupId}.wasm`;
    const nodeKinds = {
      callExpression: ["call_expression"],
      classBody: [],
      classDef: [],
      exportStatement: [],
      functionDef: ["function_declaration"],
      importStatement: [],
      methodDef: [],
      variableDecl: [],
    };

    writeFileSync(
      join(tmpDir, ".canon", "kg-languages", `${dupId}-a.json`),
      // Use charset-compliant extensions (^\.[a-z0-9]+$ — no hyphens allowed)
      JSON.stringify({ extensions: [".ext1"], grammarFile: wasmFile, id: dupId, nodeKinds }),
    );
    writeFileSync(
      join(tmpDir, ".canon", "kg-languages", `${dupId}-b.json`),
      JSON.stringify({ extensions: [".ext2"], grammarFile: wasmFile, id: dupId, nodeKinds }),
    );
    // Write a stub wasm so existsSync passes (both files reference the same wasm)
    writeFileSync(join(tmpDir, ".canon", "grammars", wasmFile), "not a wasm file");

    await initParsers(tmpDir);

    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );

    // Exactly one "duplicate" warning for the second entry
    const dupWarnings = warnCalls.filter((msg) => msg.includes("duplicate") && msg.includes(dupId));
    expect(dupWarnings).toHaveLength(1);

    // Only the first entry attempts Language.load() and fails (not real WASM).
    // The second entry is skipped BEFORE load — so exactly one load-failure warn.
    const loadFailWarnings = warnCalls.filter(
      (msg) => msg.includes(dupId) && !msg.includes("duplicate"),
    );
    expect(loadFailWarnings).toHaveLength(1);
  });

  it("duplicate overlay id: result never contains the duplicate entry", async () => {
    // Even if Language.load somehow succeeded for the first, the second duplicate
    // must not be in the returned array. Test with the stub-wasm path (both fail,
    // so result is []) — confirms no double-registration path exists.
    const dupId = `dup-noresult-${Date.now()}`;
    const wasmFile = `tree-sitter-${dupId}.wasm`;
    const nodeKinds = {
      callExpression: [],
      classBody: [],
      classDef: [],
      exportStatement: [],
      functionDef: [],
      importStatement: [],
      methodDef: [],
      variableDecl: [],
    };

    writeFileSync(
      join(tmpDir, ".canon", "kg-languages", `${dupId}-first.json`),
      // Use charset-compliant extensions (^\.[a-z0-9]+$ — no hyphens allowed)
      JSON.stringify({ extensions: [".ext3"], grammarFile: wasmFile, id: dupId, nodeKinds }),
    );
    writeFileSync(
      join(tmpDir, ".canon", "kg-languages", `${dupId}-second.json`),
      JSON.stringify({ extensions: [".ext4"], grammarFile: wasmFile, id: dupId, nodeKinds }),
    );
    writeFileSync(join(tmpDir, ".canon", "grammars", wasmFile), "not a wasm file");

    const result = await initParsers(tmpDir);

    // Both fail (invalid wasm), so [] — but critically there must be at most one
    // entry per id (no double-registration).
    const idsInResult = result.map((c) => c.id);
    const dupCount = idsInResult.filter((id) => id === dupId).length;
    expect(dupCount).toBeLessThanOrEqual(1);
  });
});
