/**
 * corpus-artifact-lookup.ts — shared id → on-disk-artifact resolver spanning
 * principles ∪ rules ∪ references ∪ primers ∪ templates.
 *
 * Two consumers converge on this ONE resolver (ADR-0062):
 *   - scores-mode retirement/reinforcement nomination (mutation-selection.ts,
 *     select-mutation-targets.ts, ADR-0052) — Bug-1 part (a).
 *   - the positive-attribution corpus-fallback join (positive-attribution.ts) —
 *     Bug-1 part (d).
 * One shared primitive keeps the domain (and its precedence rules) defined
 * exactly once instead of drifting across two independent resolvers.
 *
 * Domain, in resolution-priority order (first writer wins on id collision):
 *   1. loadAllPrinciples(projectDir, pluginDir) — the unchanged, already
 *      precedence-first principle loader (project overrides plugin).
 *   2. rules/, references/, primers/, templates/ under projectDir, then the
 *      same four dirs under pluginDir — frontmatter `id:` scan. Project wins
 *      over plugin; the listed dir order is the tie-break within a root.
 * Principles always beat a same-id dir-scan hit — checked first at lookup time.
 *
 * Determinism + failure posture:
 *   - The id→(path, class) index is built ONCE per call; body is read lazily
 *     at lookup time (mirrors today's buildPrincipleArtifactLookup pattern).
 *   - Fail-open per file: malformed frontmatter, an unreadable file, or a
 *     missing dir all drop that file out of the domain (never throw) — the
 *     id then resolves to null, which every consumer treats as
 *     errors-are-values, never a fabricated artifact.
 *   - `.canon/` overlay content is NEVER scanned by the dir-scan branch above
 *     (ADR-0027 trust boundary); `.canon/principles/` overlay principles still
 *     resolve via loadAllPrinciples, unchanged existing posture.
 *
 * Deviation from the task plan: the plan named `readFrontmatter` from
 * `@shared/lib/frontmatter.ts` as the parser. That export does not exist in
 * this codebase — only the pure `splitFrontmatter(content)` seam does (see
 * `src/app/recall-adr-source.ts`'s header comment for the established
 * precedent: every call site reads the file itself via `node:fs` and passes
 * the raw content to `splitFrontmatter`). This file follows that pattern.
 *
 * no-llm-calls-in-mcp-tools: pure directory scan + frontmatter parse, zero
 * model calls. Verified by:
 *   grep -rniE 'anthropic|claude -p|messages.create|model:' corpus-artifact-lookup.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { splitFrontmatter } from "@shared/lib/frontmatter.ts";
import { loadAllPrinciples } from "@shared/matcher.ts";

export type CorpusArtifactClass = "principle" | "rule" | "reference" | "primer" | "template";

export type ResolvedCorpusArtifact = {
  path: string;
  body: string;
  artifact_class: CorpusArtifactClass;
};

export type CorpusArtifactLookup = (id: string) => ResolvedCorpusArtifact | null;

/** Dir name -> artifact_class, scanned per root in this fixed tie-break order. */
const DIR_CLASSES: ReadonlyArray<[dirName: string, artifactClass: CorpusArtifactClass]> = [
  ["rules", "rule"],
  ["references", "reference"],
  ["primers", "primer"],
  ["templates", "template"],
];

type DirScanEntry = {
  absPath: string;
  root: string;
  artifactClass: CorpusArtifactClass;
};

/** Read a single markdown file's frontmatter `id:` field. Fail-open: null on any error. */
function readArtifactId(absPath: string): string | null {
  try {
    const content = readFileSync(absPath, "utf-8");
    const { data } = splitFrontmatter(content);
    return typeof data.id === "string" && data.id.length > 0 ? data.id : null;
  } catch {
    return null;
  }
}

/** Non-throwing directory listing — missing dir -> empty contribution, no throw. */
function readDirSafe(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

type IndexOneFileArgs = {
  dirPath: string;
  filename: string;
  root: string;
  artifactClass: CorpusArtifactClass;
  index: Map<string, DirScanEntry>;
};

/**
 * indexOneFile — resolves + registers a single candidate file into `index`,
 * if it is a non-README `.md` file with a valid frontmatter `id:` not already
 * claimed. Extracted from scanRootDirs to keep its complexity under the
 * Biome threshold.
 */
function indexOneFile({ dirPath, filename, root, artifactClass, index }: IndexOneFileArgs): void {
  if (!filename.endsWith(".md") || filename === "README.md") return;
  const absPath = join(dirPath, filename);
  const id = readArtifactId(absPath);
  if (!id || index.has(id)) return;
  index.set(id, { absPath, artifactClass, root });
}

/**
 * scanRootDirs — indexes one root's four artifact dirs into `index`, in
 * DIR_CLASSES order. First writer wins: an id already present in `index` is
 * never overwritten (callers scan projectDir before pluginDir, so project
 * entries win on collision).
 */
function scanRootDirs(root: string, index: Map<string, DirScanEntry>): void {
  for (const [dirName, artifactClass] of DIR_CLASSES) {
    const dirPath = join(root, dirName);
    for (const filename of readDirSafe(dirPath)) {
      indexOneFile({ artifactClass, dirPath, filename, index, root });
    }
  }
}

/**
 * buildCorpusArtifactLookup — builds the id→artifact index once, returns a
 * synchronous per-id lookup function. See module header for domain +
 * precedence + fail-open contract.
 */
export async function buildCorpusArtifactLookup(
  projectDir: string,
  pluginDir: string,
): Promise<CorpusArtifactLookup> {
  const principles = await loadAllPrinciples(projectDir, pluginDir);
  const principleById = new Map(principles.map((p) => [p.id, p]));

  const dirIndex = new Map<string, DirScanEntry>();
  scanRootDirs(projectDir, dirIndex);
  if (pluginDir !== projectDir) scanRootDirs(pluginDir, dirIndex);

  return (id: string): ResolvedCorpusArtifact | null => {
    const principle = principleById.get(id);
    if (principle) {
      const root = principle.source === "project" ? projectDir : pluginDir;
      const path = relative(root, principle.filePath).split(sep).join("/");
      try {
        return {
          artifact_class: "principle",
          body: readFileSync(principle.filePath, "utf-8"),
          path,
        };
      } catch {
        return null;
      }
    }

    const entry = dirIndex.get(id);
    if (!entry) return null;
    const path = relative(entry.root, entry.absPath).split(sep).join("/");
    try {
      return {
        artifact_class: entry.artifactClass,
        body: readFileSync(entry.absPath, "utf-8"),
        path,
      };
    } catch {
      return null;
    }
  };
}
