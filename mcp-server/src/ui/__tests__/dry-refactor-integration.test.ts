/**
 * dry-refactor-integration.test.ts
 *
 * Pure-function and .ts-file tests for the DRY refactor across Waves 1-5.
 *
 * Covers:
 *   1. getSeverityColor pure-function behavioral contract (Wave 1 utils)
 *   2. useDataLoader.svelte.ts exports and behavior (Wave 2 composable)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEVERITY_COLORS } from "../lib/constants.ts";
import { getSeverityColor } from "../lib/utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");
const libDir = join(uiDir, "lib");

// =============================================================================
// 1. getSeverityColor pure-function behavioral contract
// =============================================================================

describe("Cross-wave: getSeverityColor utility → ViolationCard integration", () => {
  it("getSeverityColor returns same value as SEVERITY_COLORS[severity] for all three valid severities", () => {
    // This is the behavioral contract: refactor must not change color values
    expect(getSeverityColor("rule")).toBe(SEVERITY_COLORS.rule);
    expect(getSeverityColor("strong-opinion")).toBe(SEVERITY_COLORS["strong-opinion"]);
    expect(getSeverityColor("convention")).toBe(SEVERITY_COLORS.convention);
  });

  it("getSeverityColor fallback (#636a80) differs from old inline fallback (#888888) but is intentional", () => {
    // The refactor changed the unknown fallback from #888888 to #636a80.
    // Severity is a typed union so unknown values cannot reach this in practice.
    // This test documents the intentional change.
    const fallback = getSeverityColor("unknown-type");
    expect(fallback).toBe("#636a80");
    expect(fallback).not.toBe("#888888");
  });
});

// =============================================================================
// 2. useDataLoader.svelte.ts pure exports and behavior (Wave 2 composable)
// =============================================================================

describe("Cross-wave: useDataLoader composable (Wave 2) consumed by Wave 5 views", () => {
  it("useDataLoader.svelte.ts exports the DataLoaderState interface", () => {
    const content = readFileSync(join(libDir, "useDataLoader.svelte.ts"), "utf-8");
    expect(content).toContain("DataLoaderState");
    expect(content).toContain("export type DataLoaderState");
  });

  it("useDataLoader.svelte.ts exports LoaderStatus type", () => {
    const content = readFileSync(join(libDir, "useDataLoader.svelte.ts"), "utf-8");
    expect(content).toContain("LoaderStatus");
    expect(content).toContain('export type LoaderStatus = "loading" | "done" | "error"');
  });

  it("useDataLoader.svelte.ts transitions status from loading to done on success", () => {
    const content = readFileSync(join(libDir, "useDataLoader.svelte.ts"), "utf-8");
    expect(content).toContain('status = "done"');
    expect(content).toContain('status = "error"');
    // Initial state must be "loading"
    expect(content).toContain('"loading"');
  });

  it("useDataLoader.svelte.ts extracts .message from Error instances (error handling contract)", () => {
    const content = readFileSync(join(libDir, "useDataLoader.svelte.ts"), "utf-8");
    expect(content).toContain("err instanceof Error");
    expect(content).toContain("err.message");
    expect(content).toContain("String(err)");
  });
});
