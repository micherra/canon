import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseOverlay,
  loadOverlay,
  loadAllOverlays,
  filterOverlaysForAgent,
  buildOverlayInjection,
} from "../orchestration/overlays.ts";
import { listOverlays } from "../tools/list-overlays.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PERF_OVERLAY = `---
name: perf-engineer
description: Performance engineering lens
applies_to: [canon-implementor, canon-reviewer]
priority: 700
---

## Performance Heuristics

- Profile before optimizing
- Prefer algorithmic improvements over micro-optimizations`;

const SECURITY_OVERLAY = `---
name: security-auditor
description: Security auditing lens
applies_to: [canon-reviewer, canon-security]
priority: 900
---

## Security Checks

- Validate all inputs
- Use parameterized queries`;

const MINIMAL_OVERLAY = `---
name: minimal
description: Minimal overlay
---

Just a body.`;

// ---------------------------------------------------------------------------
// parseOverlay
// ---------------------------------------------------------------------------

describe("parseOverlay", () => {
  it("parses frontmatter correctly and extracts body", () => {
    const result = parseOverlay(PERF_OVERLAY);
    expect(result.name).toBe("perf-engineer");
    expect(result.description).toBe("Performance engineering lens");
    expect(result.applies_to).toEqual(["canon-implementor", "canon-reviewer"]);
    expect(result.priority).toBe(700);
    expect(result.body).toContain("## Performance Heuristics");
    expect(result.body).toContain("Profile before optimizing");
  });

  it("handles missing optional fields with defaults", () => {
    const result = parseOverlay(MINIMAL_OVERLAY);
    expect(result.name).toBe("minimal");
    expect(result.description).toBe("Minimal overlay");
    expect(result.applies_to).toEqual([]);
    expect(result.priority).toBe(500);
    expect(result.body).toBe("Just a body.");
  });

  it("handles content with no frontmatter", () => {
    const result = parseOverlay("Just some text without frontmatter.");
    expect(result.name).toBe("");
    expect(result.description).toBe("");
    expect(result.applies_to).toEqual([]);
    expect(result.priority).toBe(500);
    expect(result.body).toBe("Just some text without frontmatter.");
  });
});

// ---------------------------------------------------------------------------
// loadOverlay
// ---------------------------------------------------------------------------

describe("loadOverlay", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-overlay-test-"));
    await mkdir(join(tmpDir, ".canon", "overlays"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads file from .canon/overlays/{name}.md", async () => {
    await writeFile(
      join(tmpDir, ".canon", "overlays", "perf-engineer.md"),
      PERF_OVERLAY,
    );

    const result = await loadOverlay(tmpDir, "perf-engineer");
    expect(result.name).toBe("perf-engineer");
    expect(result.priority).toBe(700);
    expect(result.body).toContain("Performance Heuristics");
  });

  it("throws when overlay file does not exist", async () => {
    await expect(loadOverlay(tmpDir, "nonexistent")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadAllOverlays
// ---------------------------------------------------------------------------

describe("loadAllOverlays", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-overlay-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when directory does not exist", async () => {
    const result = await loadAllOverlays(tmpDir);
    expect(result).toEqual([]);
  });

  it("loads multiple overlays", async () => {
    await mkdir(join(tmpDir, ".canon", "overlays"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "overlays", "perf-engineer.md"),
      PERF_OVERLAY,
    );
    await writeFile(
      join(tmpDir, ".canon", "overlays", "security-auditor.md"),
      SECURITY_OVERLAY,
    );

    const result = await loadAllOverlays(tmpDir);
    expect(result).toHaveLength(2);

    const names = result.map((o) => o.name).sort();
    expect(names).toEqual(["perf-engineer", "security-auditor"]);
  });

  it("ignores non-.md files", async () => {
    await mkdir(join(tmpDir, ".canon", "overlays"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "overlays", "perf-engineer.md"),
      PERF_OVERLAY,
    );
    await writeFile(
      join(tmpDir, ".canon", "overlays", "notes.txt"),
      "not an overlay",
    );

    const result = await loadAllOverlays(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("perf-engineer");
  });
});

// ---------------------------------------------------------------------------
// filterOverlaysForAgent
// ---------------------------------------------------------------------------

describe("filterOverlaysForAgent", () => {
  it("filters by agent name and sorts by priority descending", () => {
    const overlays = [
      parseOverlay(PERF_OVERLAY),     // priority 700, applies to implementor + reviewer
      parseOverlay(SECURITY_OVERLAY), // priority 900, applies to reviewer + security
    ];

    const forReviewer = filterOverlaysForAgent(overlays, "canon-reviewer");
    expect(forReviewer).toHaveLength(2);
    // Higher priority first
    expect(forReviewer[0].name).toBe("security-auditor");
    expect(forReviewer[1].name).toBe("perf-engineer");
  });

  it("returns empty array when no overlays match", () => {
    const overlays = [parseOverlay(PERF_OVERLAY)];
    const result = filterOverlaysForAgent(overlays, "canon-writer");
    expect(result).toEqual([]);
  });

  it("returns only matching overlays", () => {
    const overlays = [
      parseOverlay(PERF_OVERLAY),
      parseOverlay(SECURITY_OVERLAY),
    ];

    const forSecurity = filterOverlaysForAgent(overlays, "canon-security");
    expect(forSecurity).toHaveLength(1);
    expect(forSecurity[0].name).toBe("security-auditor");
  });

  it("includes overlays with empty applies_to as wildcards", () => {
    const overlays = [
      parseOverlay(PERF_OVERLAY),     // applies_to: [canon-implementor, canon-reviewer]
      parseOverlay(MINIMAL_OVERLAY),  // applies_to: [] (wildcard)
    ];

    const forWriter = filterOverlaysForAgent(overlays, "canon-writer");
    expect(forWriter).toHaveLength(1);
    expect(forWriter[0].name).toBe("minimal");
  });

  it("includes wildcard overlays alongside specific matches", () => {
    const overlays = [
      parseOverlay(PERF_OVERLAY),     // applies_to: [canon-implementor, canon-reviewer]
      parseOverlay(MINIMAL_OVERLAY),  // applies_to: [] (wildcard)
    ];

    const forReviewer = filterOverlaysForAgent(overlays, "canon-reviewer");
    expect(forReviewer).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildOverlayInjection
// ---------------------------------------------------------------------------

describe("buildOverlayInjection", () => {
  it("returns empty string for empty array", () => {
    expect(buildOverlayInjection([])).toBe("");
  });

  it("builds formatted injection text", () => {
    const overlays = [
      parseOverlay(PERF_OVERLAY),
      parseOverlay(SECURITY_OVERLAY),
    ];

    const result = buildOverlayInjection(overlays);
    expect(result).toContain("# Applied Role Overlays");
    expect(result).toContain("## Role Overlay: perf-engineer");
    expect(result).toContain("## Role Overlay: security-auditor");
    expect(result).toContain("Performance Heuristics");
    expect(result).toContain("Security Checks");
  });

  it("starts with two newlines for prompt concatenation", () => {
    const overlays = [parseOverlay(PERF_OVERLAY)];
    const result = buildOverlayInjection(overlays);
    expect(result.startsWith("\n\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listOverlays (tool)
// ---------------------------------------------------------------------------

describe("listOverlays", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-overlay-test-"));
    await mkdir(join(tmpDir, ".canon", "overlays"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "overlays", "perf-engineer.md"),
      PERF_OVERLAY,
    );
    await writeFile(
      join(tmpDir, ".canon", "overlays", "security-auditor.md"),
      SECURITY_OVERLAY,
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns all overlays when no agent filter is specified", async () => {
    const result = await listOverlays({}, tmpDir);
    expect(result.count).toBe(2);
    expect(result.overlays).toHaveLength(2);
    // Verify body is not included in the output
    for (const o of result.overlays) {
      expect(o).not.toHaveProperty("body");
    }
  });

  it("filters by agent when specified", async () => {
    const result = await listOverlays({ agent: "canon-implementor" }, tmpDir);
    expect(result.count).toBe(1);
    expect(result.overlays[0].name).toBe("perf-engineer");
  });

  it("returns empty list when agent matches no overlays", async () => {
    const result = await listOverlays({ agent: "canon-writer" }, tmpDir);
    expect(result.count).toBe(0);
    expect(result.overlays).toEqual([]);
  });
});
