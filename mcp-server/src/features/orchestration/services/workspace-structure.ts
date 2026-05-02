/**
 * Project structure generation for workspace cache prefix assembly.
 * Reads the knowledge graph database to produce a structural summary.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";

/** Find the top N hub files by in-degree. */
function findTopHubs(
  allDegrees: Map<number, { in_degree: number; out_degree: number }>,
  fileIdToPath: Map<number, string>,
  n: number,
): Array<{ path: string; in_degree: number }> {
  const entries: Array<{ path: string; in_degree: number }> = [];
  for (const [fileId, degrees] of allDegrees) {
    const path = fileIdToPath.get(fileId);
    if (path !== undefined && degrees.in_degree > 0)
      entries.push({ in_degree: degrees.in_degree, path });
  }
  entries.sort((a, b) => b.in_degree - a.in_degree);
  return entries.slice(0, n);
}

/** Generate the project structure section from the KG database. */
function generateProjectStructure(projectDir: string): string | null {
  const kgDbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(kgDbPath)) return null;

  const db = initDatabase(kgDbPath);
  try {
    const kgQuery = new KgQuery(db);
    const allFiles = kgQuery.getAllFilesWithStats();

    const layerCounts = new Map<string, number>();
    const fileIdToPath = new Map<number, string>();
    for (const file of allFiles) {
      if (file.file_id !== undefined) fileIdToPath.set(file.file_id, file.path);
      const layer = file.layer || "unknown";
      layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
    }

    const layerBreakdown = [...layerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([layer, count]) => `${layer} (${count} file${count === 1 ? "" : "s"})`)
      .join(", ");

    const top5 = findTopHubs(kgQuery.getAllFileDegrees(), fileIdToPath, 5);
    const hubLine =
      top5.length > 0
        ? `Hub files (high in-degree): ${top5.map((h) => `${h.path} (${h.in_degree})`).join(", ")}`
        : "Hub files (high in-degree): none";

    return [
      "## Project Structure",
      "",
      `Layers: ${layerBreakdown || "none"}`,
      hubLine,
      `Total files in graph: ${allFiles.length}`,
    ].join("\n");
  } finally {
    db.close();
  }
}

/**
 * Generate the project structure section, swallowing errors.
 * Returns null when the KG database is absent or generation fails.
 */
export function tryGenerateStructure(projectDir: string): string | null {
  try {
    return generateProjectStructure(projectDir);
  } catch (err) {
    console.warn(
      "[canon] project structure generation failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
