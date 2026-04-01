import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codebaseGraph } from "../tools/codebase-graph.ts";

describe("codebaseGraph", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-graph-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });
    await mkdir(join(tmpDir, "src", "services"), { recursive: true });
    await mkdir(join(tmpDir, "src", "utils"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          api: ["api"],
          domain: ["services"],
          shared: ["utils"],
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("scans files and creates nodes with layer inference", async () => {
    await writeFile(
      join(tmpDir, "src", "api", "orders.ts"),
      `import { OrderService } from '../services/order-service';\nexport function handler() {}`,
    );
    await writeFile(join(tmpDir, "src", "services", "order-service.ts"), `export class OrderService {}`);

    const result = await codebaseGraph({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.find((n) => n.id.includes("api"))).toBeDefined();
    expect(result.nodes.find((n) => n.id.includes("services"))).toBeDefined();
    expect(result.generated_at).toBeTruthy();
  });

  it("creates edges from imports", async () => {
    await writeFile(join(tmpDir, "src", "api", "orders.ts"), `import { helper } from '../utils/helper';`);
    await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

    const result = await codebaseGraph({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges.find((e) => e.source.includes("orders") && e.target.includes("helper"));
    expect(edge).toBeDefined();
    expect(edge!.type).toBe("import");
  });

  it("produces layer summary", async () => {
    await writeFile(join(tmpDir, "src", "api", "a.ts"), `export const a = 1;`);
    await writeFile(join(tmpDir, "src", "api", "b.ts"), `export const b = 2;`);
    await writeFile(join(tmpDir, "src", "utils", "c.ts"), `export const c = 3;`);

    const result = await codebaseGraph({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    expect(result.layers.length).toBeGreaterThanOrEqual(1);
    const apiLayer = result.layers.find((l) => l.name === "api");
    if (apiLayer) {
      expect(apiLayer.file_count).toBe(2);
      expect(apiLayer.color).toMatch(/^hsl\(/);
    }
  });

  it("marks changed files", async () => {
    await writeFile(join(tmpDir, "src", "api", "orders.ts"), `export const x = 1;`);

    const result = await codebaseGraph(
      { source_dirs: ["src"], changed_files: ["src/api/orders.ts"] },
      tmpDir,
      "/nonexistent",
    );

    const changedNode = result.nodes.find((n) => n.id === "src/api/orders.ts");
    expect(changedNode?.changed).toBe(true);
  });

  it("returns empty graph when no source_dirs configured", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "canon-empty-"));
    await mkdir(join(emptyDir, ".canon"), { recursive: true });
    await writeFile(
      join(emptyDir, ".canon", "config.json"),
      JSON.stringify({
        layers: { backend: ["src"] },
      }),
    );

    const result = await codebaseGraph({}, emptyDir, "/nonexistent");
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);

    await rm(emptyDir, { recursive: true, force: true });
  });

  it("derives scan dirs from layers in .canon/config.json", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: { src: ["src/**"] },
      }),
    );
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export const h = 1;`);

    const result = await codebaseGraph({}, tmpDir, "/nonexistent");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe("src/api/handler.ts");
  });

  it("uses root_dir as fallback when no layers with rooted globs configured", async () => {
    await writeFile(join(tmpDir, "src", "api", "a.ts"), `export const a = 1;`);

    const result = await codebaseGraph({ root_dir: tmpDir }, tmpDir, "/nonexistent");
    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
  });

  it("layers-derived dirs take precedence over root_dir", async () => {
    // Config layers say scan "src" only via glob
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: { src: ["src/**"] },
      }),
    );
    // File inside src
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export const h = 1;`);
    // File outside src (at project root)
    await mkdir(join(tmpDir, "scripts"), { recursive: true });
    await writeFile(join(tmpDir, "scripts", "seed.ts"), `export const s = 1;`);

    // Even though root_dir is passed, layers-derived dirs should win
    const result = await codebaseGraph({ root_dir: tmpDir }, tmpDir, "/nonexistent");
    expect(result.nodes.every((n) => n.id.startsWith("src/"))).toBe(true);
    expect(result.nodes.find((n) => n.id.includes("scripts"))).toBeUndefined();
  });

  it("resolves path aliases from tsconfig.json", async () => {
    await writeFile(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: { "@/*": ["./src/*"] },
        },
      }),
    );
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `import { helper } from '@/utils/helper';`);
    await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

    const result = await codebaseGraph({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    expect(result.nodes).toHaveLength(2);
    const edge = result.edges.find((e) => e.source.includes("handler") && e.target.includes("helper"));
    expect(edge).toBeDefined();
  });

  it("classifies app/ directory files as ui layer", async () => {
    await mkdir(join(tmpDir, "src", "app"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          ui: ["app"],
          shared: ["utils"],
        },
      }),
    );
    await writeFile(join(tmpDir, "src", "app", "page.tsx"), `export default function Page() { return <div/>; }`);

    const result = await codebaseGraph({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    const appNode = result.nodes.find((n) => n.id === "src/app/page.tsx");
    expect(appNode).toBeDefined();
    expect(appNode!.layer).toBe("ui");
  });

  it("falls back to default layers when layers are missing from config", async () => {
    // When config has no layers key, codebaseGraph must not throw and must use
    // the DEFAULT_LAYER_MAPPINGS (api, ui, domain, data, infra, shared).
    await writeFile(join(tmpDir, ".canon", "config.json"), JSON.stringify({}));
    // Add a file in src/api — default mappings assign "api" layer to "api" directories.
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handleRequest() {}`);

    const result = await codebaseGraph({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe("src/api/handler.ts");
    // Default layer inference assigns "api" to files under api/
    expect(result.nodes[0].layer).toBe("api");
    expect(result.edges).toHaveLength(0);
    // layers summary reflects the default inference
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].name).toBe("api");
    expect(result.layers[0].file_count).toBe(1);
  });

  it("merges inferred composition edges from llm-style references", async () => {
    await mkdir(join(tmpDir, "src", "templates"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: { llm: ["src/templates/**"] },
        graph: {
          composition: {
            enabled: true,
            file_patterns: [".md"],
            min_confidence: 0.7,
          },
        },
      }),
    );
    await writeFile(join(tmpDir, "src", "templates", "planner.md"), "uses: ./summarizer.md\n");
    await writeFile(join(tmpDir, "src", "templates", "summarizer.md"), "name: summarizer\n");

    const result = await codebaseGraph({}, tmpDir, "/nonexistent");
    const compositionEdge = result.edges.find(
      (e) =>
        e.source === "src/templates/planner.md" &&
        e.target === "src/templates/summarizer.md" &&
        e.type === "composition",
    );
    expect(compositionEdge).toBeDefined();
    expect(compositionEdge?.origin).toBe("inferred-llm");
    expect(compositionEdge?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("respects composition config when disabled", async () => {
    await mkdir(join(tmpDir, "src", "templates"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: { llm: ["src/templates/**"] },
        graph: {
          composition: {
            enabled: false,
            file_patterns: [".md"],
          },
        },
      }),
    );
    await writeFile(join(tmpDir, "src", "templates", "planner.md"), "uses: ./summarizer.md\n");
    await writeFile(join(tmpDir, "src", "templates", "summarizer.md"), "name: summarizer\n");

    const result = await codebaseGraph({}, tmpDir, "/nonexistent");
    const compositionEdge = result.edges.find((e) => e.type === "composition");
    expect(compositionEdge).toBeUndefined();
  });
});

// ── git-adapter-async integration (adr002-05) ──

describe("codebaseGraph — git adapter integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-graph-git-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });
    await writeFile(join(tmpDir, ".canon", "config.json"), JSON.stringify({ layers: { api: ["src/api"] } }));
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export function handler() {}`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("gitCurrentBranch returns null when gitExecAsync returns ok:false — no changed files from git", async () => {
    // Mock gitExecAsync to always return ok:false (simulates no git repo)
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: vi.fn().mockResolvedValue({
        ok: false,
        stdout: "",
        stderr: "fatal: not a git repository",
        exitCode: 128,
        timedOut: false,
      }),
    }));

    // Re-import to pick up the mock
    const { codebaseGraph: cg } = await import("../tools/codebase-graph.ts");
    const result = await cg({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    // When gitCurrentBranch returns null, no git-based changed file detection occurs.
    // The file should still be in nodes but not marked changed (no explicit changed_files input).
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0];
    expect(node.changed).toBe(false);
  });

  it("uses gitExecAsync (not child_process) for git helpers", async () => {
    const gitExecAsync = vi.fn().mockResolvedValue({
      ok: true,
      stdout: "feat/my-branch",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    vi.doMock("../adapters/git-adapter-async.ts", () => ({ gitExecAsync }));

    const { codebaseGraph: cg } = await import("../tools/codebase-graph.ts");
    await cg({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    // gitExecAsync should have been called (for gitCurrentBranch at minimum)
    expect(gitExecAsync).toHaveBeenCalled();
    // First call should be rev-parse --abbrev-ref HEAD (gitCurrentBranch)
    const [firstArgs] = gitExecAsync.mock.calls[0];
    expect(firstArgs).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
  });
});
