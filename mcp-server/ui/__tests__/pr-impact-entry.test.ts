/**
 * pr-impact-entry.test.ts
 *
 * Verifies that pr-impact.html exists, contains the correct <script> tag
 * pointing to pr-impact.ts, and has the #app mount target.
 *
 * This is a simple file-existence and content test — no browser runtime needed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");

describe("pr-impact.html entry point", () => {
  const htmlPath = join(uiDir, "pr-impact.html");

  it("exists", () => {
    expect(existsSync(htmlPath)).toBe(true);
  });

  it("has correct <title>", () => {
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain("<title>Canon PR Impact</title>");
  });

  it("has a <script> tag pointing to ./pr-impact.ts", () => {
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain('src="./pr-impact.ts"');
  });

  it("has the #app mount target", () => {
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain('id="app"');
  });

  it("uses type=module for the script tag", () => {
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain('type="module"');
  });
});

describe("pr-impact.ts entry point", () => {
  const tsPath = join(uiDir, "pr-impact.ts");

  it("exists", () => {
    expect(existsSync(tsPath)).toBe(true);
  });

  it("imports PrImpact from ./PrImpact.svelte", () => {
    const content = readFileSync(tsPath, "utf-8");
    expect(content).toContain("PrImpact");
    expect(content).toContain("./PrImpact.svelte");
  });

  it("uses mount() from svelte", () => {
    const content = readFileSync(tsPath, "utf-8");
    expect(content).toContain('from "svelte"');
    expect(content).toContain("mount(");
  });
});

describe("PrImpact.svelte component", () => {
  const sveltePath = join(uiDir, "PrImpact.svelte");

  it("exists", () => {
    expect(existsSync(sveltePath)).toBe(true);
  });

  it("uses Svelte 5 $state rune", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("$state");
  });

  it("imports bridge from stores/bridge", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("bridge");
    expect(content).toContain("stores/bridge");
  });

  it("handles loading state", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("loading");
  });

  it("handles error state", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("error");
  });
});
