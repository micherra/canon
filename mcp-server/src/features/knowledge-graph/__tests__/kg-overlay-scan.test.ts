/**
 * Overlay extension scan union tests (Finding A fix)
 *
 * When a project overlay registers a non-built-in extension (e.g. .rb),
 * the pipeline scan phase must include those files. We test this by calling
 * registerOverlayAdapters directly (bypassing initParsers), then verifying
 * that scanSourceFiles picks up .rb files when passed the union of built-in
 * extensions + overlay extensions via getOverlayExtensions().
 *
 * The pipeline integration is exercised indirectly: getOverlayExtensions()
 * returns the registered set, which buildIncludeExtensions (internal to
 * kg-pipeline.ts) merges into SCANNABLE_EXTENSIONS before scanning.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getOverlayExtensions, registerOverlayAdapters } from "@graph/kg-adapter-registry.ts";
import type { LanguageConfig } from "@graph/kg-language-configs.ts";
import { scanSourceFiles } from "@graph/scanner.ts";
import { SCANNABLE_EXTENSIONS } from "@shared/constants.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

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

/** A fake overlay LanguageConfig for Ruby (.rb) */
const rubyOverlayConfig: LanguageConfig = {
  extensions: [".rb"],
  grammarFile: "tree-sitter-ruby.wasm",
  id: "ruby-overlay-test",
  nodeKinds: VALID_NODE_KINDS,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("overlay extension scan union (Finding A)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), "kg-overlay-scan-"));
  });

  afterEach(() => {
    // Clear overlays so we don't pollute other tests
    registerOverlayAdapters([]);
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("getOverlayExtensions includes .rb after registerOverlayAdapters([ruby])", () => {
    registerOverlayAdapters([rubyOverlayConfig]);
    expect(getOverlayExtensions().has(".rb")).toBe(true);
  });

  test("scanSourceFiles with union of built-in + overlay extensions discovers .rb files", async () => {
    registerOverlayAdapters([rubyOverlayConfig]);

    const rbPath = path.join(projectDir, "src", "hello.rb");
    mkdirSync(path.dirname(rbPath), { recursive: true });
    writeFileSync(rbPath, "def hello; end\n", "utf8");

    // Build the same union that buildIncludeExtensions() computes in the pipeline
    const overlayExts = getOverlayExtensions();
    const union = new Set(SCANNABLE_EXTENSIONS);
    for (const ext of overlayExts) union.add(ext);

    const files = await scanSourceFiles(projectDir, { includeExtensions: [...union] });

    expect(files).toContain("src/hello.rb");
  });

  test("scanSourceFiles without overlay extensions does NOT discover .rb files", async () => {
    registerOverlayAdapters([]); // no overlays

    const rbPath = path.join(projectDir, "src", "hello.rb");
    mkdirSync(path.dirname(rbPath), { recursive: true });
    writeFileSync(rbPath, "def hello; end\n", "utf8");

    // Use built-in extensions only — .rb not included
    const files = await scanSourceFiles(projectDir, {
      includeExtensions: [...SCANNABLE_EXTENSIONS],
    });

    expect(files).not.toContain("src/hello.rb");
    expect(files.length).toBe(0);
  });
});
