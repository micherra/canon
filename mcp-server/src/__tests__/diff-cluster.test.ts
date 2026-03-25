import { describe, it, expect } from "vitest";
import { clusterByDirectory, clusterByLayer } from "../orchestration/diff-cluster.ts";
import { parseTimeout } from "../tools/get-spawn-prompt.ts";

describe("clusterByDirectory", () => {
  it("groups files by first two path segments", () => {
    const files = [
      "src/api/orders.ts",
      "src/api/users.ts",
      "src/services/auth.ts",
      "src/services/billing.ts",
      "src/services/billing.test.ts",
      "src/ui/Dashboard.tsx",
    ];
    const clusters = clusterByDirectory(files);
    expect(clusters).toHaveLength(3);

    const apiCluster = clusters.find(c => c.key === "src/api");
    expect(apiCluster?.files).toEqual(["src/api/orders.ts", "src/api/users.ts"]);

    const serviceCluster = clusters.find(c => c.key === "src/services");
    expect(serviceCluster?.files).toHaveLength(3);

    const uiCluster = clusters.find(c => c.key === "src/ui");
    expect(uiCluster?.files).toEqual(["src/ui/Dashboard.tsx"]);
  });

  it("sorts clusters by file count descending", () => {
    const files = [
      "src/api/a.ts",
      "src/services/a.ts",
      "src/services/b.ts",
      "src/services/c.ts",
    ];
    const clusters = clusterByDirectory(files);
    expect(clusters[0].key).toBe("src/services");
    expect(clusters[1].key).toBe("src/api");
  });

  it("handles single-segment directories", () => {
    const files = ["package.json", "README.md"];
    const clusters = clusterByDirectory(files);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].key).toBe(".");
  });

  it("returns empty for empty input", () => {
    expect(clusterByDirectory([])).toEqual([]);
  });
});

describe("clusterByLayer", () => {
  it("groups files by Canon layer", () => {
    const files = [
      "src/routes/users.ts",
      "src/controllers/auth.ts",
      "src/components/Button.tsx",
      "src/services/billing.ts",
      "src/db/migrations/001.sql",
    ];
    const clusters = clusterByLayer(files);

    const apiCluster = clusters.find(c => c.key === "api");
    expect(apiCluster?.files).toEqual([
      "src/routes/users.ts",
      "src/controllers/auth.ts",
    ]);

    const uiCluster = clusters.find(c => c.key === "ui");
    expect(uiCluster?.files).toEqual(["src/components/Button.tsx"]);

    const domainCluster = clusters.find(c => c.key === "domain");
    expect(domainCluster?.files).toEqual(["src/services/billing.ts"]);
  });

  it("puts unrecognized files in unknown", () => {
    const files = ["foo/bar/baz.ts"];
    const clusters = clusterByLayer(files);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].key).toBe("unknown");
  });

  it("returns empty for empty input", () => {
    expect(clusterByLayer([])).toEqual([]);
  });
});

describe("parseTimeout", () => {
  it("parses minutes", () => {
    expect(parseTimeout("10m")).toBe(600000);
  });

  it("parses seconds", () => {
    expect(parseTimeout("30s")).toBe(30000);
  });

  it("parses hours", () => {
    expect(parseTimeout("1h")).toBe(3600000);
  });

  it("parses compound formats", () => {
    expect(parseTimeout("1h30m")).toBe(5400000);
  });

  it("returns undefined for invalid input", () => {
    expect(parseTimeout("abc")).toBeUndefined();
    expect(parseTimeout("")).toBeUndefined();
    expect(parseTimeout("10x")).toBeUndefined();
  });

  it("returns undefined for partial invalid input", () => {
    expect(parseTimeout("10m garbage")).toBeUndefined();
  });
});
