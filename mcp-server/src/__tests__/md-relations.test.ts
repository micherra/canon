import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildNameMaps, classifyMdNode, inferMdRelations } from "../graph/md-relations.ts";
import { codebaseGraph } from "../tools/codebase-graph.ts";

describe("classifyMdNode", () => {
  it("classifies by directory prefix", () => {
    expect(classifyMdNode("flows/feature.md")).toBe("flow");
    expect(classifyMdNode("flows/fragments/context-sync.md")).toBe("fragment");
    expect(classifyMdNode("agents/canon-architect.md")).toBe("agent");
    expect(classifyMdNode("templates/design-decision.md")).toBe("template");
    expect(classifyMdNode("principles/rules/fail-closed.md")).toBe("principle");
    expect(classifyMdNode("skills/canon/SKILL.md")).toBe("skill");
    expect(classifyMdNode("commands/pr-review.md")).toBe("command");
  });

  it("excludes doc files", () => {
    expect(classifyMdNode("flows/.claude/CLAUDE.md")).toBeUndefined();
    expect(classifyMdNode("flows/SCHEMA.md")).toBeUndefined();
    expect(classifyMdNode("agents/.claude/CLAUDE.md")).toBeUndefined();
  });

  it("returns undefined for non-md files", () => {
    expect(classifyMdNode("src/index.ts")).toBeUndefined();
  });

  it("returns undefined for unrecognized paths", () => {
    expect(classifyMdNode("docs/random.md")).toBeUndefined();
  });

  it("supports custom kind rules", () => {
    const rules = [{ kind: "documentation", prefix: "docs/" }];
    expect(classifyMdNode("docs/guide.md", rules)).toBe("documentation");
    expect(classifyMdNode("agents/foo.md", rules)).toBeUndefined();
  });
});

describe("buildNameMaps", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-md-test-"));
    await mkdir(join(tmpDir, "agents"), { recursive: true });
    await mkdir(join(tmpDir, "flows"), { recursive: true });
    await mkdir(join(tmpDir, "principles", "rules"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("builds stem map from file paths", async () => {
    const maps = await buildNameMaps(["agents/canon-architect.md", "flows/feature.md"], tmpDir);
    expect(maps.byStem.get("canon-architect")).toBe("agents/canon-architect.md");
    expect(maps.byStem.get("feature")).toBe("flows/feature.md");
  });

  it("builds ID map from frontmatter id field", async () => {
    await writeFile(
      join(tmpDir, "principles", "rules", "fail-closed.md"),
      "---\nid: fail-closed-by-default\ntitle: Fail Closed\nseverity: rule\n---\nBody.",
    );
    const maps = await buildNameMaps(["principles/rules/fail-closed.md"], tmpDir);
    expect(maps.byId.get("fail-closed-by-default")).toBe("principles/rules/fail-closed.md");
  });

  it("builds ID map from frontmatter name field", async () => {
    await writeFile(
      join(tmpDir, "agents", "canon-architect.md"),
      "---\nname: canon-architect\ndescription: Designs stuff\n---\n",
    );
    const maps = await buildNameMaps(["agents/canon-architect.md"], tmpDir);
    expect(maps.byId.get("canon-architect")).toBe("agents/canon-architect.md");
  });

  it("skips excluded doc files", async () => {
    const maps = await buildNameMaps(["agents/.claude/CLAUDE.md", "agents/canon-guide.md"], tmpDir);
    expect(maps.byStem.has("CLAUDE")).toBe(false);
    expect(maps.byStem.has("canon-guide")).toBe(true);
  });
});

describe("inferMdRelations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-md-test-"));
    await mkdir(join(tmpDir, "agents"), { recursive: true });
    await mkdir(join(tmpDir, "flows", "fragments"), { recursive: true });
    await mkdir(join(tmpDir, "templates"), { recursive: true });
    await mkdir(join(tmpDir, "principles", "rules"), { recursive: true });
    await mkdir(join(tmpDir, "commands"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("infers edges from frontmatter single values", async () => {
    await writeFile(
      join(tmpDir, "flows", "feature.md"),
      "---\nname: feature\nstates:\n  design:\n    agent: canon-architect\n---\nSpawn instructions.",
    );
    await writeFile(
      join(tmpDir, "agents", "canon-architect.md"),
      "---\nname: canon-architect\n---\n",
    );

    const filePaths = ["flows/feature.md", "agents/canon-architect.md"];
    const fileSet = new Set(filePaths);
    const maps = await buildNameMaps(filePaths, tmpDir);
    const edges = await inferMdRelations(filePaths, fileSet, maps, tmpDir);

    const agentEdge = edges.find(
      (e) => e.source === "flows/feature.md" && e.target === "agents/canon-architect.md",
    );
    expect(agentEdge).toBeDefined();
    expect(agentEdge?.relation).toBe("fm:agent");
    expect(agentEdge?.type).toBe("composition");
  });

  it("infers edges from frontmatter inline arrays", async () => {
    await writeFile(
      join(tmpDir, "templates", "implementation-log.md"),
      "---\ntemplate: implementation-log\nused-by: [canon-implementor, canon-fixer]\n---\n",
    );
    await writeFile(
      join(tmpDir, "agents", "canon-implementor.md"),
      "---\nname: canon-implementor\n---\n",
    );
    await writeFile(join(tmpDir, "agents", "canon-fixer.md"), "---\nname: canon-fixer\n---\n");

    const filePaths = [
      "templates/implementation-log.md",
      "agents/canon-implementor.md",
      "agents/canon-fixer.md",
    ];
    const fileSet = new Set(filePaths);
    const maps = await buildNameMaps(filePaths, tmpDir);
    const edges = await inferMdRelations(filePaths, fileSet, maps, tmpDir);

    const usedByEdges = edges.filter(
      (e) => e.source === "templates/implementation-log.md" && e.relation === "fm:used-by",
    );
    expect(usedByEdges).toHaveLength(2);
  });

  it("infers edges from nested frontmatter values (fragment includes)", async () => {
    await writeFile(
      join(tmpDir, "flows", "feature.md"),
      "---\nincludes:\n  - fragment: test-fix-loop\n  - fragment: ship-done\nstates:\n  design:\n    type: single\n---\n",
    );
    await writeFile(
      join(tmpDir, "flows", "fragments", "test-fix-loop.md"),
      "---\nname: test-fix-loop\n---\n",
    );
    await writeFile(
      join(tmpDir, "flows", "fragments", "ship-done.md"),
      "---\nname: ship-done\n---\n",
    );

    const filePaths = [
      "flows/feature.md",
      "flows/fragments/test-fix-loop.md",
      "flows/fragments/ship-done.md",
    ];
    const fileSet = new Set(filePaths);
    const maps = await buildNameMaps(filePaths, tmpDir);
    const edges = await inferMdRelations(filePaths, fileSet, maps, tmpDir);

    const fragmentEdges = edges.filter(
      (e) => e.source === "flows/feature.md" && e.relation === "fm:fragment",
    );
    expect(fragmentEdges).toHaveLength(2);
    expect(
      fragmentEdges.find((e) => e.target === "flows/fragments/test-fix-loop.md"),
    ).toBeDefined();
    expect(fragmentEdges.find((e) => e.target === "flows/fragments/ship-done.md")).toBeDefined();
  });

  it("infers edges from backtick-quoted IDs in body", async () => {
    await writeFile(
      join(tmpDir, "principles", "rules", "fail-closed.md"),
      "---\nid: fail-closed-by-default\n---\n\n**Related:** `handle-partial-failure` and `secrets-never-in-code`.",
    );
    await writeFile(
      join(tmpDir, "principles", "rules", "handle-partial.md"),
      "---\nid: handle-partial-failure\n---\nBody.",
    );
    await writeFile(
      join(tmpDir, "principles", "rules", "secrets.md"),
      "---\nid: secrets-never-in-code\n---\nBody.",
    );

    const filePaths = [
      "principles/rules/fail-closed.md",
      "principles/rules/handle-partial.md",
      "principles/rules/secrets.md",
    ];
    const fileSet = new Set(filePaths);
    const maps = await buildNameMaps(filePaths, tmpDir);
    const edges = await inferMdRelations(filePaths, fileSet, maps, tmpDir);

    const refEdges = edges.filter(
      (e) => e.source === "principles/rules/fail-closed.md" && e.relation === "ref:id",
    );
    expect(refEdges).toHaveLength(2);
    expect(refEdges.find((e) => e.target === "principles/rules/handle-partial.md")).toBeDefined();
    expect(refEdges.find((e) => e.target === "principles/rules/secrets.md")).toBeDefined();
  });

  it("infers edges from file path references", async () => {
    await writeFile(
      join(tmpDir, "agents", "canon-reviewer.md"),
      "---\nname: canon-reviewer\n---\n\nLoad per `${CLAUDE_PLUGIN_ROOT}/templates/review-checklist.md`. Also see agents/canon-guide.md.",
    );

    const filePaths = [
      "agents/canon-reviewer.md",
      "templates/review-checklist.md",
      "agents/canon-guide.md",
    ];
    const fileSet = new Set(filePaths);
    const maps = await buildNameMaps(filePaths, tmpDir);
    const edges = await inferMdRelations(filePaths, fileSet, maps, tmpDir);

    const pathEdges = edges.filter(
      (e) => e.source === "agents/canon-reviewer.md" && e.relation === "ref:path",
    );
    expect(pathEdges).toHaveLength(2);
  });

  it("infers command → flow and command → command edges via generic resolution", async () => {
    await writeFile(
      join(tmpDir, "commands", "pr-review.md"),
      "---\ndescription: Review a PR\n---\n\nLaunch `review-only` flow. See also `/canon:edit-principle`.",
    );
    await writeFile(join(tmpDir, "flows", "review-only.md"), "---\nname: review-only\n---\n");
    await writeFile(
      join(tmpDir, "commands", "edit-principle.md"),
      "---\ndescription: Edit principle\n---\n",
    );

    const filePaths = [
      "commands/pr-review.md",
      "flows/review-only.md",
      "commands/edit-principle.md",
    ];
    const fileSet = new Set(filePaths);
    const maps = await buildNameMaps(filePaths, tmpDir);
    const edges = await inferMdRelations(filePaths, fileSet, maps, tmpDir);

    // "review-only" resolves via stem/id to the flow file
    const flowEdge = edges.find(
      (e) => e.source === "commands/pr-review.md" && e.target === "flows/review-only.md",
    );
    expect(flowEdge).toBeDefined();
  });

  it("deduplicates edges by source|target|relation", async () => {
    await writeFile(
      join(tmpDir, "flows", "feature.md"),
      "---\nstates:\n  a:\n    agent: canon-implementor\n  b:\n    agent: canon-implementor\n---\n",
    );
    await writeFile(
      join(tmpDir, "agents", "canon-implementor.md"),
      "---\nname: canon-implementor\n---\n",
    );

    const filePaths = ["flows/feature.md", "agents/canon-implementor.md"];
    const fileSet = new Set(filePaths);
    const maps = await buildNameMaps(filePaths, tmpDir);
    const edges = await inferMdRelations(filePaths, fileSet, maps, tmpDir);

    const agentEdges = edges.filter(
      (e) =>
        e.source === "flows/feature.md" &&
        e.target === "agents/canon-implementor.md" &&
        e.relation === "fm:agent",
    );
    expect(agentEdges).toHaveLength(1);
  });
});

describe("codebaseGraph with md-relations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-graph-md-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "agents"), { recursive: true });
    await mkdir(join(tmpDir, "flows", "fragments"), { recursive: true });
    await mkdir(join(tmpDir, "templates"), { recursive: true });
    await mkdir(join(tmpDir, "principles", "rules"), { recursive: true });
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          docs: ["templates", "principles"],
          orchestration: ["flows", "agents"],
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("includes md-relation edges and node kinds in graph output", async () => {
    await writeFile(
      join(tmpDir, "flows", "feature.md"),
      "---\nname: feature\nincludes:\n  - fragment: context-sync\nstates:\n  design:\n    type: single\n    agent: canon-architect\n---\n",
    );
    await writeFile(
      join(tmpDir, "flows", "fragments", "context-sync.md"),
      "---\nname: context-sync\nstates:\n  sync:\n    type: single\n    agent: canon-scribe\n---\n",
    );
    await writeFile(
      join(tmpDir, "agents", "canon-architect.md"),
      "---\nname: canon-architect\n---\n",
    );
    await writeFile(join(tmpDir, "agents", "canon-scribe.md"), "---\nname: canon-scribe\n---\n");

    const result = await codebaseGraph({}, tmpDir, "/nonexistent");

    // Nodes should have kind set
    const flowNode = result.nodes.find((n) => n.id === "flows/feature.md");
    expect(flowNode).toBeDefined();
    expect(flowNode?.kind).toBe("flow");

    const agentNode = result.nodes.find((n) => n.id === "agents/canon-architect.md");
    expect(agentNode).toBeDefined();
    expect(agentNode?.kind).toBe("agent");

    // Should have fragment edge (from frontmatter `fragment: context-sync`)
    const fragmentEdge = result.edges.find(
      (e) => e.source === "flows/feature.md" && e.target === "flows/fragments/context-sync.md",
    );
    expect(fragmentEdge).toBeDefined();

    // Should have agent edges
    const agentEdges = result.edges.filter((e) => e.relation === "fm:agent");
    expect(agentEdges.length).toBeGreaterThanOrEqual(1);
  });
});
