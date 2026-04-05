import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertOk } from "../shared/lib/tool-result.ts";
import { writeResearchSynthesis } from "../tools/write-research-synthesis.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

const makeInput = (overrides: Partial<Parameters<typeof writeResearchSynthesis>[0]> = {}) => ({
  affected_subsystems: ["orchestration", "board"],
  key_findings: [
    {
      confidence: "high" as const,
      finding: "Board uses SQLite",
      source: "src/orchestration/board.ts",
    },
    { confidence: "medium" as const, finding: "No retry on failure" },
  ],
  open_questions: ["Should gates be async?", "Is retry needed?"],
  risk_areas: [
    { area: "Concurrency", mitigation: "Use locking", severity: "high" as const },
    { area: "Migration", severity: "low" as const },
  ],
  slug: "my-epic",
  workspace: "",
  ...overrides,
});

describe("writeResearchSynthesis — happy path", () => {
  it("writes RESEARCH-SYNTHESIS.md and .meta.json to handoffs dir", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-research-synthesis-test-"));

    const result = await writeResearchSynthesis(makeInput({ workspace: tmpDir }));

    assertOk(result);
    expect(result.path).toContain("RESEARCH-SYNTHESIS.md");
    expect(result.path).toContain("handoffs");
    expect(result.meta_path).toContain("RESEARCH-SYNTHESIS.meta.json");
    expect(result.meta_path).toContain("handoffs");
    expect(result.finding_count).toBe(2);
    expect(result.risk_count).toBe(2);

    const md = await readFile(result.path, "utf-8");
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(md).toBeTruthy();
    expect(meta).toBeTruthy();
  });

  it("meta.json has _type research_synthesis and _version 1", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-research-synthesis-test-"));

    const result = await writeResearchSynthesis(makeInput({ workspace: tmpDir }));

    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta._type).toBe("research_synthesis");
    expect(meta._version).toBe(1);
    expect(meta.slug).toBe("my-epic");
    expect(meta.key_findings).toHaveLength(2);
    expect(meta.risk_areas).toHaveLength(2);
    expect(meta.affected_subsystems).toEqual(["orchestration", "board"]);
    expect(meta.open_questions).toHaveLength(2);
  });

  it("markdown has all expected sections", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-research-synthesis-test-"));

    const result = await writeResearchSynthesis(makeInput({ workspace: tmpDir }));

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Key Findings");
    expect(content).toContain("Affected Subsystems");
    expect(content).toContain("Risk Areas");
    expect(content).toContain("Open Questions");
    expect(content).toContain("Board uses SQLite");
    expect(content).toContain("orchestration");
    expect(content).toContain("Concurrency");
    expect(content).toContain("Use locking");
    expect(content).toContain("Should gates be async?");
    // Confidence and severity appear
    expect(content).toContain("high");
    expect(content).toContain("medium");
    // Optional source appears
    expect(content).toContain("src/orchestration/board.ts");
    // Missing source renders as dash
    expect(content).toContain("—");
  });

  it("empty key_findings still produces valid output", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-research-synthesis-test-"));

    const result = await writeResearchSynthesis(makeInput({ key_findings: [], workspace: tmpDir }));

    assertOk(result);
    expect(result.finding_count).toBe(0);
    const md = await readFile(result.path, "utf-8");
    expect(md).toContain("Key Findings");
  });

  it("sources omitted: no Sources section in markdown", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-research-synthesis-test-"));

    const result = await writeResearchSynthesis(makeInput({ workspace: tmpDir }));

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).not.toContain("### Sources");
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta.sources).toBeUndefined();
  });

  it("sources included: Sources section appears in markdown and meta", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-research-synthesis-test-"));

    const result = await writeResearchSynthesis(
      makeInput({ sources: ["https://example.com/doc", "src/foo.ts"], workspace: tmpDir }),
    );

    assertOk(result);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("### Sources");
    expect(content).toContain("https://example.com/doc");
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));
    expect(meta.sources).toEqual(["https://example.com/doc", "src/foo.ts"]);
  });

  it("creates handoffs directory if it does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-research-synthesis-test-"));

    const result = await writeResearchSynthesis(makeInput({ workspace: tmpDir }));

    assertOk(result);
    expect(result.path).toContain("handoffs");
  });
});

describe("writeResearchSynthesis — validation errors", () => {
  it("returns INVALID_INPUT for invalid slug (spaces)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-research-synthesis-test-"));

    const result = await writeResearchSynthesis(
      makeInput({ slug: "invalid slug", workspace: tmpDir }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("invalid slug");
    }
  });

  it("returns INVALID_INPUT for invalid slug (special chars)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-research-synthesis-test-"));

    const result = await writeResearchSynthesis(makeInput({ slug: "my/epic!", workspace: tmpDir }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for path traversal attempt in slug", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-research-synthesis-test-"));

    // slug with traversal chars is caught by SLUG_PATTERN before path check
    const result = await writeResearchSynthesis(makeInput({ slug: "../evil", workspace: tmpDir }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });
});
