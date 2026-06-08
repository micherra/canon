import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLoopsFromDir } from "../load-loops.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
// Resolve the loops/ directory relative to the worktree root (5 levels up from __tests__):
// __tests__ → (1) feature-loops → (2) features → (3) src → (4) mcp-server → (5) worktree
const WORKTREE_LOOPS_DIR = resolve(thisDir, "../../../../..", "loops");

/** Minimal valid _probe-shaped loop frontmatter as YAML. */
const VALID_PROBE_MD = `---
id: _probe
title: Loop Framework Probe
status: active
trigger:
  fired_by: orchestrator
  lifecycle_hook: post-ship
  firing_posture:
    autonomous: disabled
    light-touch: disabled
    supervised: opt-in
mode: interval
schedule:
  interval: 1m
  max_ticks: 3
state:
  scope: workspace
  path: \${WORKSPACE}/_probe-state.json
  snapshot:
    - tick_count
observe:
  tools: []
  mcp: []
surface:
  on_transition:
    - field: tick_count
      to: "3"
      message: Probe tick reached.
      terminate: true
terminate:
  when:
    - max_ticks_reached
guardrails:
  mutates_build: false
  forbidden_tools: []
---

This is the probe loop body — the re-fired action prompt.
`;

/** Malformed loop — missing required guardrails field. */
const INVALID_MD = `---
id: broken
title: Broken Loop
mode: interval
schedule:
  interval: 5m
  max_ticks: 10
state:
  scope: workspace
  path: \${WORKSPACE}/broken-state.json
  snapshot:
    - counter
surface:
  on_transition:
    - field: counter
      message: tick
terminate:
  when:
    - max_ticks_reached
---

Missing guardrails field — should land in invalid[].
`;

describe("loadLoopsFromDir", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-loops-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns { valid: [], invalid: [] } for ENOENT directory", async () => {
    const result = await loadLoopsFromDir(join(tmpDir, "nonexistent"));
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it("loads a valid loop into valid[] and returns empty invalid[]", async () => {
    await writeFile(join(tmpDir, "_probe.md"), VALID_PROBE_MD);
    const result = await loadLoopsFromDir(tmpDir);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].id).toBe("_probe");
    expect(result.invalid).toHaveLength(0);
  });

  it("places malformed loop in invalid[] with filename, not silently dropped", async () => {
    await writeFile(join(tmpDir, "broken.md"), INVALID_MD);
    const result = await loadLoopsFromDir(tmpDir);
    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].file).toContain("broken.md");
    expect(result.invalid[0].error).toBeTruthy();
  });

  it("separates valid and invalid correctly when both are present", async () => {
    await writeFile(join(tmpDir, "_probe.md"), VALID_PROBE_MD);
    await writeFile(join(tmpDir, "broken.md"), INVALID_MD);
    const result = await loadLoopsFromDir(tmpDir);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].id).toBe("_probe");
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].file).toContain("broken.md");
  });

  it("ignores non-.md files in the directory", async () => {
    await writeFile(join(tmpDir, "notes.txt"), "not a loop");
    await writeFile(join(tmpDir, "_probe.md"), VALID_PROBE_MD);
    const result = await loadLoopsFromDir(tmpDir);
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(0);
  });

  it("returns the parsed LoopDefinition body (action prompt) alongside the definition", async () => {
    await writeFile(join(tmpDir, "_probe.md"), VALID_PROBE_MD);
    const result = await loadLoopsFromDir(tmpDir);
    expect(result.valid).toHaveLength(1);
    expect(result.validBodies?.["_probe"]).toContain("re-fired action prompt");
  });
});

// Smoke test: parse the real _probe.md from the worktree's loops/ directory (dc-04 support)
describe("loadLoopsFromDir — real loops/ directory (_probe smoke test)", () => {
  it("parses the real loops/_probe.md file successfully", async () => {
    const result = await loadLoopsFromDir(WORKTREE_LOOPS_DIR);
    expect(result.invalid).toHaveLength(0);
    const probe = result.valid.find((d) => d.id === "_probe");
    expect(probe).toBeDefined();
    if (probe) {
      expect(probe.mode).toBe("interval");
      expect(probe.guardrails.mutates_build).toBe(false);
      expect(probe.status).toBe("active");
    }
  });
});
