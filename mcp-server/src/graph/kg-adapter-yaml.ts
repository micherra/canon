/**
 * YAML Language Adapter
 *
 * Parses YAML files in the Canon project:
 * - flows/*.yaml -> flow entities
 * - flows/fragments/*.yaml -> flow-fragment entities
 * - hooks/*.yaml -> hook entities
 */

import { parse as parseYaml } from "yaml";
import type { AdapterResult, LanguageAdapter } from "./kg-types.ts";

/** Classify entity kind and collect metadata from file path and parsed data */
function classifyEntity(
  filePath: string,
  data: Record<string, unknown>,
): { kind: "flow" | "flow-fragment" | "hook" | "file"; metadata: Record<string, unknown> } {
  // Normalize to forward slashes for pattern matching
  const normalized = filePath.replace(/\\/g, "/");

  if (/flows\/fragments\/[^/]+\.ya?ml$/.test(normalized)) {
    const states = data.states && typeof data.states === "object" ? Object.keys(data.states) : [];
    return { kind: "flow-fragment", metadata: { states } };
  }

  if (/flows\/[^/]+\.ya?ml$/.test(normalized)) {
    const tier = typeof data.tier === "string" ? data.tier : undefined;
    const states = data.states && typeof data.states === "object" ? Object.keys(data.states) : [];
    return { kind: "flow", metadata: tier !== undefined ? { tier, states } : { states } };
  }

  if (/hooks\/[^/]+\.ya?ml$/.test(normalized)) {
    const trigger = typeof data.trigger === "string" ? data.trigger : undefined;
    return { kind: "hook", metadata: trigger !== undefined ? { trigger } : {} };
  }

  return { kind: "file", metadata: {} };
}

/** Extract fragment include specifiers from a flow's includes array. */
function extractFragmentIncludes(includes: unknown, specifiers: Array<{ specifier: string; names: string[] }>): void {
  if (!Array.isArray(includes)) return;
  for (const inc of includes) {
    if (!inc || typeof inc !== "object") continue;
    const fragment = (inc as Record<string, unknown>).fragment;
    if (typeof fragment === "string") {
      specifiers.push({ specifier: fragment, names: ["fragment"] });
    }
  }
}

/** Extract agent and template specifiers from a single state object. */
function extractStateSpecifiers(
  state: Record<string, unknown>,
  specifiers: Array<{ specifier: string; names: string[] }>,
): void {
  if (typeof state.agent === "string") {
    specifiers.push({ specifier: state.agent, names: ["agent"] });
  }

  if (typeof state.template === "string") {
    specifiers.push({ specifier: state.template, names: ["template"] });
    return;
  }

  if (Array.isArray(state.template)) {
    for (const tmpl of state.template) {
      if (typeof tmpl === "string") {
        specifiers.push({ specifier: tmpl, names: ["template"] });
      }
    }
  }
}

/** Extract import specifiers from a flow's states and includes */
function extractImportSpecifiers(data: Record<string, unknown>): Array<{ specifier: string; names: string[] }> {
  const specifiers: Array<{ specifier: string; names: string[] }> = [];

  extractFragmentIncludes(data.includes, specifiers);

  const states = data.states;
  if (!states || typeof states !== "object" || Array.isArray(states)) return specifiers;

  for (const stateVal of Object.values(states as Record<string, unknown>)) {
    if (!stateVal || typeof stateVal !== "object") continue;
    extractStateSpecifiers(stateVal as Record<string, unknown>, specifiers);
  }

  return specifiers;
}

export const yamlAdapter: LanguageAdapter = {
  extensions: [".yaml", ".yml"],

  parse(filePath: string, content: string): AdapterResult {
    let data: Record<string, unknown>;
    try {
      const parsed = parseYaml(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { entities: [], intraFileEdges: [], importSpecifiers: [] };
      }
      data = parsed as Record<string, unknown>;
    } catch {
      // Return empty result on parse errors
      return { entities: [], intraFileEdges: [], importSpecifiers: [] };
    }

    const { kind, metadata } = classifyEntity(filePath, data);

    // Derive a human-readable name from the file path (basename without extension)
    const baseName =
      filePath
        .replace(/\\/g, "/")
        .split("/")
        .pop()
        ?.replace(/\.ya?ml$/, "") ?? filePath;

    // Qualified name includes the path for uniqueness
    const qualifiedName = filePath;

    const entity: AdapterResult["entities"][number] = {
      name: baseName,
      qualified_name: qualifiedName,
      kind,
      line_start: 1,
      line_end: content.split("\n").length,
      is_exported: true,
      is_default_export: false,
      signature: null,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
    };

    // file -> entity "contains" edge
    const intraFileEdges: AdapterResult["intraFileEdges"] = [
      {
        source_qualified: filePath,
        target_qualified: qualifiedName,
        edge_type: "contains",
        confidence: 1.0,
      },
    ];

    // Only extract import specifiers for flow and flow-fragment kinds
    const importSpecifiers: AdapterResult["importSpecifiers"] =
      kind === "flow" || kind === "flow-fragment" ? extractImportSpecifiers(data) : [];

    return {
      entities: [entity],
      intraFileEdges,
      importSpecifiers,
    };
  },
};
