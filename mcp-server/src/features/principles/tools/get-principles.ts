import { existsSync } from "node:fs";
import { join } from "node:path";
import { KgQuery } from "@graph/kg-query.ts";
import { computeFileInsightMaps } from "@graph/kg-query-insights.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import type { FileMetrics } from "@graph/kg-types.ts";
import { CANON_DIR, CANON_FILES, extractSummary } from "@shared/constants.ts";
import { loadConfigNumber } from "@shared/lib/config.ts";
import {
  mapUntrusted,
  renderUntrusted,
  renderUntrustedProjection,
} from "@shared/lib/overlay-untrusted-text.ts";
import { loadAllPrinciples, matchPrinciples } from "@shared/matcher.ts";
import { filterBodyBySections } from "@shared/parser.ts";

export type GetPrinciplesInput = {
  file_path?: string;
  layers?: string[];
  task_description?: string;
  summary_only?: boolean;
  sections?: string[];
};

export type PrinciplesGraphContext = Pick<
  FileMetrics,
  "in_degree" | "out_degree" | "is_hub" | "in_cycle" | "impact_score"
>;

export type GetPrinciplesOutput = {
  principles: Array<{
    id: string;
    title: string;
    severity: string;
    body: string;
  }>;
  total_matched: number;
  total_in_canon: number;
  graph_context?: PrinciplesGraphContext;
};

const DEFAULT_MAX_PRINCIPLES = 10;

function loadMaxPrinciples(projectDir: string): Promise<number> {
  return loadConfigNumber(projectDir, "review.max_principles_per_review", DEFAULT_MAX_PRINCIPLES);
}

type KgFileData = {
  graph_context?: GetPrinciplesOutput["graph_context"];
  computed_tags?: string[];
};

function loadKgFileData(dbPath: string, filePath: string): KgFileData {
  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
    const kgQuery = new KgQuery(db);
    const insightMaps = computeFileInsightMaps(db);
    const metrics = kgQuery.getFileMetrics(filePath, {
      cycleMemberPaths: insightMaps.cycleMemberPaths,
      hubPaths: insightMaps.hubPaths,
      layerViolationsByPath: insightMaps.layerViolationsByPath,
    });

    let graph_context: KgFileData["graph_context"];
    if (metrics) {
      graph_context = {
        impact_score: metrics.impact_score,
        in_cycle: metrics.in_cycle,
        in_degree: metrics.in_degree,
        is_hub: metrics.is_hub,
        out_degree: metrics.out_degree,
      };
    }

    const tagRows = kgQuery.getFileTagsByPath(filePath);
    const computed_tags = tagRows.length > 0 ? tagRows.map((r) => r.tag) : undefined;

    return { computed_tags, graph_context };
  } catch (err) {
    // best-effort: KG context is optional tag/graph enrichment; principles still matched
    console.warn(
      "[canon] get-principles: KG unavailable for",
      filePath,
      ":",
      err instanceof Error ? err.message : err,
    );
    return {};
  } finally {
    db?.close();
  }
}

function metricsToContext(metrics: FileMetrics): PrinciplesGraphContext {
  return {
    impact_score: metrics.impact_score,
    in_cycle: metrics.in_cycle,
    in_degree: metrics.in_degree,
    is_hub: metrics.is_hub,
    out_degree: metrics.out_degree,
  };
}

function formatPrincipleBody(
  p: {
    body: import("@shared/lib/overlay-untrusted-text.ts").UntrustedText;
    anti_rationalization?: import("@shared/lib/overlay-untrusted-text.ts").UntrustedText;
    verification?: import("@shared/lib/overlay-untrusted-text.ts").UntrustedText;
    source?: "project" | "plugin";
    id: string;
    title: import("@shared/lib/overlay-untrusted-text.ts").UntrustedText;
  },
  summaryOnly: boolean | undefined,
  sections: string[],
): string {
  const filteredBody = summaryOnly
    ? mapUntrusted(p.body, extractSummary)
    : filterBodyBySections(p.body, p.anti_rationalization, p.verification, sections);

  const ref = `.canon/principles/${p.id}`;
  if (p.source === "project") {
    // Fence untrusted project-local content as a WHOLE-PROJECTION envelope.
    // Title is included inside the fence so no free-text field appears in unfenced
    // instruction position.
    return renderUntrustedProjection(
      { body: filteredBody, heading: p.title },
      { ref, source: "project" },
    );
  }
  // Plugin (trusted) and origin-unknown content is returned as-is (no fence).
  return renderUntrusted(filteredBody, { ref, source: p.source });
}

export async function getPrinciples(
  input: GetPrinciplesInput,
  projectDir: string,
  pluginDir: string,
): Promise<GetPrinciplesOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const maxPrinciples = await loadMaxPrinciples(projectDir);

  // Load graph context and computed tags if file_path is provided
  let graph_context: GetPrinciplesOutput["graph_context"];
  let computed_tags: string[] | undefined;

  if (input.file_path) {
    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    if (existsSync(dbPath)) {
      const kgData = loadKgFileData(dbPath, input.file_path);
      graph_context = kgData.graph_context;
      computed_tags = kgData.computed_tags;
    }
  }

  const matched = matchPrinciples(allPrinciples, {
    computed_tags,
    file_path: input.file_path,
    layers: input.layers,
  });

  const top = matched.slice(0, maxPrinciples);

  const sections = input.sections ?? [];
  return {
    graph_context,
    principles: top.map((p) => ({
      body: formatPrincipleBody(p, input.summary_only, sections),
      id: p.id,
      severity: p.severity,
      // Expose safe id as the title field for project-local principles — the display
      // title (free-text, untrusted) is inside the whole-projection fence in `body`.
      // For plugin/unknown sources, render the branded title as a plain string.
      title:
        p.source === "project"
          ? p.id
          : renderUntrusted(p.title, { ref: `.canon/principles/${p.id}`, source: p.source }),
    })),
    total_in_canon: allPrinciples.length,
    total_matched: matched.length,
  };
}

export type GetPrinciplesBatchInput = {
  file_paths: string[];
  layers?: string[];
  task_description?: string;
  summary_only?: boolean;
  sections?: string[];
};

export type GetPrinciplesBatchOutput = {
  principles: Array<{ id: string; title: string; severity: string; body: string }>;
  total_matched: number;
  total_in_canon: number;
  graph_context_by_file: Record<string, PrinciplesGraphContext | undefined>;
};

function buildContextByFile(
  filePaths: string[],
  dbPath: string,
): Record<string, PrinciplesGraphContext | undefined> {
  const result: Record<string, PrinciplesGraphContext | undefined> = {};
  let db: ReturnType<typeof initDatabase> | undefined;
  try {
    db = initDatabase(dbPath);
    const kgQuery = new KgQuery(db);
    const insightMaps = computeFileInsightMaps(db);
    for (const filePath of filePaths) {
      const metrics = kgQuery.getFileMetrics(filePath, {
        cycleMemberPaths: insightMaps.cycleMemberPaths,
        hubPaths: insightMaps.hubPaths,
        layerViolationsByPath: insightMaps.layerViolationsByPath,
      });
      result[filePath] = metrics ? metricsToContext(metrics) : undefined;
    }
  } catch (err) {
    // best-effort: batch KG metrics are optional enrichment; principles matched without them
    console.warn(
      "[canon] get-principles: batch KG metrics unavailable:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    db?.close();
  }
  return result;
}

export async function getPrinciplesBatch(
  input: GetPrinciplesBatchInput,
  projectDir: string,
  pluginDir: string,
): Promise<GetPrinciplesBatchOutput> {
  const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
  const maxPrinciples = await loadMaxPrinciples(projectDir);

  const deduped = new Map<string, (typeof allPrinciples)[number]>();
  for (const filePath of input.file_paths) {
    const matched = matchPrinciples(allPrinciples, {
      file_path: filePath,
      layers: input.layers,
    });
    for (const p of matched) {
      if (!deduped.has(p.id)) deduped.set(p.id, p);
    }
  }

  const sections = input.sections ?? [];
  const principles = Array.from(deduped.values())
    .slice(0, maxPrinciples)
    .map((p) => ({
      body: formatPrincipleBody(p, input.summary_only, sections),
      id: p.id,
      severity: p.severity,
      // Same whole-projection treatment as the single-path: safe id as title field.
      title:
        p.source === "project"
          ? p.id
          : renderUntrusted(p.title, { ref: `.canon/principles/${p.id}`, source: p.source }),
    }));

  let graph_context_by_file: Record<string, PrinciplesGraphContext | undefined> = {};
  if (input.file_paths.length > 0) {
    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    graph_context_by_file = existsSync(dbPath)
      ? buildContextByFile(input.file_paths, dbPath)
      : Object.fromEntries(input.file_paths.map((fp) => [fp, undefined]));
  }

  return {
    graph_context_by_file,
    principles,
    total_in_canon: allPrinciples.length,
    total_matched: deduped.size,
  };
}
