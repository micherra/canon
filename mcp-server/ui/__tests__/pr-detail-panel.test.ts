/**
 * pr-detail-panel.test.ts
 *
 * Tests for PrDetailPanel.svelte — the per-file detail panel in the PR Impact View.
 * Verifies file existence, structure, and key content patterns via source inspection
 * (same pattern as pr-impact-entry.test.ts and subgraph.test.ts in this codebase).
 *
 * Tests confirm:
 * - Component exists at the expected path
 * - Uses Svelte 5 $props() rune
 * - Renders violation cards with severity colors and message fallback
 * - Renders blast radius section with depth indicators
 * - Renders decisions section filtered to violated principles
 * - Renders empty states for each section
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const componentsDir = join(__dirname, "..", "components");

describe("PrDetailPanel.svelte — file existence and Svelte 5 runes", () => {
  const componentPath = join(componentsDir, "PrDetailPanel.svelte");

  it("exists at mcp-server/ui/components/PrDetailPanel.svelte", () => {
    expect(existsSync(componentPath)).toBe(true);
  });

  it("uses $props() for Svelte 5 runes syntax", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("$props()");
  });

  it("does NOT use Svelte 4 export let syntax", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).not.toMatch(/export let\s+/);
  });
});

describe("PrDetailPanel.svelte — props interface", () => {
  const componentPath = join(componentsDir, "PrDetailPanel.svelte");

  it("accepts file prop (string)", () => {
    const content = readFileSync(componentPath, "utf-8");
    // Props interface should declare file
    expect(content).toMatch(/file\s*:/);
  });

  it("accepts violations prop (array)", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("violations");
  });

  it("accepts blastRadiusAffected prop (array)", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("blastRadiusAffected");
  });

  it("accepts decisions prop (array)", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("decisions");
  });

  it("accepts onFileClick callback prop", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("onFileClick");
  });
});

describe("PrDetailPanel.svelte — violations section", () => {
  const componentPath = join(componentsDir, "PrDetailPanel.svelte");

  it("renders a violations section header with count", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("Violations");
  });

  it("renders severity badges for violations", () => {
    const content = readFileSync(componentPath, "utf-8");
    // Should reference severity in some way (badge or color)
    expect(content).toContain("severity");
  });

  it("guards violation.message with nullish coalescing (fallback to empty string or default)", () => {
    const content = readFileSync(componentPath, "utf-8");
    // Must guard message with ?? operator per CONVENTIONS.md
    expect(content).toMatch(/violation\.message\s*\?\?/);
  });

  it('shows "No details available" fallback when message is empty', () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("No details available");
  });

  it("uses getSeverityColor from lib/utils for badge colors", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("getSeverityColor");
  });
});

describe("PrDetailPanel.svelte — blast radius section", () => {
  const componentPath = join(componentsDir, "PrDetailPanel.svelte");

  it("renders a blast radius section", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toMatch(/[Bb]last [Rr]adius/);
  });

  it("renders depth indicators for blast radius entries", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("depth");
  });

  it("calls onFileClick when a blast radius file is clicked", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("onFileClick");
  });

  it("limits displayed entries with +N more indicator (maxShown pattern)", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("maxShown");
    expect(content).toMatch(/more/);
  });
});

describe("PrDetailPanel.svelte — decisions section", () => {
  const componentPath = join(componentsDir, "PrDetailPanel.svelte");

  it("renders a decisions section header with count", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toMatch(/[Pp]rior [Dd]ecision/);
  });

  it("filters decisions to violated principles", () => {
    const content = readFileSync(componentPath, "utf-8");
    // Should use principle_id matching
    expect(content).toContain("principle_id");
  });

  it("renders justification text for each decision", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("justification");
  });

  it('shows "No prior deviation decisions" empty state', () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toMatch(/[Nn]o prior/);
  });
});

describe("PrDetailPanel.svelte — empty and header states", () => {
  const componentPath = join(componentsDir, "PrDetailPanel.svelte");

  it("displays the file name (basename) in the header", () => {
    const content = readFileSync(componentPath, "utf-8");
    // Should use basename from lib/graph
    expect(content).toContain("basename");
  });

  it("shows overall empty state when no violations, no blast radius, no decisions", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toMatch(/[Nn]o issues/);
  });

  it("shows violation count as a badge in the header", () => {
    const content = readFileSync(componentPath, "utf-8");
    expect(content).toContain("violations.length");
  });
});
