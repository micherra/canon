import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readGraphData } from "../services/graph";
import type { GraphStatus } from "../webview/stores/graphData";
import { graphStatus } from "../webview/stores/graphData";

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

  it("reads graph data with extended fields", async () => {
    const graphData = {
      nodes: [
        {
          id: "src/foo.ts",
          layer: "api",
          violation_count: 0,
          color: "#4CAF50",
          extension: "ts",
          kind: "file",
          top_violations: ["thin-handlers"],
          compliance_score: 0.85,
          entity_count: 5,
          export_count: 3,
          dead_code_count: 1,
          community: 2,
        },
      ],
      edges: [
        {
          source: "src/foo.ts",
          target: "src/bar.ts",
          kind: "import",
          type: "import",
          confidence: 0.95,
          evidence: "static",
          relation: "depends-on",
        },
      ],
      layers: [{ name: "api", color: "#FF5733", file_count: 3, index: 0 }],
      principles: {
        "thin-handlers": { title: "Thin Handlers", severity: "strong-opinion", summary: "Handlers should delegate." },
      },
      insights: { circular_dependencies: [], orphan_files: [] },
      generated_at: "2026-03-23T00:00:00Z",
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData)
    );

    const result = await readGraphData(tmpDir);

    expect(result.nodes[0].color).toBe("#4CAF50");
    expect(result.nodes[0].entity_count).toBe(5);
    expect(result.nodes[0].community).toBe(2);
    expect(result.nodes[0].compliance_score).toBe(0.85);
    expect(result.edges[0].confidence).toBe(0.95);
    expect(result.edges[0].relation).toBe("depends-on");
    expect(result.layers).toHaveLength(1);
    expect(result.layers![0].name).toBe("api");
    expect(result.principles!["thin-handlers"].title).toBe("Thin Handlers");
    expect(result.generated_at).toBe("2026-03-23T00:00:00Z");
    expect(result.insights.circular_dependencies).toHaveLength(0);
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

describe("GraphStatus", () => {
  it("includes reindexing as a valid status", () => {
    // Compile-time check: "reindexing" must be assignable to GraphStatus
    const status: GraphStatus = "reindexing";
    expect(status).toBe("reindexing");
  });

  it("graphStatus store accepts reindexing", () => {
    graphStatus.set("reindexing");
    let value: GraphStatus | undefined;
    const unsub = graphStatus.subscribe((v) => { value = v; });
    expect(value).toBe("reindexing");
    unsub();
  });
});
