import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Board, ContextInjection } from "./flow-schema.js";

interface InjectionResult {
  variables: Record<string, string>;
  hitl?: { prompt: string; as: string };
  warnings: string[];
}

export async function resolveContextInjections(
  injections: ContextInjection[],
  board: Board,
  workspace: string,
): Promise<InjectionResult> {
  const variables: Record<string, string> = {};
  const warnings: string[] = [];
  let hitl: { prompt: string; as: string } | undefined;

  for (const injection of injections) {
    if (injection.from === "user") {
      // User injection requires HITL pause
      hitl = { prompt: injection.prompt ?? "Please provide input", as: injection.as };
      continue;
    }

    // State injection: read artifacts from the source state
    const sourceState = board.states[injection.from];
    if (!sourceState) {
      warnings.push(`inject_context: source state "${injection.from}" not found in board`);
      continue;
    }

    const artifacts = sourceState.artifacts ?? [];
    if (artifacts.length === 0) {
      warnings.push(`inject_context: state "${injection.from}" has no artifacts`);
      continue;
    }

    // Read all artifacts and concatenate
    const contents: string[] = [];
    let anyFound = false;
    const workspaceRoot = path.resolve(workspace);
    for (const artifactPath of artifacts) {
      const fullPath = path.resolve(workspace, artifactPath);
      if (!fullPath.startsWith(workspaceRoot + path.sep) && fullPath !== workspaceRoot) {
        warnings.push(`inject_context: artifact path "${artifactPath}" escapes workspace — blocked`);
        continue;
      }
      if (!existsSync(fullPath)) {
        warnings.push(`inject_context: artifact "${artifactPath}" from state "${injection.from}" not found on disk`);
        continue;
      }
      try {
        const content = await readFile(fullPath, "utf-8");
        contents.push(content);
        anyFound = true;
      } catch {
        warnings.push(`inject_context: failed to read artifact "${artifactPath}"`);
      }
    }

    if (!anyFound) {
      warnings.push(`inject_context: all artifacts from state "${injection.from}" are missing`);
      continue;
    }

    let result = contents.join("\n\n");

    // Extract section if specified
    if (injection.section) {
      const extracted = extractSection(result, injection.section);
      if (extracted !== null) {
        result = extracted;
      } else {
        warnings.push(`inject_context: section "${injection.section}" not found in artifacts from "${injection.from}" — injecting full content`);
      }
    }

    variables[injection.as] = result;
  }

  return { variables, hitl, warnings };
}

/**
 * Extract content under a markdown heading (any level).
 * Returns content from the heading to the next heading of same or higher level, or end of string.
 * Returns null if heading not found.
 */
export function extractSection(markdown: string, sectionName: string): string | null {
  const lines = markdown.split("\n");
  let capturing = false;
  let captureLevel = 0;
  const captured: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim().toLowerCase();

      if (!capturing && title === sectionName.toLowerCase()) {
        capturing = true;
        captureLevel = level;
        captured.push(line);
        continue;
      }

      if (capturing && level <= captureLevel) {
        break; // Next heading of same or higher level
      }
    }

    if (capturing) {
      captured.push(line);
    }
  }

  return captured.length > 0 ? captured.join("\n").trim() : null;
}
