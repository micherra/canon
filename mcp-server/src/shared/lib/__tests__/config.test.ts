import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLayerInferrer,
  DEFAULT_LAYER_MAPPINGS,
  deriveSourceDirsFromLayers,
  loadConfigNumber,
  loadJanitorConfig,
  loadLearnGateConfig,
} from "../config.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "canon-config-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

async function writeConfig(data: unknown) {
  const dir = join(tmpDir, ".canon");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(data), "utf-8");
}

describe("buildLayerInferrer", () => {
  describe("glob patterns", () => {
    it("matches ** glob: mcp-server/src/** matches mcp-server/src/tools/foo.ts", () => {
      const infer = buildLayerInferrer({ "mcp-server": ["mcp-server/src/**"] });
      expect(infer("mcp-server/src/tools/foo.ts")).toBe("mcp-server");
    });

    it("matches ** glob: mcp-server/ui/** matches mcp-server/ui/PrImpact.svelte", () => {
      const infer = buildLayerInferrer({ "dashboard-ui": ["mcp-server/ui/**"] });
      expect(infer("mcp-server/ui/PrImpact.svelte")).toBe("dashboard-ui");
    });

    it("matches ** glob at multiple depths", () => {
      const infer = buildLayerInferrer({ agents: ["agents/**"] });
      expect(infer("agents/implementor.md")).toBe("agents");
      expect(infer("agents/sub/dir/thing.md")).toBe("agents");
    });

    it("glob pattern does not match outside the prefix", () => {
      const infer = buildLayerInferrer({ "mcp-server": ["mcp-server/src/**"] });
      expect(infer("other/mcp-server/src/foo.ts")).toBe("unknown");
    });

    it("single * does not match across path separators", () => {
      const infer = buildLayerInferrer({ flows: ["flows/*"] });
      expect(infer("flows/README.md")).toBe("flows");
      expect(infer("flows/sub/deep.md")).toBe("unknown");
    });

    it("? matches a single non-separator character", () => {
      const infer = buildLayerInferrer({ src: ["src/?"] });
      expect(infer("src/a")).toBe("src");
      expect(infer("src/ab")).toBe("unknown");
    });
  });

  describe("simple directory name patterns (backward compatibility)", () => {
    it("matches a simple directory name segment", () => {
      const infer = buildLayerInferrer({ api: ["api", "routes"] });
      expect(infer("src/api/handler.ts")).toBe("api");
      expect(infer("src/routes/user.ts")).toBe("api");
    });

    it("does not match a partial segment", () => {
      const infer = buildLayerInferrer({ api: ["api"] });
      expect(infer("src/apiv2/handler.ts")).toBe("unknown");
    });
  });

  describe("first-match-wins", () => {
    it("returns the first matching layer", () => {
      const infer = buildLayerInferrer({
        first: ["mcp-server/src/**"],
        second: ["mcp-server/src/**"],
      });
      expect(infer("mcp-server/src/tools/foo.ts")).toBe("first");
    });
  });

  describe("non-matching paths", () => {
    it("returns unknown when no pattern matches", () => {
      const infer = buildLayerInferrer({ api: ["api"] });
      expect(infer("totally/unrelated/file.ts")).toBe("unknown");
    });
  });

  describe("mixed config with glob and simple patterns", () => {
    it("handles a mix of glob and simple patterns", () => {
      const infer = buildLayerInferrer({
        agents: ["agents/**"],
        api: ["api", "routes"],
        "dashboard-ui": ["mcp-server/src/ui/**"],
        "mcp-server": ["mcp-server/src/**"],
      });
      expect(infer("mcp-server/src/features/knowledge-graph/tools/codebase-graph.ts")).toBe(
        "mcp-server",
      );
      expect(infer("mcp-server/src/ui/snippets/DESIGN-SYSTEM.md")).toBe("dashboard-ui");
      expect(infer("src/api/handler.ts")).toBe("api");
      expect(infer("agents/implementor.md")).toBe("agents");
      expect(infer("unmatched/file.ts")).toBe("unknown");
    });
  });

  describe("DEFAULT_LAYER_MAPPINGS — hooks layer", () => {
    it("infers hooks for a top-level hooks script", () => {
      const infer = buildLayerInferrer(DEFAULT_LAYER_MAPPINGS);
      expect(infer("hooks/destructive-guard.sh")).toBe("hooks");
    });

    it("infers hooks for hooks/lib/ (ordering: hooks before shared/lib)", () => {
      const infer = buildLayerInferrer(DEFAULT_LAYER_MAPPINGS);
      // hooks/lib/canon-hook-lib.sh contains both 'hooks' and 'lib' segments.
      // The hooks entry must come before shared in DEFAULT_LAYER_MAPPINGS so
      // the more-specific prefix wins.
      expect(infer("hooks/lib/canon-hook-lib.sh")).toBe("hooks");
    });

    it("hooks entry appears before shared entry in DEFAULT_LAYER_MAPPINGS key order", () => {
      const keys = Object.keys(DEFAULT_LAYER_MAPPINGS);
      const hooksIdx = keys.indexOf("hooks");
      const sharedIdx = keys.indexOf("shared");
      expect(hooksIdx).toBeGreaterThanOrEqual(0); // hooks must exist
      expect(sharedIdx).toBeGreaterThanOrEqual(0); // shared must exist
      expect(hooksIdx).toBeLessThan(sharedIdx); // hooks before shared
    });

    it("shared layer still infers correctly for non-hooks lib paths", () => {
      const infer = buildLayerInferrer(DEFAULT_LAYER_MAPPINGS);
      expect(infer("src/shared/lib/config.ts")).toBe("shared");
    });

    it("does NOT classify app/hooks/useThing.ts as hooks layer (anchored to top-level hooks/)", () => {
      const infer = buildLayerInferrer(DEFAULT_LAYER_MAPPINGS);
      // A React-style hooks directory nested under app/ must NOT match the guardrail hooks layer.
      // The DEFAULT_LAYER_MAPPINGS hooks entry must be anchored to the top-level hooks/ directory.
      expect(infer("app/hooks/useThing.ts")).not.toBe("hooks");
    });

    it("does NOT classify src/hooks/foo.ts as hooks layer (anchored to top-level hooks/)", () => {
      const infer = buildLayerInferrer(DEFAULT_LAYER_MAPPINGS);
      expect(infer("src/hooks/foo.ts")).not.toBe("hooks");
    });
  });
});

describe("deriveSourceDirsFromLayers", () => {
  it("returns directories from rooted glob patterns", async () => {
    await writeConfig({
      layers: {
        agents: ["agents/**"],
        "mcp-server": ["mcp-server/src/**"],
      },
    });
    const result = await deriveSourceDirsFromLayers(tmpDir);
    expect(result).toContain("mcp-server/src");
    expect(result).toContain("agents");
  });

  it("skips plain segment patterns with no slash before wildcard", async () => {
    await writeConfig({
      layers: {
        api: ["api", "routes"],
      },
    });
    const result = await deriveSourceDirsFromLayers(tmpDir);
    expect(result).toBeNull();
  });

  it("deduplicates overlapping patterns from different layers", async () => {
    await writeConfig({
      layers: {
        first: ["src/api/**"],
        second: ["src/api/**"],
      },
    });
    const result = await deriveSourceDirsFromLayers(tmpDir);
    expect(result).not.toBeNull();
    const srcApiCount = result!.filter((d) => d === "src/api").length;
    expect(srcApiCount).toBe(1);
  });

  it("returns null when no layers configured in config", async () => {
    await writeConfig({ review: { max_principles_per_review: 5 } });
    const result = await deriveSourceDirsFromLayers(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when config file is missing", async () => {
    const result = await deriveSourceDirsFromLayers(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when layers contain only plain segment patterns", async () => {
    await writeConfig({
      layers: {
        api: ["api", "routes", "controllers"],
        ui: ["components", "pages"],
      },
    });
    const result = await deriveSourceDirsFromLayers(tmpDir);
    expect(result).toBeNull();
  });

  it("handles mixed rooted globs and plain segments, returns only rooted", async () => {
    await writeConfig({
      layers: {
        api: ["api", "routes"],
        "mcp-server": ["mcp-server/src/**"],
      },
    });
    const result = await deriveSourceDirsFromLayers(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("mcp-server/src");
    expect(result).not.toContain("api");
    expect(result).not.toContain("routes");
  });

  it("strips trailing slash after removing wildcard suffix", async () => {
    await writeConfig({
      layers: {
        flows: ["flows/*"],
      },
    });
    const result = await deriveSourceDirsFromLayers(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain("flows");
    // Should not have trailing slash
    expect(result!.every((d) => !d.endsWith("/"))).toBe(true);
  });
});

describe("loadConfigNumber", () => {
  it("returns numeric value for dotted key path", async () => {
    await writeConfig({ review: { max_principles_per_review: 25 } });
    expect(await loadConfigNumber(tmpDir, "review.max_principles_per_review", 10)).toBe(25);
  });

  it("returns default when config file is missing", async () => {
    expect(await loadConfigNumber(tmpDir, "missing", 42)).toBe(42);
  });

  it("returns default for non-numeric value", async () => {
    await writeConfig({ count: "abc" });
    expect(await loadConfigNumber(tmpDir, "count", 7)).toBe(7);
  });

  it("returns default for value less than 1", async () => {
    await writeConfig({ count: 0 });
    expect(await loadConfigNumber(tmpDir, "count", 7)).toBe(7);
  });

  it("floors floating point values", async () => {
    await writeConfig({ count: 3.7 });
    expect(await loadConfigNumber(tmpDir, "count", 1)).toBe(3);
  });
});

describe("loadLearnGateConfig", () => {
  it("returns defaults when config file is missing", async () => {
    const cfg = await loadLearnGateConfig(tmpDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.min_flows_since_last).toBe(5);
    expect(cfg.min_hours_since_last).toBe(48);
    expect(cfg.lock_stale_after_hours).toBe(1);
  });

  it("returns defaults when learn_gate section is missing", async () => {
    await writeConfig({ review: { max_principles_per_review: 10 } });
    const cfg = await loadLearnGateConfig(tmpDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.min_flows_since_last).toBe(5);
    expect(cfg.min_hours_since_last).toBe(48);
    expect(cfg.lock_stale_after_hours).toBe(1);
  });

  it("reads valid values from learn_gate section", async () => {
    await writeConfig({
      learn_gate: {
        enabled: false,
        lock_stale_after_hours: 2,
        min_flows_since_last: 10,
        min_hours_since_last: 24,
      },
    });
    const cfg = await loadLearnGateConfig(tmpDir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.min_flows_since_last).toBe(10);
    expect(cfg.min_hours_since_last).toBe(24);
    expect(cfg.lock_stale_after_hours).toBe(2);
  });

  it("allows min_hours_since_last = 0 (zero is valid)", async () => {
    await writeConfig({ learn_gate: { min_hours_since_last: 0 } });
    const cfg = await loadLearnGateConfig(tmpDir);
    expect(cfg.min_hours_since_last).toBe(0);
  });

  it("falls back to defaults for invalid min_flows_since_last (< 1)", async () => {
    await writeConfig({ learn_gate: { min_flows_since_last: 0 } });
    const cfg = await loadLearnGateConfig(tmpDir);
    expect(cfg.min_flows_since_last).toBe(5);
  });

  it("falls back to defaults for negative min_hours_since_last", async () => {
    await writeConfig({ learn_gate: { min_hours_since_last: -1 } });
    const cfg = await loadLearnGateConfig(tmpDir);
    expect(cfg.min_hours_since_last).toBe(48);
  });

  it("falls back to defaults for non-positive lock_stale_after_hours", async () => {
    await writeConfig({ learn_gate: { lock_stale_after_hours: 0 } });
    const cfg = await loadLearnGateConfig(tmpDir);
    expect(cfg.lock_stale_after_hours).toBe(1);
  });

  it("falls back to defaults for wrong types", async () => {
    await writeConfig({
      learn_gate: {
        enabled: "yes",
        lock_stale_after_hours: "2h",
        min_flows_since_last: "ten",
        min_hours_since_last: null,
      },
    });
    const cfg = await loadLearnGateConfig(tmpDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.min_flows_since_last).toBe(5);
    expect(cfg.min_hours_since_last).toBe(48);
    expect(cfg.lock_stale_after_hours).toBe(1);
  });

  it("floors floating point min_flows_since_last", async () => {
    await writeConfig({ learn_gate: { min_flows_since_last: 3.9 } });
    const cfg = await loadLearnGateConfig(tmpDir);
    expect(cfg.min_flows_since_last).toBe(3);
  });
});

describe("loadJanitorConfig", () => {
  it("returns defaults when config file is missing", async () => {
    const cfg = await loadJanitorConfig(tmpDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.min_hours_between_runs).toBe(1);
  });

  it("returns defaults when janitor section is missing", async () => {
    await writeConfig({ review: { max_principles_per_review: 10 } });
    const cfg = await loadJanitorConfig(tmpDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.min_hours_between_runs).toBe(1);
  });

  it("reads valid values from janitor section", async () => {
    await writeConfig({
      janitor: {
        enabled: false,
        min_hours_between_runs: 4,
      },
    });
    const cfg = await loadJanitorConfig(tmpDir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.min_hours_between_runs).toBe(4);
  });

  it("allows min_hours_between_runs = 0 (zero is valid — run every time)", async () => {
    await writeConfig({ janitor: { min_hours_between_runs: 0 } });
    const cfg = await loadJanitorConfig(tmpDir);
    expect(cfg.min_hours_between_runs).toBe(0);
  });

  it("falls back to defaults for negative min_hours_between_runs", async () => {
    await writeConfig({ janitor: { min_hours_between_runs: -1 } });
    const cfg = await loadJanitorConfig(tmpDir);
    expect(cfg.min_hours_between_runs).toBe(1);
  });

  it("falls back to defaults for wrong types", async () => {
    await writeConfig({
      janitor: {
        enabled: "yes",
        min_hours_between_runs: "2h",
      },
    });
    const cfg = await loadJanitorConfig(tmpDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.min_hours_between_runs).toBe(1);
  });

  describe("max_abandoned_workspace_age_hours opt-out semantics", () => {
    it("falls back to the 24h default when the key is absent", async () => {
      await writeConfig({ janitor: { min_hours_between_runs: 2 } });
      const cfg = await loadJanitorConfig(tmpDir);
      expect(cfg.max_abandoned_workspace_age_hours).toBe(24);
    });

    it("preserves an explicit null as the never-reclaim opt-out", async () => {
      await writeConfig({ janitor: { max_abandoned_workspace_age_hours: null } });
      const cfg = await loadJanitorConfig(tmpDir);
      // null is the documented opt-out: post-ship workspaces are never auto-reclaimed.
      // It must NOT be coerced into the 24h default.
      expect(cfg.max_abandoned_workspace_age_hours).toBeNull();
    });

    it("reads an explicit numeric value", async () => {
      await writeConfig({ janitor: { max_abandoned_workspace_age_hours: 72 } });
      const cfg = await loadJanitorConfig(tmpDir);
      expect(cfg.max_abandoned_workspace_age_hours).toBe(72);
    });

    it("allows max_abandoned_workspace_age_hours = 0 (zero is valid)", async () => {
      await writeConfig({ janitor: { max_abandoned_workspace_age_hours: 0 } });
      const cfg = await loadJanitorConfig(tmpDir);
      expect(cfg.max_abandoned_workspace_age_hours).toBe(0);
    });

    it("falls back to the default for a non-numeric, non-null value", async () => {
      await writeConfig({ janitor: { max_abandoned_workspace_age_hours: "soon" } });
      const cfg = await loadJanitorConfig(tmpDir);
      expect(cfg.max_abandoned_workspace_age_hours).toBe(24);
    });

    it("falls back to the default for a negative value", async () => {
      await writeConfig({ janitor: { max_abandoned_workspace_age_hours: -5 } });
      const cfg = await loadJanitorConfig(tmpDir);
      expect(cfg.max_abandoned_workspace_age_hours).toBe(24);
    });
  });
});
