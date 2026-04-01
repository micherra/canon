import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Board, ContextInjection } from "./flow-schema.ts";

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
      hitl = { prompt: injection.prompt ?? "Please provide input", as: injection.as };
      continue;
    }

    const resolved = await resolveStateInjection(injection, board, workspace);
    warnings.push(...resolved.warnings);
    if (resolved.value !== undefined) {
      variables[injection.as] = resolved.value;
    }
  }

  return { variables, hitl, warnings };
}

async function resolveStateInjection(
  injection: ContextInjection,
  board: Board,
  workspace: string,
): Promise<{ value?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const sourceState = board.states[injection.from];

  if (!sourceState) {
    warnings.push(`inject_context: source state "${injection.from}" not found in board`);
    return { warnings };
  }

  const artifacts = sourceState.artifacts ?? [];
  if (artifacts.length === 0) {
    warnings.push(`inject_context: state "${injection.from}" has no artifacts`);
    return { warnings };
  }

  const { contents, anyFound, warnings: readWarnings } = await readArtifacts(artifacts, workspace, injection.from);
  warnings.push(...readWarnings);

  if (!anyFound) {
    warnings.push(`inject_context: all artifacts from state "${injection.from}" are missing`);
    return { warnings };
  }

  let result = contents.join("\n\n");

  if (injection.section) {
    const extracted = extractSection(result, injection.section);
    if (extracted !== null) {
      result = extracted;
    } else {
      warnings.push(
        `inject_context: section "${injection.section}" not found in artifacts from "${injection.from}" — injecting full content`,
      );
    }
  }

  return { value: result, warnings };
}

async function readArtifacts(
  artifacts: string[],
  workspace: string,
  stateName: string,
): Promise<{ contents: string[]; anyFound: boolean; warnings: string[] }> {
  const contents: string[] = [];
  const warnings: string[] = [];
  let anyFound = false;
  const workspaceRoot = path.resolve(workspace);

  for (const artifactPath of artifacts) {
    const fullPath = path.resolve(workspace, artifactPath);
    if (!fullPath.startsWith(workspaceRoot + path.sep) && fullPath !== workspaceRoot) {
      warnings.push(`inject_context: artifact path "${artifactPath}" escapes workspace — blocked`);
      continue;
    }
    if (!existsSync(fullPath)) {
      warnings.push(`inject_context: artifact "${artifactPath}" from state "${stateName}" not found on disk`);
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

  return { contents, anyFound, warnings };
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
