import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { askCodebase } from "../tools/ask-codebase.js";

describe("askCodebase", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-ask-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error when no graph data", async () => {
    const result = await askCodebase({ question: "anything" }, tmpDir);
    expect(result.focus).toBe("error");
  });

  it("routes cycle questions correctly", async () => {
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify({
        nodes: [
          { id: "a.ts", layer: "domain" },
          { id: "b.ts", layer: "domain" },
        ],
        edges: [
          { source: "a.ts", target: "b.ts" },
          { source: "b.ts", target: "a.ts" },
        ],
      }),
    );

    const result = await askCodebase({ question: "are there any circular dependencies?" }, tmpDir);
    expect(result.focus).toBe("cycles");
    expect((result.data as { count: number }).count).toBe(1);
  });

  it("routes orphan questions correctly", async () => {
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify({
        nodes: [
          { id: "used.ts", layer: "api" },
          { id: "orphan.ts", layer: "shared" },
          { id: "dep.ts", layer: "domain" },
        ],
        edges: [{ source: "used.ts", target: "dep.ts" }],
      }),
    );

    const result = await askCodebase({ question: "what files are unused?" }, tmpDir);
    expect(result.focus).toBe("orphans");
    expect(result.relevant_files).toContain("orphan.ts");
  });

  it("returns file detail when file_path provided", async () => {
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify({
        nodes: [
          { id: "src/api/handler.ts", layer: "api", violation_count: 0, last_verdict: null },
          { id: "src/utils/helper.ts", layer: "shared", violation_count: 0, last_verdict: null },
        ],
        edges: [{ source: "src/api/handler.ts", target: "src/utils/helper.ts" }],
      }),
    );

    const result = await askCodebase(
      { question: "tell me about this file", file_path: "src/api/handler.ts" },
      tmpDir,
    );
    expect(result.focus).toBe("file_detail");
    expect((result.data as { imports: string[] }).imports).toContain("src/utils/helper.ts");
  });

  it("returns overview for generic questions", async () => {
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify({
        nodes: [{ id: "a.ts", layer: "api" }],
        edges: [],
      }),
    );

    const result = await askCodebase({ question: "how is the project structured?" }, tmpDir);
    expect(result.focus).toBe("overview");
    expect(result.data).toHaveProperty("overview");
  });

  it("includes summaries when available", async () => {
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify({
        nodes: [{ id: "src/api/handler.ts", layer: "api", violation_count: 0, last_verdict: null }],
        edges: [],
      }),
    );
    await writeFile(
      join(tmpDir, ".canon", "summaries.json"),
      JSON.stringify({ "src/api/handler.ts": "Main API entry point for orders." }),
    );

    const result = await askCodebase(
      { question: "tell me about this file", file_path: "src/api/handler.ts" },
      tmpDir,
    );
    expect((result.data as { summary: string }).summary).toBe("Main API entry point for orders.");
  });

  it("detects mentioned files in questions", async () => {
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify({
        nodes: [
          { id: "src/api/handler.ts", layer: "api" },
          { id: "src/utils/helper.ts", layer: "shared" },
        ],
        edges: [{ source: "src/api/handler.ts", target: "src/utils/helper.ts" }],
      }),
    );

    const result = await askCodebase(
      { question: "what depends on helper.ts?" },
      tmpDir,
    );
    expect(result.focus).toBe("dependencies");
    expect((result.data as { file: string }).file).toBe("src/utils/helper.ts");
  });
});
