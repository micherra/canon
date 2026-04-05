import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewCode } from "@features/pr-review/tools/review-code.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("reviewCode", () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-rc-test-"));
    pluginDir = join(tmpDir, "plugin");

    const rulesDir = join(pluginDir, "principles", "rules");
    const opinionsDir = join(pluginDir, "principles", "strong-opinions");
    const conventionsDir = join(pluginDir, "principles", "conventions");
    await mkdir(rulesDir, { recursive: true });
    await mkdir(opinionsDir, { recursive: true });
    await mkdir(conventionsDir, { recursive: true });

    // Create project .canon dirs
    await mkdir(join(tmpDir, ".canon", "principles", "rules"), { recursive: true });
    await mkdir(join(tmpDir, ".canon", "principles", "strong-opinions"), { recursive: true });
    await mkdir(join(tmpDir, ".canon", "principles", "conventions"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  async function addPrinciple(
    severity: "rules" | "strong-opinions" | "conventions",
    id: string,
    severityValue: string,
  ) {
    await writeFile(
      join(pluginDir, "principles", severity, `${id}.md`),
      `---\nid: ${id}\ntitle: ${id}\nseverity: ${severityValue}\n---\n\nBody of ${id}.`,
    );
  }

  it("always includes all rules even when cap is smaller", async () => {
    // Create 3 rules and 2 opinions
    await addPrinciple("rules", "r1", "rule");
    await addPrinciple("rules", "r2", "rule");
    await addPrinciple("rules", "r3", "rule");
    await addPrinciple("strong-opinions", "so1", "strong-opinion");
    await addPrinciple("strong-opinions", "so2", "strong-opinion");

    // Set cap to 2 — smaller than the 3 rules
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ review: { max_review_principles: 2 } }),
    );

    const result = await reviewCode(
      { code: "const x = 1;", file_path: "src/foo.ts" },
      tmpDir,
      pluginDir,
    );

    // All 3 rules must be present
    const ruleIds = result.principles_to_evaluate
      .filter((p) => p.severity === "rule")
      .map((p) => p.principle_id);
    expect(ruleIds).toContain("r1");
    expect(ruleIds).toContain("r2");
    expect(ruleIds).toContain("r3");

    // No non-rules since budget is exhausted
    const nonRules = result.principles_to_evaluate.filter((p) => p.severity !== "rule");
    expect(nonRules).toHaveLength(0);
  });

  it("fills remaining budget with non-rules after including all rules", async () => {
    await addPrinciple("rules", "r1", "rule");
    await addPrinciple("strong-opinions", "so1", "strong-opinion");
    await addPrinciple("strong-opinions", "so2", "strong-opinion");
    await addPrinciple("conventions", "c1", "convention");

    // Cap at 3: 1 rule + 2 non-rules
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ review: { max_review_principles: 3 } }),
    );

    const result = await reviewCode(
      { code: "const x = 1;", file_path: "src/foo.ts" },
      tmpDir,
      pluginDir,
    );

    expect(result.principles_to_evaluate).toHaveLength(3);
    expect(result.principles_to_evaluate.filter((p) => p.severity === "rule")).toHaveLength(1);
  });

  it("reports omitted count in summary when principles are truncated", async () => {
    await addPrinciple("rules", "r1", "rule");
    await addPrinciple("strong-opinions", "so1", "strong-opinion");
    await addPrinciple("strong-opinions", "so2", "strong-opinion");
    await addPrinciple("conventions", "c1", "convention");

    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ review: { max_review_principles: 2 } }),
    );

    const result = await reviewCode(
      { code: "const x = 1;", file_path: "src/foo.ts" },
      tmpDir,
      pluginDir,
    );

    // 1 rule always included + 1 non-rule from budget = 2 returned, 2 omitted
    expect(result.summary).toContain("2 lower-priority principles omitted");
  });

  it("does not truncate when all principles fit within cap", async () => {
    await addPrinciple("rules", "r1", "rule");
    await addPrinciple("strong-opinions", "so1", "strong-opinion");

    const result = await reviewCode(
      { code: "const x = 1;", file_path: "src/foo.ts" },
      tmpDir,
      pluginDir,
    );

    expect(result.principles_to_evaluate).toHaveLength(2);
    expect(result.summary).not.toContain("omitted");
  });

  describe("sections filter", () => {
    beforeEach(async () => {
      // Add a principle with known sections
      const rulesDir = join(pluginDir, "principles", "rules");
      await writeFile(
        join(rulesDir, "r-full.md"),
        [
          "---",
          "id: r-full",
          "title: Rule Full",
          "severity: rule",
          "---",
          "",
          "Body summary.",
          "",
          "## Anti-Rationalization",
          "",
          "Excuse table here.",
          "",
          "## Verification",
          "",
          "Run: `npm test`",
        ].join("\n"),
      );
    });

    it("sections filter applies to principles_to_evaluate body field", async () => {
      const result = await reviewCode(
        { code: "const x = 1;", file_path: "src/foo.ts", sections: ["verification"] },
        tmpDir,
        pluginDir,
      );
      const p = result.principles_to_evaluate.find((p) => p.principle_id === "r-full");
      expect(p).toBeDefined();
      expect(p!.body).toContain("Body summary.");
      expect(p!.body).toContain("## Verification");
      expect(p!.body).not.toContain("## Anti-Rationalization");
    });

    it("no sections parameter returns full body (backward compat)", async () => {
      const result = await reviewCode(
        { code: "const x = 1;", file_path: "src/foo.ts" },
        tmpDir,
        pluginDir,
      );
      const p = result.principles_to_evaluate.find((p) => p.principle_id === "r-full");
      expect(p).toBeDefined();
      expect(p!.body).toContain("## Anti-Rationalization");
      expect(p!.body).toContain("## Verification");
    });
  });
});
