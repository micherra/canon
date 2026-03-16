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

    const result = await codebaseGraph({}, tmpDir, "/nonexistent");

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

    const result = await codebaseGraph({}, tmpDir, "/nonexistent");

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

    const result = await codebaseGraph({}, tmpDir, "/nonexistent");

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
      { changed_files: ["src/api/orders.ts"] },
      tmpDir,
      "/nonexistent"
    );

    const changedNode = result.nodes.find((n) => n.id === "src/api/orders.ts");
    expect(changedNode?.changed).toBe(true);
  });

  it("returns empty graph for empty directory", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "canon-empty-"));
    await mkdir(join(emptyDir, ".canon"), { recursive: true });

    const result = await codebaseGraph({}, emptyDir, "/nonexistent");
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);

    await rm(emptyDir, { recursive: true, force: true });
  });
});

describe("LAYER_COLORS", () => {
  it("has colors for all standard layers", () => {
    expect(LAYER_COLORS.api).toBeDefined();
    expect(LAYER_COLORS.ui).toBeDefined();
    expect(LAYER_COLORS.domain).toBeDefined();
    expect(LAYER_COLORS.data).toBeDefined();
    expect(LAYER_COLORS.infra).toBeDefined();
    expect(LAYER_COLORS.shared).toBeDefined();
    expect(LAYER_COLORS.unknown).toBeDefined();
  });
});
