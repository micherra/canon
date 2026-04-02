/**
 * Language Configuration Maps for the Generic Tree-sitter Walker
 *
 * Each LanguageConfig is a declarative data object mapping semantic roles
 * (functionDef, classDef, …) to the tree-sitter grammar node type names for
 * that language. Optional ExtractionHooks provide language-specific logic for
 * cases the generic walker cannot handle uniformly.
 *
 * Information is encapsulated here so the generic walker (kg-generic-walker.ts)
 * never hard-codes language-specific node type names. Adding a new language is
 * a config entry, not a new adapter file.
 */

// ---------------------------------------------------------------------------
// Forward-reference types (defined fully in kg-generic-walker.ts / web-tree-sitter)
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a tree-sitter syntax node.
 * Matches the web-tree-sitter `Parser.SyntaxNode` API.
 * The generic walker imports the real type; configs only reference this shape.
 */
export interface SyntaxNode {
  type: string;
  text: string;
  parent: SyntaxNode | null;
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childForFieldName(fieldName: string): SyntaxNode | null;
  child(index: number): SyntaxNode | null;
  namedChild(index: number): SyntaxNode | null;
}

/**
 * Mutable accumulator passed through the walker to each hook.
 * Defined here as a minimal interface so configs can type-check their hooks.
 * The generic walker will extend/implement this interface.
 */
export interface WalkerContext {
  filePath: string;
  entities: Array<{
    name: string;
    qualified_name: string;
    kind: string;
    line_start: number;
    line_end: number;
    is_exported: boolean;
    is_default_export: boolean;
    signature: string | null;
    metadata: string | null;
  }>;
  intraEdges: Array<{
    source_qualified: string;
    target_qualified: string;
    edge_type: string;
    confidence?: number;
  }>;
  importSpecifiers: Array<{
    specifier: string;
    names: string[];
  }>;
  classStack: string[];
}

// ---------------------------------------------------------------------------
// Core config types
// ---------------------------------------------------------------------------

export interface NodeKindMap {
  /** Node types for top-level function definitions */
  functionDef: string[];
  /** Node types for class definitions */
  classDef: string[];
  /** Node types for method definitions (inside class bodies) */
  methodDef: string[];
  /** Node types for import statements */
  importStatement: string[];
  /** Node types for call expressions */
  callExpression: string[];
  /** Node types for variable/constant declarations */
  variableDecl: string[];
  /** Node types for export statements */
  exportStatement: string[];
  /** Node types for class body containers */
  classBody: string[];
}

export interface ExtractionHooks {
  /** Custom import extraction for languages with non-standard import syntax */
  extractImport?: (node: SyntaxNode, ctx: WalkerContext) => void;
  /** Custom entity/edge extraction for language-specific constructs */
  extractSpecial?: (node: SyntaxNode, ctx: WalkerContext) => void;
  /** Custom logic to determine if a node is exported */
  isExported?: (node: SyntaxNode) => boolean;
  /** Custom callee name extraction */
  extractCalleeName?: (fn: SyntaxNode) => string | null;
  /** Custom logic to get the name from a function/class node */
  getEntityName?: (node: SyntaxNode) => string | null;
}

export interface LanguageConfig {
  /** Unique identifier for this language config */
  id: string;
  /** File extensions handled by this config (e.g., ['.ts', '.tsx']) */
  extensions: string[];
  /** WASM grammar file name (relative to the grammars/ directory) */
  grammarFile: string;
  /** Mapping of semantic roles to grammar node type names */
  nodeKinds: NodeKindMap;
  /** Optional language-specific extraction hooks */
  hooks?: ExtractionHooks;
}

// ---------------------------------------------------------------------------
// TypeScript config
// Derived from kg-adapter-typescript.ts (typescript grammar only)
// ---------------------------------------------------------------------------

/** Collect the resolved name from a single named_import specifier. */
function resolvedNameFromImportSpec(spec: SyntaxNode): string | null {
  const aliasNode = spec.childForFieldName("alias");
  const nameNode = spec.childForFieldName("name") ?? spec.namedChildren[0];
  const resolved = aliasNode ?? nameNode;
  return resolved ? resolved.text : null;
}

/** Collect import names from a TS import_clause node. */
function collectTsImportNames(clause: SyntaxNode, names: string[]): void {
  for (const child of clause.namedChildren) {
    if (child.type === "identifier") {
      names.push(child.text);
    } else if (child.type === "named_imports") {
      collectNamedImports(child, names);
    } else if (child.type === "namespace_import") {
      const nsName = child.namedChildren[0];
      if (nsName) names.push(`* as ${nsName.text}`);
    }
  }
}

/** Collect names from a named_imports node (e.g. `{ foo, bar as baz }`). */
function collectNamedImports(namedImportsNode: SyntaxNode, names: string[]): void {
  for (const spec of namedImportsNode.namedChildren) {
    const resolved = resolvedNameFromImportSpec(spec);
    if (resolved) names.push(resolved);
  }
}

const typescriptConfig: LanguageConfig = {
  id: "typescript",
  extensions: [".ts"],
  grammarFile: "tree-sitter-typescript.wasm",
  nodeKinds: {
    functionDef: ["function_declaration", "generator_function_declaration"],
    classDef: ["class_declaration", "abstract_class_declaration"],
    methodDef: ["method_definition"],
    importStatement: ["import_statement"],
    callExpression: ["call_expression"],
    variableDecl: ["lexical_declaration", "variable_declaration"],
    exportStatement: ["export_statement"],
    classBody: ["class_body"],
  },
  hooks: {
    /**
     * Extract import specifiers from an import_statement node.
     * Handles: default imports, named imports, namespace imports.
     */
    extractImport(node: SyntaxNode, ctx: WalkerContext): void {
      const sourceNode = node.childForFieldName("source");
      if (!sourceNode) return;
      const specifier = sourceNode.text.replace(/^['"]|['"]$/g, "");
      const names: string[] = [];

      for (const child of node.namedChildren) {
        if (child.type === "import_clause") {
          collectTsImportNames(child, names);
        }
      }

      ctx.importSpecifiers.push({ specifier, names });
    },

    /**
     * Determine if a node is exported by checking for an export_statement ancestor.
     * Does not traverse into unrelated parent scopes.
     */
    isExported(node: SyntaxNode): boolean {
      let cur: SyntaxNode | null = node.parent;
      while (cur) {
        if (cur.type === "export_statement") return true;
        if (cur.type === "program" || cur.type === "statement_block" || cur.type === "class_body") {
          break;
        }
        cur = cur.parent;
      }
      return false;
    },

    /**
     * Extract TypeScript-specific constructs:
     * interface declarations, type alias declarations, enum declarations.
     */
    extractSpecial(node: SyntaxNode, ctx: WalkerContext): void {
      const specialKinds: Record<string, string> = {
        interface_declaration: "interface",
        type_alias_declaration: "type-alias",
        enum_declaration: "enum",
      };

      const kind = specialKinds[node.type];
      if (!kind) return;

      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;
      const name = nameNode.text;
      const qn = `${ctx.filePath}::${name}`;

      // Use the isExported hook for consistency
      let exported = false;
      let cur: SyntaxNode | null = node.parent;
      while (cur) {
        if (cur.type === "export_statement") {
          exported = true;
          break;
        }
        if (cur.type === "program" || cur.type === "statement_block" || cur.type === "class_body") break;
        cur = cur.parent;
      }

      ctx.entities.push({
        name,
        qualified_name: qn,
        kind,
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        is_exported: exported,
        is_default_export: false,
        signature: null,
        metadata: null,
      });
    },
  },
};

// ---------------------------------------------------------------------------
// TSX config
// Same node kinds as TypeScript, different grammar file (TSX is a superset).
// Handles .tsx, .js, .jsx, .mjs, .cjs — the tsx grammar parses all of these.
// ---------------------------------------------------------------------------

const tsxConfig: LanguageConfig = {
  id: "tsx",
  extensions: [".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  grammarFile: "tree-sitter-tsx.wasm",
  nodeKinds: {
    // Identical to TypeScript — TSX grammar uses the same node type names
    functionDef: ["function_declaration", "generator_function_declaration"],
    classDef: ["class_declaration", "abstract_class_declaration"],
    methodDef: ["method_definition"],
    importStatement: ["import_statement"],
    callExpression: ["call_expression"],
    variableDecl: ["lexical_declaration", "variable_declaration"],
    exportStatement: ["export_statement"],
    classBody: ["class_body"],
  },
  hooks: {
    // Reuse the same hook implementations as TypeScript
    extractImport: typescriptConfig.hooks!.extractImport,
    isExported: typescriptConfig.hooks!.isExported,
    extractSpecial: typescriptConfig.hooks!.extractSpecial,
  },
};

// ---------------------------------------------------------------------------
// Python config
// Derived from kg-adapter-python.ts
// ---------------------------------------------------------------------------

/** Collect specifiers from a Python `import foo` / `import foo.bar` statement. */
function collectPyImportStatement(node: SyntaxNode, ctx: WalkerContext): void {
  for (const child of node.namedChildren) {
    if (child.type !== "dotted_name" && child.type !== "aliased_import") continue;
    const nameNode = child.type === "aliased_import" ? child.childForFieldName("name") : child;
    if (!nameNode) continue;
    ctx.importSpecifiers.push({ specifier: nameNode.text, names: [nameNode.text] });
  }
}

/** Extract the imported name from a single Python import child node. */
function pyImportChildName(child: SyntaxNode): string | null {
  if (child.type === "wildcard_import") return "*";
  if (child.type === "dotted_name") return child.text;
  if (child.type === "aliased_import") {
    const nameNode = child.childForFieldName("name");
    return nameNode ? nameNode.text : null;
  }
  return null;
}

/** Collect specifiers from a Python `from foo import bar, baz` statement. */
function collectPyImportFromStatement(node: SyntaxNode, ctx: WalkerContext): void {
  const moduleNode = node.childForFieldName("module_name");
  const specifier = moduleNode ? moduleNode.text : "";
  const names: string[] = [];

  for (const child of node.namedChildren) {
    if (child === moduleNode) continue;
    const name = pyImportChildName(child);
    if (name) names.push(name);
  }

  if (specifier) {
    ctx.importSpecifiers.push({ specifier, names: names.length ? names : ["*"] });
  }
}

const pythonConfig: LanguageConfig = {
  id: "python",
  extensions: [".py"],
  grammarFile: "tree-sitter-python.wasm",
  nodeKinds: {
    functionDef: ["function_definition"],
    classDef: ["class_definition"],
    // Methods are function_definitions inside class bodies — same node type
    methodDef: ["function_definition"],
    importStatement: ["import_statement", "import_from_statement"],
    callExpression: ["call"],
    // Constants detected via expression_statement with assignment child (ALL_CAPS)
    variableDecl: ["expression_statement"],
    // Python has no export statements — all top-level names are implicitly exported
    exportStatement: [],
    classBody: ["block"],
  },
  hooks: {
    /**
     * Extract Python import specifiers.
     * Handles: `import foo`, `import foo.bar`, `from foo import bar, baz`, `from foo import *`.
     */
    extractImport(node: SyntaxNode, ctx: WalkerContext): void {
      if (node.type === "import_statement") {
        collectPyImportStatement(node, ctx);
        return;
      }
      if (node.type === "import_from_statement") {
        collectPyImportFromStatement(node, ctx);
      }
    },

    /**
     * Python: top-level names are considered exported.
     * A node is "exported" if its parent is the module root.
     */
    isExported(node: SyntaxNode): boolean {
      return node.parent?.type === "module";
    },

    /**
     * Extract Python-specific constructs:
     * - Decorator detection (decorated_definition)
     * - ALL_CAPS constant detection (expression_statement with assignment)
     */
    extractSpecial(node: SyntaxNode, ctx: WalkerContext): void {
      // ALL_CAPS constant assignments at module level
      if (node.type === "expression_statement" && node.parent?.type === "module") {
        const assignment = node.namedChildren[0];
        if (assignment?.type === "assignment") {
          const lhs = assignment.childForFieldName("left");
          if (lhs?.type === "identifier" && /^[A-Z][A-Z0-9_]*$/.test(lhs.text)) {
            const name = lhs.text;
            ctx.entities.push({
              name,
              qualified_name: `${ctx.filePath}::${name}`,
              kind: "variable",
              line_start: node.startPosition.row + 1,
              line_end: node.endPosition.row + 1,
              is_exported: true,
              is_default_export: false,
              signature: null,
              metadata: null,
            });
          }
        }
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Bash config
// Derived from kg-adapter-bash.ts
// ---------------------------------------------------------------------------

const bashConfig: LanguageConfig = {
  id: "bash",
  extensions: [".sh"],
  grammarFile: "tree-sitter-bash.wasm",
  nodeKinds: {
    functionDef: ["function_definition"],
    // Bash has no classes, methods, imports, variables, or exports
    classDef: [],
    methodDef: [],
    // Imports handled via extractImport hook (source/. commands)
    importStatement: [],
    callExpression: ["command"],
    variableDecl: [],
    exportStatement: [],
    classBody: [],
  },
  hooks: {
    /**
     * Extract Bash import specifiers from `source ./file.sh` or `. ./file.sh` commands.
     */
    extractImport(node: SyntaxNode, ctx: WalkerContext): void {
      if (node.type !== "command") return;
      const nameNode = node.childForFieldName("name") ?? node.children[0];
      if (!nameNode) return;
      const cmdName = nameNode.text.trim();

      if (cmdName === "source" || cmdName === ".") {
        const argNode = node.childForFieldName("argument") ?? node.children[1];
        if (argNode) {
          const specifier = argNode.text.trim().replace(/^['"]|['"]$/g, "");
          if (specifier) {
            ctx.importSpecifiers.push({ specifier, names: ["*"] });
          }
        }
      }
    },

    /**
     * Extract Bash call edges from command nodes.
     * A command that matches a defined function name produces a calls edge.
     */
    extractSpecial(node: SyntaxNode, ctx: WalkerContext): void {
      if (node.type !== "command") return;
      const nameNode = node.childForFieldName("name") ?? node.children[0];
      if (!nameNode) return;
      const cmdName = nameNode.text.trim();

      // Determine enclosing function for the call edge source
      let ancestor: SyntaxNode | null = node.parent;
      let enclosingFunc: string | null = null;
      while (ancestor) {
        if (ancestor.type === "function_definition") {
          const fnNameNode = ancestor.childForFieldName("name") ?? ancestor.children[0];
          if (fnNameNode) enclosingFunc = fnNameNode.text.trim();
          break;
        }
        ancestor = ancestor.parent;
      }

      const sourceQualified = enclosingFunc ? `${ctx.filePath}::${enclosingFunc}` : ctx.filePath;
      const targetQualified = `${ctx.filePath}::${cmdName}`;

      if (sourceQualified !== targetQualified) {
        ctx.intraEdges.push({
          source_qualified: sourceQualified,
          target_qualified: targetQualified,
          edge_type: "calls",
          confidence: 0.9,
        });
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Java import helpers
// ---------------------------------------------------------------------------

/** Collect scoped_identifier, identifier, and asterisk parts from a Java import_declaration. */
function collectJavaImportParts(node: SyntaxNode): string[] {
  const parts: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "scoped_identifier" || child.type === "identifier") {
      parts.push(child.text);
    } else if (child.type === "asterisk") {
      parts.push("*");
    }
  }
  return parts;
}

/** Split a dotted import path into { specifier, name } at the last dot. */
function splitJavaImportPath(fullPath: string): { specifier: string; name: string } {
  const lastDot = fullPath.lastIndexOf(".");
  const specifier = lastDot >= 0 ? fullPath.slice(0, lastDot) : fullPath;
  const name = lastDot >= 0 ? fullPath.slice(lastDot + 1) : fullPath;
  return { specifier, name };
}

/** Fallback: parse a Java import from raw node text when no structured parts found. */
function pushJavaImportFallback(node: SyntaxNode, ctx: WalkerContext): void {
  const raw = node.text
    .replace(/^import\s+/, "")
    .replace(/;$/, "")
    .trim();
  if (!raw) return;
  const { specifier, name } = splitJavaImportPath(raw);
  ctx.importSpecifiers.push({ specifier, names: [name] });
}

// ---------------------------------------------------------------------------
// Java config
// ---------------------------------------------------------------------------

const javaConfig: LanguageConfig = {
  id: "java",
  extensions: [".java"],
  grammarFile: "tree-sitter-java.wasm",
  nodeKinds: {
    // Java has no top-level functions; all methods belong to classes
    functionDef: [],
    classDef: ["class_declaration", "interface_declaration", "enum_declaration"],
    methodDef: ["method_declaration", "constructor_declaration"],
    importStatement: ["import_declaration"],
    callExpression: ["method_invocation"],
    variableDecl: ["field_declaration", "local_variable_declaration"],
    // Java uses access modifiers (public/private/protected), not export statements
    exportStatement: [],
    classBody: ["class_body", "interface_body", "enum_body"],
  },
  hooks: {
    /**
     * Extract Java import declarations.
     * Handles: `import com.example.Foo;` and `import com.example.*;`
     */
    extractImport(node: SyntaxNode, ctx: WalkerContext): void {
      if (node.type !== "import_declaration") return;

      const parts = collectJavaImportParts(node);

      if (parts.length === 0) {
        pushJavaImportFallback(node, ctx);
        return;
      }

      const fullPath = parts.join(".");
      const { specifier, name } = splitJavaImportPath(fullPath);
      ctx.importSpecifiers.push({ specifier, names: [name] });
    },

    /**
     * Java: a node is "exported" if it has a `public` modifier.
     * Checks the modifiers child for a `public` modifier node.
     */
    isExported(node: SyntaxNode): boolean {
      for (const child of node.children) {
        if (child.type === "modifiers") {
          for (const mod of child.children) {
            if (mod.type === "public") return true;
          }
        }
        // Some grammars put modifier keywords as direct children
        if (child.type === "public") return true;
      }
      return false;
    },

    /**
     * Extract Java-specific constructs:
     * - Annotation type declarations (`@interface`)
     * - Enum constants (inside enum bodies)
     */
    extractSpecial(node: SyntaxNode, ctx: WalkerContext): void {
      if (node.type === "annotation_type_declaration") {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const name = nameNode.text;
        ctx.entities.push({
          name,
          qualified_name: `${ctx.filePath}::@${name}`,
          kind: "interface",
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          is_exported: false,
          is_default_export: false,
          signature: null,
          metadata: JSON.stringify({ annotation: true }),
        });
        return;
      }

      if (node.type === "enum_constant") {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const name = nameNode.text;
        const enclosingClass = ctx.classStack[ctx.classStack.length - 1];
        const qn = enclosingClass ? `${ctx.filePath}::${enclosingClass}.${name}` : `${ctx.filePath}::${name}`;
        ctx.entities.push({
          name,
          qualified_name: qn,
          kind: "variable",
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          is_exported: true, // enum constants are always accessible
          is_default_export: false,
          signature: null,
          metadata: JSON.stringify({ enumConstant: true }),
        });
      }
    },

    /**
     * Java naming conventions: extract the simple name from a declaration node.
     * Returns the text of the 'name' field child.
     */
    getEntityName(node: SyntaxNode): string | null {
      const nameNode = node.childForFieldName("name");
      return nameNode ? nameNode.text : null;
    },
  },
};

// ---------------------------------------------------------------------------
// Config registry
// ---------------------------------------------------------------------------

/**
 * All language configs keyed by language ID.
 * Used by the generic walker to look up configs by language.
 */
export const LANGUAGE_CONFIGS: Map<string, LanguageConfig> = new Map([
  ["typescript", typescriptConfig],
  ["tsx", tsxConfig],
  ["python", pythonConfig],
  ["bash", bashConfig],
  ["java", javaConfig],
]);

/**
 * Extension-to-config lookup map, built from all registered language configs.
 * Resolves at module load time for O(1) lookups at parse time.
 */
const EXT_TO_CONFIG: Map<string, LanguageConfig> = new Map();
for (const config of LANGUAGE_CONFIGS.values()) {
  for (const ext of config.extensions) {
    EXT_TO_CONFIG.set(ext, config);
  }
}

/**
 * Return the LanguageConfig for a given file extension, or undefined if
 * no config handles that extension.
 *
 * @param ext - File extension including the leading dot (e.g., '.ts', '.py')
 */
export function getConfigForExtension(ext: string): LanguageConfig | undefined {
  return EXT_TO_CONFIG.get(ext);
}
