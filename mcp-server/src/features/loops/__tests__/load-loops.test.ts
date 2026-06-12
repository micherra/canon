import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(result.validBodies?._probe).toContain("re-fired action prompt");
  });

  it("returns empty valid[]/invalid[] and does not throw when readdir fails with a non-ENOENT error", async () => {
    // Point the loader at a *file* path — readdir on a file throws ENOTDIR (not ENOENT),
    // exercising the fail-open warn-and-return branch without mocking.
    const filePath = join(tmpDir, "not-a-directory.md");
    await writeFile(filePath, "some content");
    const result = await loadLoopsFromDir(filePath);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([]);
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

// Smoke test: parse the real ship-watch.md from the worktree's loops/ directory (dc-01 support)
describe("loadLoopsFromDir — real loops/ directory (ship-watch smoke test)", () => {
  it("parses the real loops/ship-watch.md file and lands in valid[]", async () => {
    const result = await loadLoopsFromDir(WORKTREE_LOOPS_DIR);
    const shipWatch = result.valid.find((d) => d.id === "ship-watch");
    expect(shipWatch).toBeDefined();
    if (shipWatch) {
      expect(shipWatch.mode).toBe("interval");
      expect(shipWatch.guardrails.mutates_build).toBe(false);
      expect(shipWatch.status).toBe("active");
      // Verify tier-gated posture
      expect(shipWatch.trigger?.firing_posture.autonomous).toBe("auto");
      expect(shipWatch.trigger?.firing_posture["light-touch"]).toBe("auto");
      expect(shipWatch.trigger?.firing_posture.supervised).toBe("opt-in");
      // Verify all 4 snapshot fields
      expect(shipWatch.state.snapshot).toContain("pr_state");
      expect(shipWatch.state.snapshot).toContain("ci_conclusion");
      expect(shipWatch.state.snapshot).toContain("release_tag");
      expect(shipWatch.state.snapshot).toContain("external_review_comment_ids");
      // Verify Bash read-only carve-out: shell_commands declared
      expect(shipWatch.observe.shell_commands.length).toBeGreaterThan(0);
    }
  });

  it("ship-watch does not appear in invalid[]", async () => {
    const result = await loadLoopsFromDir(WORKTREE_LOOPS_DIR);
    const invalidShipWatch = result.invalid.find((e) => e.file.includes("ship-watch"));
    expect(invalidShipWatch).toBeUndefined();
  });
});

// ── Phase C: _probe-self-paced smoke test (loops-phase-c-05) ─────────────────
describe("loadLoopsFromDir — real loops/ directory (_probe-self-paced smoke test)", () => {
  it("parses the real loops/_probe-self-paced.md file into valid[] (mode: self-paced)", async () => {
    const result = await loadLoopsFromDir(WORKTREE_LOOPS_DIR);
    const probeSp = result.valid.find((d) => d.id === "_probe-self-paced");
    expect(probeSp).toBeDefined();
    if (probeSp) {
      expect(probeSp.mode).toBe("self-paced");
      expect(probeSp.guardrails.mutates_build).toBe(false);
      expect(probeSp.status).toBe("active");
      expect(probeSp.trigger?.lifecycle_hook).toBe("session-start");
      expect(probeSp.trigger?.firing_posture.supervised).toBe("opt-in");
      expect(probeSp.trigger?.firing_posture.autonomous).toBe("disabled");
      expect(probeSp.trigger?.firing_posture["light-touch"]).toBe("disabled");
    }
  });

  it("_probe-self-paced passes the DR-005 guardrail (mutates_build:false, forbidden tools not in observe)", async () => {
    const result = await loadLoopsFromDir(WORKTREE_LOOPS_DIR);
    // Must not appear in invalid[]
    const invalidEntry = result.invalid.find((e) => e.file.includes("_probe-self-paced"));
    expect(invalidEntry).toBeUndefined();
    // Must appear in valid[]
    const probeSp = result.valid.find((d) => d.id === "_probe-self-paced");
    expect(probeSp).toBeDefined();
  });

  it("a mutated copy of _probe-self-paced with Write in observe.tools would be rejected (sanity check)", async () => {
    // This proves the definition is genuinely guard-passing, not guard-bypassing
    const { parseLoopDefinition } = await import("../loop-schema.ts");
    const result = await loadLoopsFromDir(WORKTREE_LOOPS_DIR);
    const probeSp = result.valid.find((d) => d.id === "_probe-self-paced");
    if (!probeSp) return; // prerequisite: probe-self-paced loaded

    const mutated = {
      ...probeSp,
      observe: {
        ...probeSp.observe,
        tools: ["Write"], // mutation tool injection — must be rejected
      },
    };
    const parseResult = parseLoopDefinition(mutated, {});
    expect(parseResult.ok).toBe(false);
  });
});

// ── Phase C: session-watch smoke test (loops-phase-c-06) ─────────────────────
describe("loadLoopsFromDir — real loops/ directory (session-watch smoke test)", () => {
  it("session-watch loads into valid[] with mode:self-paced and lifecycle_hook:session-start", async () => {
    const result = await loadLoopsFromDir(WORKTREE_LOOPS_DIR);
    const sw = result.valid.find((d) => d.id === "session-watch");
    expect(sw).toBeDefined();
    if (sw) {
      expect(sw.mode).toBe("self-paced");
      expect(sw.guardrails.mutates_build).toBe(false);
      expect(sw.status).toBe("active");
      expect(sw.trigger?.lifecycle_hook).toBe("session-start");
      // Tier-gated posture
      expect(sw.trigger?.firing_posture.autonomous).toBe("auto");
      expect(sw.trigger?.firing_posture["light-touch"]).toBe("auto");
      expect(sw.trigger?.firing_posture.supervised).toBe("opt-in");
    }
  });

  it("session-watch does NOT appear in invalid[]", async () => {
    const result = await loadLoopsFromDir(WORKTREE_LOOPS_DIR);
    const invalidEntry = result.invalid.find((e) => e.file.includes("session-watch"));
    expect(invalidEntry).toBeUndefined();
  });

  it("session-watch with Write in observe.tools would be rejected (DR-005 guard active)", async () => {
    // Proves the definition is genuinely guard-passing, not guard-bypassing
    const { parseLoopDefinition } = await import("../loop-schema.ts");
    const result = await loadLoopsFromDir(WORKTREE_LOOPS_DIR);
    const sw = result.valid.find((d) => d.id === "session-watch");
    if (!sw) return; // prerequisite: session-watch loaded

    const mutated = {
      ...sw,
      observe: {
        ...sw.observe,
        tools: ["Write"], // mutation tool injection — must be rejected
      },
    };
    const parseResult = parseLoopDefinition(mutated, {});
    expect(parseResult.ok).toBe(false);
  });
});
