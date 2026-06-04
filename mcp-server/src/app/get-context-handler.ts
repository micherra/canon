import { join } from "node:path";
import type { AccuracyMap } from "@features/diagnostics/services/prediction-accuracy.ts";
import {
  buildAccuracySummary,
  computeAccuracy,
} from "@features/diagnostics/services/prediction-accuracy.ts";
import { recordPrediction } from "@features/diagnostics/services/prediction-tracker.ts";
import type { FileSignals } from "@features/diagnostics/services/signal-compiler.ts";
import { compileSignals } from "@features/diagnostics/services/signal-compiler.ts";
import {
  type DriftReportOutput,
  getDriftReport,
} from "@features/diagnostics/tools/get-drift-report.ts";
import type { FileContextOutput } from "@features/file-context/tools/get-file-context.ts";
import { getFileContext } from "@features/file-context/tools/get-file-context.ts";
import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";
import type { GetPrinciplesBatchOutput } from "@features/principles/tools/get-principles.ts";
import { getPrinciplesBatch } from "@features/principles/tools/get-principles.ts";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { CANON_DIR } from "@shared/constants.ts";
import { applyDisclosure } from "@shared/lib/progressive-disclosure.ts";
import { z } from "zod";
import { pluginDir, resolveScope } from "./server-state.ts";

// --- get_context composite tool implementation ---

export type IncludeSection = "principles" | "file_context" | "drift" | "graph" | "signals";

/**
 * Compact drift section returned when the full get_context response is truncated.
 * Only preserves the pre-formatted summary string; full data is available at full_data_path.
 */
export type SlimmedDriftOutput = {
  formatted: string;
  truncated: true;
};

export type GetContextOutput = {
  file_paths: string[];
  include: IncludeSection[];
  principles?: GetPrinciplesBatchOutput;
  file_context?: FileContextOutput[];
  drift?: DriftReportOutput | SlimmedDriftOutput;
  graph?: unknown;
  signals?: FileSignals[];
  /** Wave 3: Per-principle accuracy summary for learner agent consumption. */
  accuracy_summary?: string;
  /** When true, response was truncated due to size. Full data at full_data_path. */
  truncated?: boolean;
  /** Absolute path to full response JSON when truncated is true. */
  full_data_path?: string;
  /** Compact overview of the response content when truncated is true. */
  disclosure_summary?: string;
};

export const getContextInputSchema = {
  file_paths: z.array(z.string()).describe("File paths to get context for"),
  include: z
    .array(z.enum(["principles", "file_context", "drift", "graph", "signals"]))
    .optional()
    .describe("Sections to include (default: all)"),
};

export const ALL_SECTIONS: IncludeSection[] = [
  "principles",
  "file_context",
  "drift",
  "graph",
  "signals",
];

/**
 * Query blast_radius for each file path and return the aggregate results.
 * Skips files where KG is not indexed or returns a recoverable error.
 * Returns undefined when no results could be collected.
 */
function queryGraphForFiles(filePaths: string[], dir: string): unknown[] | undefined {
  if (filePaths.length === 0) return undefined;
  const aggregated: unknown[] = [];
  for (const target of filePaths) {
    const result = graphQuery({ query_type: "blast_radius", target }, dir);
    if (result.ok) aggregated.push(result);
  }
  return aggregated.length > 0 ? aggregated : undefined;
}

// Fail-open helper: compute accuracy data; returns undefined on error.
function tryComputeAccuracy(
  driftDbSignals: ReturnType<ReturnType<typeof getDriftDb>["getSignals"]>,
): AccuracyMap | undefined {
  try {
    return computeAccuracy(driftDbSignals);
  } catch (err) {
    console.warn(
      "[canon] get_context: accuracy computation failed:",
      err instanceof Error ? err.message : err,
    ); // best-effort
    return undefined;
  }
}

// Fail-open helper: populate accuracy_summary on output; silences errors.
function trySetAccuracySummary(accuracyData: AccuracyMap, output: GetContextOutput): void {
  if (accuracyData.size === 0) return;
  try {
    const summary = buildAccuracySummary(accuracyData);
    if (summary) output.accuracy_summary = summary;
  } catch (err) {
    console.warn(
      "[canon] get_context: accuracy summary generation failed:",
      err instanceof Error ? err.message : err,
    ); // best-effort
  }
}

/**
 * Populate output.signals and output.accuracy_summary for the signals section.
 * Fail-open: signals are optional enrichment; errors are silently ignored.
 */
function resolveSignals(filePaths: string[], output: GetContextOutput, dir: string): void {
  try {
    const driftDb = getDriftDb(dir);
    const driftDbSignals = driftDb.getSignals();
    const accuracyData = tryComputeAccuracy(driftDbSignals);
    const signals = compileSignals(filePaths, driftDbSignals, { accuracyData });
    if (signals.length > 0) {
      output.signals = signals;
      // Record prediction — fail-open; if recordPrediction fails, signals are still returned.
      recordPrediction({ compiledSignals: signals, filePaths }, driftDbSignals);
    }
    if (accuracyData) trySetAccuracySummary(accuracyData, output);
  } catch (err) {
    // best-effort: signals section is optional enrichment; primary output already returned
    console.warn(
      "[canon] get_context: signals section failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Produce a compact summary string for a GetContextOutput for disclosure logging.
 * Reports section presence and counts without including full payloads.
 */
function summarizeContextOutput(data: GetContextOutput): string {
  const parts: string[] = [
    `Files: ${data.file_paths.join(", ")}`,
    `Sections: ${data.include.join(", ")}`,
  ];
  if (data.principles) {
    const count = Array.isArray(data.principles.principles)
      ? data.principles.principles.length
      : "batch";
    parts.push(`Principles: ${count} matched`);
  }
  if (data.file_context) parts.push(`File contexts: ${data.file_context.length} files`);
  if (data.drift) parts.push("Drift: included");
  if (data.graph) parts.push("Graph: included");
  if (data.signals) parts.push(`Signals: ${data.signals.length} files`);
  return parts.join("\n");
}

/**
 * Build a slimmed GetContextOutput for truncated responses.
 * Preserves routing metadata but strips large payloads (bodies, content, dependency lists).
 */
export function buildSlimmedOutput(
  output: GetContextOutput,
  fullDataPath: string,
): GetContextOutput {
  const slimmed: GetContextOutput = {
    file_paths: output.file_paths,
    full_data_path: fullDataPath,
    include: output.include,
    truncated: true,
  };
  if (output.principles) {
    slimmed.principles = {
      ...output.principles,
      principles: output.principles.principles.map((p) => ({ ...p, body: "" })),
    };
  }
  if (output.file_context) {
    slimmed.file_context = output.file_context.map((fc) => ({
      blast_radius: undefined,
      co_change_partners: undefined,
      content: "",
      entities: undefined,
      exports: [],
      file_path: fc.file_path,
      graph_metrics: fc.graph_metrics,
      hotspot_score: undefined,
      imported_by: [],
      imported_by_layer: {},
      imports: [],
      imports_by_layer: {},
      last_verdict: fc.last_verdict,
      layer: fc.layer,
      layer_stack: fc.layer_stack,
      project_max_impact: fc.project_max_impact,
      role: fc.role,
      shape: fc.shape,
      summary: fc.summary,
      violation_count: fc.violation_count,
      violations: [],
    }));
  }
  if (output.drift !== undefined) {
    const slimmedDrift: SlimmedDriftOutput = {
      formatted: output.drift.formatted ?? "See full data file.",
      truncated: true,
    };
    slimmed.drift = slimmedDrift;
  }
  if (output.graph !== undefined) {
    const graphArr = Array.isArray(output.graph) ? output.graph : [];
    slimmed.graph = {
      file_count: graphArr.length,
      note: "See full data file for blast radius details.",
    };
  }
  if (output.signals !== undefined) {
    slimmed.signals = output.signals.map((s) => ({ ...s, signals: [] }));
  }
  if (output.accuracy_summary !== undefined) slimmed.accuracy_summary = output.accuracy_summary;
  return slimmed;
}

/**
 * Apply progressive disclosure to the assembled GetContextOutput.
 * Returns the output unchanged when under threshold; returns a slimmed version
 * with a file pointer when over threshold.
 */
async function applyContextDisclosure(
  output: GetContextOutput,
  dir: string,
): Promise<GetContextOutput> {
  const disclosure = await applyDisclosure(output, {
    filePrefix: "get-context",
    outputDir: join(dir, CANON_DIR, "artifacts"),
    summarize: summarizeContextOutput,
  });
  if (disclosure.truncated) {
    const slimmed = buildSlimmedOutput(output, disclosure.full_data_path);
    // Include the disclosure summary so callers get a useful overview without reading the full file.
    slimmed.disclosure_summary = disclosure.summary;
    return slimmed;
  }
  return output;
}

export async function handleGetContext(
  input: {
    file_paths: string[];
    include?: IncludeSection[];
  },
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<GetContextOutput> {
  // When extra is absent (direct call from tests), pass a stub so resolveScope falls through
  // to the module global via the STDIO sentinel — the absent-extra path is the tested fallback.
  const dir = resolveScope(
    (extra ?? {
      requestId: "",
      sessionId: undefined,
      signal: new AbortController().signal,
    }) as RequestHandlerExtra<ServerRequest, ServerNotification>,
  );
  const sections: IncludeSection[] = input.include ?? ALL_SECTIONS;
  const output: GetContextOutput = {
    file_paths: input.file_paths,
    include: sections,
  };

  // Collect promises for sections that can run in parallel
  const tasks: Promise<void>[] = [];

  if (sections.includes("principles")) {
    tasks.push(
      getPrinciplesBatch({ file_paths: input.file_paths, summary_only: true }, dir, pluginDir).then(
        (result) => {
          output.principles = result;
        },
      ),
    );
  }

  if (sections.includes("file_context")) {
    tasks.push(
      Promise.all(input.file_paths.map((fp) => getFileContext({ file_path: fp }, dir))).then(
        (settled) => {
          const results: FileContextOutput[] = [];
          for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            if (!result.ok) {
              throw new Error(`file_context error (${result.error_code}): ${result.message}`);
            }
            const { ok, ...data } = result;
            results.push(data as FileContextOutput);
          }
          output.file_context = results;
        },
      ),
    );
  }

  if (sections.includes("drift")) {
    tasks.push(
      getDriftReport({}, dir, pluginDir).then((result) => {
        output.drift = result;
      }),
    );
  }

  if (sections.includes("graph")) {
    // graph section: skip gracefully when KG is not indexed.
    // Query blast_radius for each file and aggregate the results.
    tasks.push(
      Promise.resolve().then(() => {
        const results = queryGraphForFiles(input.file_paths, dir);
        if (results !== undefined) output.graph = results;
      }),
    );
  }

  if (sections.includes("signals")) {
    tasks.push(Promise.resolve().then(() => resolveSignals(input.file_paths, output, dir)));
  }

  await Promise.all(tasks);
  return applyContextDisclosure(output, dir);
}
