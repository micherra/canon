/**
 * TypeScript/JavaScript Tree-sitter Language Adapter
 *
 * Implements the LanguageAdapter interface for .ts, .tsx, .js, .jsx, .mjs, .cjs files.
 * Uses tree-sitter and tree-sitter-typescript to parse source files and extract
 * entities (functions, classes, methods, interfaces, type aliases, enums, variables)
 * and intra-file edges (calls, extends, implements, contains).
 */

import { extname } from "path";
import type { LanguageAdapter, AdapterResult, IntraFileEdge, ImportSpecifier } from "./kg-types.ts";
import type { EntityRow, EntityKind } from "./kg-types.ts";

import Parser from "tree-sitter";
import TypeScriptLang from "tree-sitter-typescript";

// Lazy-initialised parsers (one per language to avoid repeated setLanguage calls)
let tsParser: Parser | null = null;
let jsParser: Parser | null = null;

function getTsParser(): Parser {
  if (!tsParser) {
    tsParser = new Parser();
    tsParser.setLanguage(TypeScriptLang.typescript);
  }
  return tsParser;
}

function getJsParser(): Parser {
  if (!jsParser) {
    jsParser = new Parser();
    // tree-sitter-typescript also ships a javascript grammar as `.tsx`
    // but for plain JS we use it via the tsx grammar which handles JSX too.
    // Actually tree-sitter-typescript only ships typescript and tsx.
    // For JS/JSX we can use the tsx grammar (it's a superset of JS).
    jsParser = new Parser();
    jsParser.setLanguage(TypeScriptLang.tsx);
  }
  return jsParser;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RawEntity = Omit<EntityRow, "entity_id" | "file_id">;

/** True if any ancestor within the same statement is an export_statement */
function isExported(node: Parser.SyntaxNode): boolean {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === "export_statement") return true;
    // Don't traverse into unrelated parent scopes
    if (
      cur.type === "program" ||
      cur.type === "statement_block" ||
      cur.type === "class_body"
    ) {
      break;
    }
    cur = cur.parent;
  }
  return false;
}

function isDefaultExport(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "export_statement") {
    return parent.children.some((c) => c.type === "default");
  }
  return false;
}

function getText(node: Parser.SyntaxNode | null): string {
  return node ? node.text : "";
}

function getNameText(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  return nameNode ? nameNode.text : null;
}

/**
 * Extract parameter list as a signature string from a function-like node.
 * Returns "(param1, param2, ...)" or null if no parameter field is found.
 */
function extractSignature(node: Parser.SyntaxNode): string | null {
  const params = node.childForFieldName("parameters");
  return params ? params.text : null;
}

// ---------------------------------------------------------------------------
// Recursive AST walker
// ---------------------------------------------------------------------------

interface ParseContext {
  filePath: string;
  entities: RawEntity[];
  intraEdges: IntraFileEdge[];
  importSpecifiers: ImportSpecifier[];
  /** Stack of enclosing class names for method qualified names */
  classStack: string[];
}

function walkNode(node: Parser.SyntaxNode, ctx: ParseContext): void {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = getNameText(node);
      if (name) {
        const exported = isExported(node);
        const isDefault = isDefaultExport(node);
        const isAsync = node.children.some((c) => c.type === "async");
        const isGenerator = node.type === "generator_function_declaration";
        const qn = `${ctx.filePath}::${name}`;
        ctx.entities.push({
          name,
          qualified_name: qn,
          kind: "function",
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          is_exported: exported,
          is_default_export: isDefault,
          signature: extractSignature(node),
          metadata: JSON.stringify({ async: isAsync, generator: isGenerator }),
        });
        // Extract calls from this function body
        extractCalls(node, qn, ctx);
      }
      // Don't recurse into the function body for entity extraction
      return;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      // Arrow functions assigned to variables: const foo = () => { ... }
      // Also handle exported plain variable declarations
      const exported = isExported(node);
      const isConst = node.children.some((c) => c.type === "const");
      for (const declarator of node.children.filter(
        (c) => c.type === "variable_declarator",
      )) {
        const nameNode = declarator.childForFieldName("name");
        const valueNode = declarator.childForFieldName("value");
        if (!nameNode) continue;

        const varName = nameNode.text;
        const qn = `${ctx.filePath}::${varName}`;

        if (
          valueNode &&
          (valueNode.type === "arrow_function" ||
            valueNode.type === "function_expression")
        ) {
          // Treat as function entity
          const isAsync = valueNode.children.some((c) => c.type === "async");
          ctx.entities.push({
            name: varName,
            qualified_name: qn,
            kind: "function",
            line_start: node.startPosition.row + 1,
            line_end: node.endPosition.row + 1,
            is_exported: exported,
            is_default_export: isDefaultExport(node),
            signature: extractSignature(valueNode),
            metadata: JSON.stringify({ async: isAsync, generator: false }),
          });
          extractCalls(valueNode, qn, ctx);
        } else if (exported) {
          // Exported variable (non-function)
          ctx.entities.push({
            name: varName,
            qualified_name: qn,
            kind: "variable",
            line_start: node.startPosition.row + 1,
            line_end: node.endPosition.row + 1,
            is_exported: true,
            is_default_export: isDefaultExport(node),
            signature: null,
            metadata: JSON.stringify({ const: isConst }),
          });
        }
      }
      // Recurse for nested structures
      for (const child of node.children) {
        walkNode(child, ctx);
      }
      return;
    }

    case "class_declaration":
    case "abstract_class_declaration": {
      const name = getNameText(node);
      if (name) {
        const exported = isExported(node);
        const isAbstract = node.type === "abstract_class_declaration";
        const qn = `${ctx.filePath}::${name}`;
        ctx.entities.push({
          name,
          qualified_name: qn,
          kind: "class",
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          is_exported: exported,
          is_default_export: isDefaultExport(node),
          signature: null,
          metadata: JSON.stringify({ abstract: isAbstract }),
        });

        // extends clause
        const heritageNode = node.childForFieldName("body")
          ? node.children.find((c) => c.type === "class_heritage")
          : null;
        // Try to find extends/implements directly in node children
        for (const child of node.children) {
          if (child.type === "extends_clause") {
            const superName = getText(child.childForFieldName("value") ?? child.namedChildren[0]);
            if (superName) {
              ctx.intraEdges.push({
                source_qualified: qn,
                target_qualified: `${ctx.filePath}::${superName}`,
                edge_type: "extends",
                confidence: 0.9,
              });
            }
          }
          if (child.type === "implements_clause") {
            for (const impl of child.namedChildren) {
              const implName = impl.text;
              if (implName) {
                ctx.intraEdges.push({
                  source_qualified: qn,
                  target_qualified: `${ctx.filePath}::${implName}`,
                  edge_type: "implements",
                  confidence: 0.9,
                });
              }
            }
          }
        }
        // Avoid unused variable warning
        void heritageNode;

        // Walk class body for methods
        ctx.classStack.push(name);
        const body = node.childForFieldName("body");
        if (body) {
          walkNode(body, ctx);
        }
        ctx.classStack.pop();
      }
      return;
    }

    case "class_body": {
      for (const child of node.namedChildren) {
        walkNode(child, ctx);
      }
      return;
    }

    case "method_definition": {
      const nameNode = node.childForFieldName("name");
      const methodName = nameNode ? nameNode.text : null;
      const enclosingClass = ctx.classStack[ctx.classStack.length - 1];
      if (methodName && enclosingClass) {
        const isStatic = node.children.some((c) => c.type === "static");
        const isAsync = node.children.some((c) => c.type === "async");
        // Visibility modifiers (TypeScript)
        let visibility: "public" | "private" | "protected" = "public";
        for (const c of node.children) {
          if (c.type === "accessibility_modifier") {
            const v = c.text as "public" | "private" | "protected";
            if (v === "private" || v === "protected" || v === "public") {
              visibility = v;
            }
          }
        }
        const qn = `${ctx.filePath}::${enclosingClass}.${methodName}`;
        ctx.entities.push({
          name: methodName,
          qualified_name: qn,
          kind: "method",
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          is_exported: false, // methods inherit class exportedness
          is_default_export: false,
          signature: extractSignature(node),
          metadata: JSON.stringify({ static: isStatic, async: isAsync, visibility }),
        });
        extractCalls(node, qn, ctx);
      }
      return;
    }

    case "interface_declaration": {
      const name = getNameText(node);
      if (name) {
        const qn = `${ctx.filePath}::${name}`;
        ctx.entities.push({
          name,
          qualified_name: qn,
          kind: "interface",
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          is_exported: isExported(node),
          is_default_export: isDefaultExport(node),
          signature: null,
          metadata: null,
        });
      }
      return;
    }

    case "type_alias_declaration": {
      const name = getNameText(node);
      if (name) {
        const qn = `${ctx.filePath}::${name}`;
        ctx.entities.push({
          name,
          qualified_name: qn,
          kind: "type-alias",
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          is_exported: isExported(node),
          is_default_export: isDefaultExport(node),
          signature: null,
          metadata: null,
        });
      }
      return;
    }

    case "enum_declaration": {
      const name = getNameText(node);
      if (name) {
        const qn = `${ctx.filePath}::${name}`;
        ctx.entities.push({
          name,
          qualified_name: qn,
          kind: "enum",
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          is_exported: isExported(node),
          is_default_export: isDefaultExport(node),
          signature: null,
          metadata: null,
        });
      }
      return;
    }

    case "import_statement": {
      extractImport(node, ctx);
      return;
    }

    case "export_statement": {
      // Re-exports: export { foo } from './bar' or export * from './bar'
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) {
        // Has a `from` clause — it's a re-export
        const specifier = sourceNode.text.replace(/^['"]|['"]$/g, "");
        const names: string[] = [];
        const exportClause = node.children.find(
          (c) => c.type === "export_clause" || c.type === "namespace_export",
        );
        if (exportClause) {
          for (const spec of exportClause.namedChildren) {
            const localName = spec.childForFieldName("name") ?? spec.namedChildren[0];
            if (localName) names.push(localName.text);
          }
        }
        ctx.importSpecifiers.push({ specifier, names });
      }
      // Continue walking children to pick up exported declarations
      for (const child of node.namedChildren) {
        walkNode(child, ctx);
      }
      return;
    }

    default: {
      // Recurse for all other node types (program, statement_block, etc.)
      for (const child of node.namedChildren) {
        walkNode(child, ctx);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Call extraction
// ---------------------------------------------------------------------------

/** Recursively find all call_expression nodes inside a subtree */
function extractCalls(
  node: Parser.SyntaxNode,
  callerQn: string,
  ctx: ParseContext,
): void {
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (fn) {
      const calleeName = extractCalleeName(fn);
      if (calleeName) {
        ctx.intraEdges.push({
          source_qualified: callerQn,
          target_qualified: `${ctx.filePath}::${calleeName}`,
          edge_type: "calls",
          confidence: 0.8,
        });
      }
    }
  }
  for (const child of node.namedChildren) {
    extractCalls(child, callerQn, ctx);
  }
}

/** Extract a readable callee name from a call expression's function node */
function extractCalleeName(fn: Parser.SyntaxNode): string | null {
  if (fn.type === "identifier") {
    return fn.text;
  }
  if (fn.type === "member_expression" || fn.type === "optional_chain") {
    // e.g., obj.method or obj?.method
    const object = fn.childForFieldName("object");
    const property = fn.childForFieldName("property");
    if (object && property) {
      return `${object.text}.${property.text}`;
    }
    // Fallback: use full text (truncated for safety)
    return fn.text.slice(0, 120);
  }
  // For complex expressions (e.g. immediately invoked), skip
  return null;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImport(node: Parser.SyntaxNode, ctx: ParseContext): void {
  const sourceNode = node.childForFieldName("source");
  if (!sourceNode) return;
  const specifier = sourceNode.text.replace(/^['"]|['"]$/g, "");
  const names: string[] = [];

  for (const child of node.namedChildren) {
    if (child.type === "import_clause") {
      for (const clause of child.namedChildren) {
        if (clause.type === "identifier") {
          // default import: import Foo from '...'
          names.push(clause.text);
        } else if (clause.type === "named_imports") {
          // named imports: import { foo, bar } from '...'
          for (const spec of clause.namedChildren) {
            const aliasNode = spec.childForFieldName("alias");
            const nameNode = spec.childForFieldName("name") ?? spec.namedChildren[0];
            const resolved = aliasNode ?? nameNode;
            if (resolved) names.push(resolved.text);
          }
        } else if (clause.type === "namespace_import") {
          // namespace import: import * as ns from '...'
          const nsName = clause.namedChildren[0];
          if (nsName) names.push(`* as ${nsName.text}`);
        }
      }
    }
  }

  ctx.importSpecifiers.push({ specifier, names });
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

function parse(filePath: string, content: string): AdapterResult {
  const ext = extname(filePath).toLowerCase();
  const isTsFile = ext === ".ts" || ext === ".tsx";
  const parser = isTsFile ? getTsParser() : getJsParser();

  let tree: Parser.Tree;
  try {
    tree = parser.parse(content);
  } catch {
    // Return empty result if parsing fails (binary or corrupt file)
    return { entities: [], intraFileEdges: [], importSpecifiers: [] };
  }

  const ctx: ParseContext = {
    filePath,
    entities: [],
    intraEdges: [],
    importSpecifiers: [],
    classStack: [],
  };

  walkNode(tree.rootNode, ctx);

  // Build the file-entity "contains" edges
  const fileQn = filePath;
  const containsEdges: IntraFileEdge[] = ctx.entities.map((e) => ({
    source_qualified: fileQn,
    target_qualified: e.qualified_name,
    edge_type: "contains" as const,
    confidence: 1.0,
  }));

  return {
    entities: ctx.entities,
    intraFileEdges: [...containsEdges, ...ctx.intraEdges],
    importSpecifiers: ctx.importSpecifiers,
  };
}

// ---------------------------------------------------------------------------
// Exported adapter
// ---------------------------------------------------------------------------

export const typescriptAdapter: LanguageAdapter = {
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  parse,
};
