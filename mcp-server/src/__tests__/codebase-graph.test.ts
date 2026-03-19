import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { codebaseGraph, LAYER_COLORS } from "../tools/codebase-graph.js";

describe("codebaseGraph", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-graph-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });
    await mkdir(join(tmpDir, "src", "services"), { recursive: true });
    await mkdir(join(tmpDir, "src", "utils"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("scans files and creates nodes with layer inference", async () => {
    await writeFile(
      join(tmpDir, "src", "api", "orders.ts"),
      `import { OrderService } from '../services/order-service';\nexport function handler() {}`
    );
    await writeFile(
      join(tmpDir, "src", "services", "order-service.ts"),
      `export class OrderService {}`
    );

    const result = await codebaseGraph({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.find((n) => n.id.includes("api"))).toBeDefined();
    expect(result.nodes.find((n) => n.id.includes("services"))).toBeDefined();
    expect(result.generated_at).toBeTruthy();
  });

  it("creates edges from imports", async () => {
    await writeFile(
      join(tmpDir, "src", "api", "orders.ts"),
      `import { helper } from '../utils/helper';`
    );
    await writeFile(join(tmpDir, "src", "utils", "helper.ts"), `export function helper() {}`);

    const result = await codebaseGraph({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges.find(
      (e) => e.source.includes("orders") && e.target.includes("helper")
    );
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
      expect(apiLayer.color).toBe(LAYER_COLORS.api);
    }
  });

  it("marks changed files", async () => {
    await writeFile(join(tmpDir, "src", "api", "orders.ts"), `export const x = 1;`);

    const result = await codebaseGraph(
      { source_dirs: ["src"], changed_files: ["src/api/orders.ts"] },
      tmpDir,
      "/nonexistent"
    );

    const changedNode = result.nodes.find((n) => n.id === "src/api/orders.ts");
    expect(changedNode?.changed).toBe(true);
  });

  it("returns empty graph when no source_dirs configured", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "canon-empty-"));
    await mkdir(join(emptyDir, ".canon"), { recursive: true });

    const result = await codebaseGraph({}, emptyDir, "/nonexistent");
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);

    await rm(emptyDir, { recursive: true, force: true });
  });

  it("reads source_dirs from .canon/config.json", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ source_dirs: ["src"] })
    );
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export const h = 1;`);

    const result = await codebaseGraph({}, tmpDir, "/nonexistent");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe("src/api/handler.ts");
  });

  it("uses root_dir as fallback when no source_dirs configured", async () => {
    await writeFile(join(tmpDir, "src", "api", "a.ts"), `export const a = 1;`);

    const result = await codebaseGraph({ root_dir: tmpDir }, tmpDir, "/nonexistent");
    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
  });

  it("source_dirs from config takes precedence over root_dir", async () => {
    // Config says scan "src" only
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ source_dirs: ["src"] })
    );
    // File inside src
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), `export const h = 1;`);
    // File outside src (at project root)
    await mkdir(join(tmpDir, "scripts"), { recursive: true });
    await writeFile(join(tmpDir, "scripts", "seed.ts"), `export const s = 1;`);

    // Even though root_dir is passed, config source_dirs should win
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
      })
    );
    await writeFile(
      join(tmpDir, "src", "api", "handler.ts"),
      `import { helper } from '@/utils/helper';`
    );
    await writeFile(
      join(tmpDir, "src", "utils", "helper.ts"),
      `export function helper() {}`
    );

    const result = await codebaseGraph({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    expect(result.nodes).toHaveLength(2);
    const edge = result.edges.find(
      (e) => e.source.includes("handler") && e.target.includes("helper")
    );
    expect(edge).toBeDefined();
  });

  it("classifies app/ directory files as ui layer", async () => {
    await mkdir(join(tmpDir, "src", "app"), { recursive: true });
    await writeFile(join(tmpDir, "src", "app", "page.tsx"), `export default function Page() { return <div/>; }`);

    const result = await codebaseGraph({ source_dirs: ["src"] }, tmpDir, "/nonexistent");

    const appNode = result.nodes.find((n) => n.id === "src/app/page.tsx");
    expect(appNode).toBeDefined();
    expect(appNode!.layer).toBe("ui");
  });
});

