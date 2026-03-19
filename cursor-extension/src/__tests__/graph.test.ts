import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readGraphData } from "../services/graph";

describe("readGraphData", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-graph-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads valid graph data", async () => {
    const graphData = {
      nodes: [
        { id: "src/foo.ts", layer: "api", violation_count: 0 },
        { id: "src/bar.ts", layer: "domain", violation_count: 1 },
      ],
      edges: [{ source: "src/foo.ts", target: "src/bar.ts", kind: "import" }],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData)
    );

    const result = await readGraphData(tmpDir);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.nodes[0].id).toBe("src/foo.ts");
    expect(result.edges[0].source).toBe("src/foo.ts");
  });

  it("throws on missing graph-data.json", async () => {
    await expect(readGraphData(tmpDir)).rejects.toThrow();
  });

  it("throws on invalid data missing nodes array", async () => {
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify({ edges: [] })
    );

    await expect(readGraphData(tmpDir)).rejects.toThrow(
      "Invalid graph data: missing nodes or edges array"
    );
  });

  it("throws on invalid data missing edges array", async () => {
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify({ nodes: [] })
    );

    await expect(readGraphData(tmpDir)).rejects.toThrow(
      "Invalid graph data: missing nodes or edges array"
    );
  });

  it("merges string summaries from summaries.json", async () => {
    const graphData = {
      nodes: [{ id: "src/foo.ts", layer: "api", violation_count: 0 }],
      edges: [],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData)
    );
    await writeFile(
      join(tmpDir, ".canon", "summaries.json"),
      JSON.stringify({ "src/foo.ts": "Does foo things" })
    );

    const result = await readGraphData(tmpDir);

    expect(result.nodes[0].summary).toBe("Does foo things");
  });

  it("merges object summaries from summaries.json", async () => {
    const graphData = {
      nodes: [{ id: "src/foo.ts", layer: "api", violation_count: 0 }],
      edges: [],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData)
    );
    await writeFile(
      join(tmpDir, ".canon", "summaries.json"),
      JSON.stringify({ "src/foo.ts": { summary: "Does foo things" } })
    );

    const result = await readGraphData(tmpDir);

    expect(result.nodes[0].summary).toBe("Does foo things");
  });

  it("preserves existing node summaries", async () => {
    const graphData = {
      nodes: [
        {
          id: "src/foo.ts",
          layer: "api",
          violation_count: 0,
          summary: "Original summary",
        },
      ],
      edges: [],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData)
    );
    await writeFile(
      join(tmpDir, ".canon", "summaries.json"),
      JSON.stringify({ "src/foo.ts": "Override attempt" })
    );

    const result = await readGraphData(tmpDir);

    expect(result.nodes[0].summary).toBe("Original summary");
  });

  it("handles missing summaries.json gracefully", async () => {
    const graphData = {
      nodes: [{ id: "src/foo.ts", layer: "api", violation_count: 0 }],
      edges: [],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData)
    );

    const result = await readGraphData(tmpDir);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].summary).toBeUndefined();
  });

  it("handles empty summary values", async () => {
    const graphData = {
      nodes: [{ id: "src/foo.ts", layer: "api", violation_count: 0 }],
      edges: [],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData)
    );
    await writeFile(
      join(tmpDir, ".canon", "summaries.json"),
      JSON.stringify({ "src/foo.ts": { summary: "" } })
    );

    const result = await readGraphData(tmpDir);

    expect(result.nodes[0].summary).toBe("");
  });
});
