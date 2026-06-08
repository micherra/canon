import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Import the handler functions directly for integration testing.
import { getLoopDefinitionHandler } from "../tools/get-loop-definition.ts";
import { listLoopsHandler } from "../tools/list-loops.ts";

/** Loop that omits firing_posture entirely — should materialise defaults. */
const NO_FIRING_POSTURE_MD = `---
id: no-posture
title: No Firing Posture Loop
status: active
trigger:
  fired_by: orchestrator
  lifecycle_hook: post-ship
mode: interval
schedule:
  interval: 5m
  max_ticks: 10
state:
  scope: workspace
  path: \${WORKSPACE}/no-posture-state.json
  snapshot:
    - tick_count
observe:
  tools: []
  mcp: []
surface:
  on_transition:
    - field: tick_count
      message: tick
terminate:
  when:
    - max_ticks_reached
guardrails:
  mutates_build: false
---

No firing posture loop body.
`;

/** Valid _probe loop markdown. */
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

The _probe loop body — increments tick_count and self-terminates at max_ticks.
`;

/** Shadow (inactive) loop — status:shadow */
const SHADOW_MD = `---
id: shadow-loop
title: Shadow Loop
status: shadow
trigger:
  fired_by: orchestrator
  lifecycle_hook: post-ship
  firing_posture:
    autonomous: disabled
    light-touch: opt-in
    supervised: auto
mode: interval
schedule:
  interval: 5m
  max_ticks: 10
state:
  scope: workspace
  path: \${WORKSPACE}/shadow-state.json
  snapshot:
    - events
observe:
  tools: []
  mcp: []
surface:
  on_transition:
    - field: events
      message: shadow tick
terminate:
  when:
    - max_ticks_reached
guardrails:
  mutates_build: false
  forbidden_tools: []
---

Shadow loop body.
`;

/** Malformed definition. */
const BROKEN_MD = `---
id: broken
title: Broken
mode: interval
---

No required fields.
`;

describe("listLoopsHandler", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-list-loops-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns the _probe loop on happy path", async () => {
    await writeFile(join(tmpDir, "_probe.md"), VALID_PROBE_MD);
    const result = await listLoopsHandler(tmpDir, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loops).toHaveLength(1);
      expect(result.loops[0].id).toBe("_probe");
      expect(result.invalid).toHaveLength(0);
    }
  });

  it("filters by lifecycle_hook — only matching loops returned", async () => {
    await writeFile(join(tmpDir, "_probe.md"), VALID_PROBE_MD);
    // _probe has post-ship hook
    const matchResult = await listLoopsHandler(tmpDir, { lifecycle_hook: "post-ship" });
    expect(matchResult.ok).toBe(true);
    if (matchResult.ok) {
      expect(matchResult.loops).toHaveLength(1);
    }

    const noMatchResult = await listLoopsHandler(tmpDir, { lifecycle_hook: "session-start" });
    expect(noMatchResult.ok).toBe(true);
    if (noMatchResult.ok) {
      expect(noMatchResult.loops).toHaveLength(0);
    }
  });

  it("only returns status:active loops (not shadow)", async () => {
    await writeFile(join(tmpDir, "_probe.md"), VALID_PROBE_MD);
    await writeFile(join(tmpDir, "shadow-loop.md"), SHADOW_MD);
    const result = await listLoopsHandler(tmpDir, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loops.every((l) => l.status === "active")).toBe(true);
      expect(result.loops.map((l) => l.id)).not.toContain("shadow-loop");
    }
  });

  it("annotates firing_posture when tier is provided", async () => {
    await writeFile(join(tmpDir, "_probe.md"), VALID_PROBE_MD);
    // _probe has supervised: opt-in
    const result = await listLoopsHandler(tmpDir, { tier: "supervised" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loops).toHaveLength(1);
      expect(result.loops[0].firing_posture_for_tier).toBe("opt-in");
    }
  });

  it("always returns the invalid[] channel (even when empty)", async () => {
    await writeFile(join(tmpDir, "_probe.md"), VALID_PROBE_MD);
    const result = await listLoopsHandler(tmpDir, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.invalid)).toBe(true);
    }
  });

  it("surfaces malformed loop in invalid[] without throwing", async () => {
    await writeFile(join(tmpDir, "broken.md"), BROKEN_MD);
    const result = await listLoopsHandler(tmpDir, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.invalid.length).toBeGreaterThan(0);
      expect(result.invalid[0].file).toContain("broken");
    }
  });

  // ── Comment 2 (P2): firing_posture defaults materialise when block omitted ──

  it("firing_posture [P2-C2]: loop with no firing_posture block returns firing_posture_for_tier:opt-in for supervised tier", async () => {
    await writeFile(join(tmpDir, "no-posture.md"), NO_FIRING_POSTURE_MD);
    const result = await listLoopsHandler(tmpDir, { tier: "supervised" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loops).toHaveLength(1);
      expect(result.loops[0].id).toBe("no-posture");
      // Must resolve to "opt-in" (the documented safe default for supervised)
      expect(result.loops[0].firing_posture_for_tier).toBe("opt-in");
    }
  });

  it("firing_posture [P2-C2]: loop with no firing_posture block returns firing_posture_for_tier:disabled for autonomous tier", async () => {
    await writeFile(join(tmpDir, "no-posture.md"), NO_FIRING_POSTURE_MD);
    const result = await listLoopsHandler(tmpDir, { tier: "autonomous" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loops).toHaveLength(1);
      expect(result.loops[0].firing_posture_for_tier).toBe("disabled");
    }
  });
});

describe("getLoopDefinitionHandler", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-get-loop-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns definition + body for a known id", async () => {
    await writeFile(join(tmpDir, "_probe.md"), VALID_PROBE_MD);
    const result = await getLoopDefinitionHandler(tmpDir, { id: "_probe" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.id).toBe("_probe");
      expect(result.body).toContain("_probe loop body");
    }
  });

  it("returns INVALID_INPUT error code for unknown id", async () => {
    await mkdir(tmpDir, { recursive: true });
    const result = await getLoopDefinitionHandler(tmpDir, { id: "does-not-exist" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns error for malformed definition", async () => {
    await writeFile(join(tmpDir, "broken.md"), BROKEN_MD);
    const result = await getLoopDefinitionHandler(tmpDir, { id: "broken" });
    expect(result.ok).toBe(false);
  });
});
