import { getDriftReport } from "@features/diagnostics/tools/get-drift-report.ts";
import type { FileContextOutput } from "@features/file-context/tools/get-file-context.ts";
import { getFileContextBatch } from "@features/file-context/tools/get-file-context-batch.ts";
import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";
import type { GetPrinciplesBatchOutput } from "@features/principles/tools/get-principles.ts";
import { getPrinciplesBatch } from "@features/principles/tools/get-principles.ts";
import { z } from "zod";
import { gatedWrapHandler, pluginDir, projectDir, server } from "./server-state.ts";

// --- Types ---

type IncludeSection = "principles" | "file_context" | "drift" | "graph";

export type GetContextOutput = {
  file_paths: string[];
  include: IncludeSection[];
  principles?: GetPrinciplesBatchOutput;
  file_context?: FileContextOutput[];
  drift?: Awaited<ReturnType<typeof getDriftReport>>;
  graph?: unknown;
};

// --- Schema ---

const getContextInputSchema = {
  file_paths: z.array(z.string()).describe("File paths to get context for"),
  include: z
    .array(z.enum(["principles", "file_context", "drift", "graph"]))
    .optional()
    .describe("Sections to include (default: all)"),
};

const ALL_SECTIONS: IncludeSection[] = ["principles", "file_context", "drift", "graph"];

// --- Handler ---

async function handleGetContext(input: {
  file_paths: string[];
  include?: IncludeSection[];
}): Promise<GetContextOutput> {
  const sections: IncludeSection[] = input.include ?? ALL_SECTIONS;
  const output: GetContextOutput = {
    file_paths: input.file_paths,
    include: sections,
  };

  // Collect promises for sections that can run in parallel
  const tasks: Promise<void>[] = [];

  if (sections.includes("principles")) {
    tasks.push(
      getPrinciplesBatch(
        { file_paths: input.file_paths, summary_only: true },
        projectDir,
        pluginDir,
      ).then((result) => {
        output.principles = result;
      }),
    );
  }

  if (sections.includes("file_context")) {
    tasks.push(
      getFileContextBatch({ file_paths: input.file_paths }, projectDir).then((result) => {
        if (!result.ok) {
          // fail-closed: propagate file_context errors
          throw new Error(`file_context error (${result.error_code}): ${result.message}`);
        }
        output.file_context = result.results;
      }),
    );
  }

  if (sections.includes("drift")) {
    tasks.push(
      getDriftReport({}, projectDir, pluginDir).then((result) => {
        output.drift = result;
      }),
    );
  }

  if (sections.includes("graph")) {
    // graph section: skip gracefully when KG is not indexed
    tasks.push(
      Promise.resolve().then(() => {
        if (input.file_paths.length === 0) return;
        const target = input.file_paths[0];
        const result = graphQuery({ query_type: "blast_radius", target }, projectDir);
        if (!result.ok) {
          // KG not indexed or other recoverable error — skip gracefully
          return;
        }
        output.graph = result;
      }),
    );
  }

  await Promise.all(tasks);
  return output;
}

// --- Registration ---

export function registerCompositeTools(): void {
  server.registerTool(
    "get_context",
    {
      description:
        "Composite context tool — fetches principles, file context, drift report, and graph data in one call. Reduces round-trips when agents need full context for a set of files.",
      inputSchema: getContextInputSchema,
    },
    gatedWrapHandler(handleGetContext),
  );
}
