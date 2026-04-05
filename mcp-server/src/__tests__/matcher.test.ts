import { describe, expect, it } from "vitest";
import { inferLayer, matchPrinciples } from "../shared/matcher.ts";
import type { Principle } from "../shared/parser.ts";

function makePrinciple(overrides: Partial<Principle> = {}): Principle {
  return {
    archived: false,
    body: "Body",
    filePath: "test.md",
    id: "test",
    scope: { file_patterns: [], layers: [] },
    severity: "convention",
    tags: [],
    title: "Test",
    ...overrides,
  };
}

describe("inferLayer", () => {
  it("infers api from routes path", () => {
    expect(inferLayer("src/routes/users.ts")).toBe("api");
  });

  it("infers api from controllers path", () => {
    expect(inferLayer("src/controllers/auth.ts")).toBe("api");
  });

  it("infers ui from app path (Next.js)", () => {
    expect(inferLayer("src/app/page.tsx")).toBe("ui");
    expect(inferLayer("src/app/dashboard/page.tsx")).toBe("ui");
    expect(inferLayer("src/app/layout.tsx")).toBe("ui");
  });

  it("infers ui from components path", () => {
    expect(inferLayer("src/components/Button.tsx")).toBe("ui");
  });

  it("infers ui from pages path", () => {
    expect(inferLayer("src/pages/Home.tsx")).toBe("ui");
  });

  it("infers domain from services path", () => {
    expect(inferLayer("src/services/UserService.ts")).toBe("domain");
  });

  it("infers data from db path", () => {
    expect(inferLayer("src/db/migrations/001.sql")).toBe("data");
  });

  it("infers infra from terraform path", () => {
    expect(inferLayer("infra/terraform/main.tf")).toBe("infra");
  });

  it("infers shared from utils path", () => {
    expect(inferLayer("src/utils/helpers.ts")).toBe("shared");
  });

  it("returns undefined for unrecognized paths", () => {
    expect(inferLayer("src/main.ts")).toBeUndefined();
  });
});

describe("matchPrinciples", () => {
  it("returns all non-archived principles when no filters", () => {
    const principles = [makePrinciple({ id: "a" }), makePrinciple({ id: "b" })];
    const result = matchPrinciples(principles, {});
    expect(result).toHaveLength(2);
  });

  it("excludes archived principles", () => {
    const principles = [
      makePrinciple({ id: "active" }),
      makePrinciple({ archived: true, id: "archived" }),
    ];
    const result = matchPrinciples(principles, {});
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("active");
  });

  it("includes archived principles when include_archived is true", () => {
    const principles = [
      makePrinciple({ id: "active" }),
      makePrinciple({ archived: true, id: "archived" }),
    ];
    const result = matchPrinciples(principles, { include_archived: true });
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id)).toContain("archived");
  });

  it("filters by layer", () => {
    const principles = [
      makePrinciple({ id: "api-only", scope: { file_patterns: [], layers: ["api"] } }),
      makePrinciple({ id: "ui-only", scope: { file_patterns: [], layers: ["ui"] } }),
      makePrinciple({ id: "any-layer", scope: { file_patterns: [], layers: [] } }),
    ];
    const result = matchPrinciples(principles, { layers: ["api"] });
    expect(result.map((p) => p.id)).toEqual(["api-only", "any-layer"]);
  });

  it("infers layer from file_path", () => {
    const principles = [
      makePrinciple({ id: "api-rule", scope: { file_patterns: [], layers: ["api"] } }),
      makePrinciple({ id: "ui-rule", scope: { file_patterns: [], layers: ["ui"] } }),
    ];
    const result = matchPrinciples(principles, { file_path: "src/routes/users.ts" });
    expect(result.map((p) => p.id)).toEqual(["api-rule"]);
  });

  it("matches file patterns with glob", () => {
    const principles = [
      makePrinciple({
        id: "tf-only",
        scope: { file_patterns: ["**/*.tf"], layers: [] },
      }),
      makePrinciple({
        id: "any-file",
        scope: { file_patterns: [], layers: [] },
      }),
    ];
    const result = matchPrinciples(principles, { file_path: "infra/main.tf" });
    expect(result.map((p) => p.id)).toContain("tf-only");
    expect(result.map((p) => p.id)).toContain("any-file");
  });

  it("excludes principles whose file patterns don't match", () => {
    const principles = [
      makePrinciple({
        id: "ts-only",
        scope: { file_patterns: ["**/*.ts"], layers: [] },
      }),
    ];
    const result = matchPrinciples(principles, { file_path: "src/style.css" });
    expect(result).toHaveLength(0);
  });

  it("filters by severity", () => {
    const principles = [
      makePrinciple({ id: "r", severity: "rule" }),
      makePrinciple({ id: "so", severity: "strong-opinion" }),
      makePrinciple({ id: "c", severity: "convention" }),
    ];
    const result = matchPrinciples(principles, { severity_filter: "strong-opinion" });
    expect(result.map((p) => p.id)).toEqual(["r", "so"]);
  });

  it("filters by tags", () => {
    const principles = [
      makePrinciple({ id: "sec", tags: ["security"] }),
      makePrinciple({ id: "test", tags: ["testing"] }),
      makePrinciple({ id: "both", tags: ["security", "testing"] }),
    ];
    const result = matchPrinciples(principles, { tags: ["security"] });
    expect(result.map((p) => p.id)).toEqual(["sec", "both"]);
  });

  it("sorts by severity: rules first, then strong-opinions, then conventions", () => {
    const principles = [
      makePrinciple({ id: "c", severity: "convention" }),
      makePrinciple({ id: "r", severity: "rule" }),
      makePrinciple({ id: "so", severity: "strong-opinion" }),
    ];
    const result = matchPrinciples(principles, {});
    expect(result.map((p) => p.id)).toEqual(["r", "so", "c"]);
  });

  it("breaks severity ties by scope specificity (more file patterns first)", () => {
    const principles = [
      makePrinciple({
        id: "generic",
        scope: { file_patterns: [], layers: [] },
        severity: "rule",
      }),
      makePrinciple({
        id: "specific",
        scope: { file_patterns: ["src/**", "lib/**"], layers: [] },
        severity: "rule",
      }),
    ];
    const result = matchPrinciples(principles, {});
    expect(result[0].id).toBe("specific");
    expect(result[1].id).toBe("generic");
  });
});
