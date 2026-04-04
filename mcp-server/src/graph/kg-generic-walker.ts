/**
 * Generic Config-Driven AST Tree Walker
 *
 * A single AST walker that replaces all per-language adapters.
 * Callers provide a parsed tree and a LanguageConfig; this module
 * extracts entities and edges using the config's node-kind maps and hooks.
 *
 * Information hiding: all knowledge about how to extract entities from a
 * tree-sitter AST is in this one module. No other module knows about node
 * types, field names, or tree-walking strategies.
 *
 * Deep module: walkTree() is a single function with a simple signature that
 * hides ~300 lines of complex AST walking logic.
 */

import type { Node, Tree } from "web-tree-sitter";
import type { LanguageConfig, SyntaxNode, WalkerContext } from "./kg-language-configs.ts";
import type { AdapterResult, EdgeType, EntityKind, IntraFileEdge } from "./kg-types.ts";

/**
 * Walk a parsed syntax tree and extract entities, intra-file edges, and
 * import specifiers according to the given LanguageConfig.
 *
 * @param tree     - A parsed tree-sitter Tree object
 * @param filePath - Absolute or relative path used as entity qualifier prefix
 * @param config   - Language configuration with node-kind maps and optional hooks
 * @returns        AdapterResult with entities, intraFileEdges, and importSpecifiers
 */
export function walkTree(
  tree: Tree | null,
  filePath: string,
  config: LanguageConfig,
): AdapterResult {
  // Guard against null tree (web-tree-sitter parse() can return null on failure)
  if (!tree) {
    return { entities: [], importSpecifiers: [], intraFileEdges: [] };
  }

  const ctx: WalkerContext = {
    classStack: [],
    entities: [],
    filePath,
    importSpecifiers: [],
    intraEdges: [],
  };

  const root = tree.rootNode;
  if (root) {
    visitNode(root, ctx, config);
  }

  // Build file → entity "contains" edges
  const containsEdges: IntraFileEdge[] = ctx.entities.map((e) => ({
    confidence: 1.0,
    edge_type: "contains" as const,
    source_qualified: filePath,
    target_qualified: e.qualified_name,
  }));

  // Cast from the looser WalkerContext string types to the strict AdapterResult types.
  // Language configs and hooks use plain string to avoid importing kg-types.ts;
  // the generic walker is the only place that bridges the two type systems.
  return {
    entities: ctx.entities.map((e) => ({
      ...e,
      kind: e.kind as EntityKind,
    })),
    importSpecifiers: ctx.importSpecifiers,
    intraFileEdges: [
      ...containsEdges,
      ...ctx.intraEdges.map((edge) => ({
        ...edge,
        edge_type: edge.edge_type as EdgeType,
      })),
    ],
  };
}

// Core recursive visitor

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tree-sitter node visitor must dispatch on many node types in one place
function visitNode(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  const { nodeKinds, hooks } = config;
  const kind = node.type;

  // --- Language-specific special constructs (called for every node) ---
  // Must come before other handlers so hooks like TS interface/enum work.
  if (hooks?.extractSpecial) {
    hooks.extractSpecial(node as unknown as SyntaxNode, ctx);
  }

  // --- Import hook (called for every node; hook filters by type internally) ---
  // This pattern supports languages like Bash where imports come from
  // command nodes that are not in nodeKinds.importStatement.
  if (hooks?.extractImport) {
    if (nodeKinds.importStatement.includes(kind) || nodeKinds.importStatement.length === 0) {
      hooks.extractImport(node as unknown as SyntaxNode, ctx);
    }
  }

  // --- Standard import statements (no custom hook) ---
  if (nodeKinds.importStatement.includes(kind) && !hooks?.extractImport) {
    extractDefaultImport(node, ctx);
    return;
  }

  // --- Function definitions (top-level only, not inside class body) ---
  if (nodeKinds.functionDef.includes(kind) && ctx.classStack.length === 0) {
    extractFunctionEntity(node, ctx, config);
    return; // stop recursing into function body for entity extraction
  }

  // --- Class definitions ---
  if (nodeKinds.classDef.includes(kind)) {
    extractClassEntity(node, ctx, config);
    return; // class handler walks its own body
  }

  // --- Class body containers ---
  if (nodeKinds.classBody.includes(kind)) {
    for (const child of node.namedChildren) {
      visitNode(child, ctx, config);
    }
    return;
  }

  // --- Method definitions (only when inside a class) ---
  if (nodeKinds.methodDef.includes(kind) && ctx.classStack.length > 0) {
    extractMethodEntity(node, ctx, config);
    return;
  }

  // --- Export statements ---
  if (nodeKinds.exportStatement.includes(kind)) {
    extractExportStatement(node, ctx, config);
    return;
  }

  // --- Variable declarations ---
  if (nodeKinds.variableDecl.includes(kind)) {
    extractVariableDecl(node, ctx, config);
    // Fall through to recurse for nested structures
  }

  // --- Default: recurse into all named children ---
  for (const child of node.namedChildren) {
    visitNode(child, ctx, config);
  }
}

// Entity extraction helpers

function extractFunctionEntity(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  const { hooks } = config;
  const name = hooks?.getEntityName
    ? hooks.getEntityName(node as unknown as SyntaxNode)
    : (node.childForFieldName("name")?.text ?? null);

  if (!name) return;

  // Language-specific export detection; fallback handles TS export_statement,
  // Python module-level, and languages with exportStatement: [] (Bash).
  const exported = hooks?.isExported
    ? hooks.isExported(node as unknown as SyntaxNode)
    : defaultIsExported(node, config);

  const isDefault = defaultIsDefaultExport(node);
  const isAsync = node.children.some((c) => c.type === "async");
  const isGenerator = node.type.includes("generator");
  const qn = `${ctx.filePath}::${name}`;

  ctx.entities.push({
    is_default_export: isDefault,
    is_exported: exported,
    kind: "function",
    line_end: node.endPosition.row + 1,
    line_start: node.startPosition.row + 1,
    metadata: JSON.stringify({ async: isAsync, generator: isGenerator }),
    name,
    qualified_name: qn,
    signature: node.childForFieldName("parameters")?.text ?? null,
  });

  // Extract calls from function body
  extractCalls(node, qn, ctx, config);
}

/** Visit all named children of a body node, or the body itself if it's not a class body type. */
function visitBodyNode(bodyNode: Node, ctx: WalkerContext, config: LanguageConfig): void {
  if (config.nodeKinds.classBody.includes(bodyNode.type)) {
    for (const child of bodyNode.namedChildren) {
      visitNode(child, ctx, config);
    }
  } else {
    visitNode(bodyNode, ctx, config);
  }
}

/** Walk a class body node, visiting its children. */
function walkClassBody(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  const bodyNode = node.childForFieldName("body");
  if (bodyNode) {
    visitBodyNode(bodyNode, ctx, config);
    return;
  }

  for (const child of node.children) {
    if (config.nodeKinds.classBody.includes(child.type)) {
      for (const bodyChild of child.namedChildren) {
        visitNode(bodyChild, ctx, config);
      }
      break;
    }
  }
}

function extractClassEntity(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  const { hooks } = config;
  const name = hooks?.getEntityName
    ? hooks.getEntityName(node as unknown as SyntaxNode)
    : (node.childForFieldName("name")?.text ?? null);

  if (!name) return;

  const exported = hooks?.isExported
    ? hooks.isExported(node as unknown as SyntaxNode)
    : defaultIsExported(node, config);

  const qn = `${ctx.filePath}::${name}`;

  ctx.entities.push({
    is_default_export: defaultIsDefaultExport(node),
    is_exported: exported,
    kind: "class",
    line_end: node.endPosition.row + 1,
    line_start: node.startPosition.row + 1,
    metadata: JSON.stringify({ abstract: node.type.includes("abstract") }),
    name,
    qualified_name: qn,
    signature: null,
  });

  extractHeritageEdges(node, qn, ctx);

  ctx.classStack.push(name);
  walkClassBody(node, ctx, config);
  ctx.classStack.pop();
}

/**
 * Extract extends/implements edges from a class declaration node.
 *
 * TypeScript: class_heritage > extends_clause / implements_clause
 * Python: superclasses field > argument_list with identifiers
 */
/** Push an extends edge from classQn to a superclass name. */
function pushExtendsEdge(ctx: WalkerContext, classQn: string, clauseNode: Node): void {
  const superName = (clauseNode.childForFieldName("value") ?? clauseNode.namedChildren[0])?.text;
  if (!superName) return;
  ctx.intraEdges.push({
    confidence: 0.9,
    edge_type: "extends",
    source_qualified: classQn,
    target_qualified: `${ctx.filePath}::${superName}`,
  });
}

/** Push implements edges from classQn for each named child in the clause. */
function pushImplementsEdges(ctx: WalkerContext, classQn: string, clauseNode: Node): void {
  for (const impl of clauseNode.namedChildren) {
    if (!impl.text) continue;
    ctx.intraEdges.push({
      confidence: 0.9,
      edge_type: "implements",
      source_qualified: classQn,
      target_qualified: `${ctx.filePath}::${impl.text}`,
    });
  }
}

/** Process a single heritage-related child node (extends_clause, implements_clause, class_heritage). */
function processHeritageChild(child: Node, classQn: string, ctx: WalkerContext): void {
  if (child.type === "class_heritage") {
    for (const hChild of child.children) {
      if (hChild.type === "extends_clause") pushExtendsEdge(ctx, classQn, hChild);
      if (hChild.type === "implements_clause") pushImplementsEdges(ctx, classQn, hChild);
    }
    return;
  }
  if (child.type === "extends_clause") pushExtendsEdge(ctx, classQn, child);
  if (child.type === "implements_clause") pushImplementsEdges(ctx, classQn, child);
}

/** Extract Python superclasses (superclasses field). */
function extractPythonSuperclasses(node: Node, classQn: string, ctx: WalkerContext): void {
  const superclassesNode = node.childForFieldName("superclasses");
  if (!superclassesNode) return;
  for (const baseNode of superclassesNode.namedChildren) {
    if (baseNode.type === "identifier" || baseNode.type === "attribute") {
      ctx.intraEdges.push({
        confidence: 0.9,
        edge_type: "extends",
        source_qualified: classQn,
        target_qualified: `${ctx.filePath}::${baseNode.text}`,
      });
    }
  }
}

function extractHeritageEdges(node: Node, classQn: string, ctx: WalkerContext): void {
  for (const child of node.children) {
    processHeritageChild(child, classQn, ctx);
  }
  extractPythonSuperclasses(node, classQn, ctx);
}

/** Check if a decorated parent has @staticmethod (Python). */
function hasStaticmethodDecorator(node: Node): boolean {
  const parent = node.parent;
  if (parent?.type !== "decorated_definition") return false;
  return parent.namedChildren.some(
    (dec) => dec.type === "decorator" && dec.text.includes("staticmethod"),
  );
}

/** Check Java-style modifiers node for visibility. */
function visibilityFromModifiers(modifiersNode: Node): string | null {
  for (const mod of modifiersNode.children) {
    if (mod.type === "private" || mod.text === "private") return "private";
    if (mod.type === "protected" || mod.text === "protected") return "protected";
    if (mod.type === "public" || mod.text === "public") return "public";
  }
  return null;
}

/** Determine method visibility from child nodes (TypeScript/Java). */
function resolveVisibility(node: Node): string {
  for (const c of node.children) {
    if (c.type === "accessibility_modifier") {
      const v = c.text;
      if (v === "private" || v === "protected" || v === "public") return v;
    }
    if (c.type === "modifiers") {
      const vis = visibilityFromModifiers(c);
      if (vis) return vis;
    }
  }
  return "public";
}

function extractMethodEntity(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  const { hooks } = config;
  const enclosingClass = ctx.classStack[ctx.classStack.length - 1];
  if (!enclosingClass) return;

  const methodName = hooks?.getEntityName
    ? hooks.getEntityName(node as unknown as SyntaxNode)
    : (node.childForFieldName("name")?.text ?? null);
  if (!methodName) return;

  const isStatic = node.children.some((c) => c.type === "static") || hasStaticmethodDecorator(node);
  const isAsync = node.children.some((c) => c.type === "async");
  const visibility = resolveVisibility(node);
  const exported = hooks?.isExported ? hooks.isExported(node as unknown as SyntaxNode) : false;
  const qn = `${ctx.filePath}::${enclosingClass}.${methodName}`;

  ctx.entities.push({
    is_default_export: false,
    is_exported: exported,
    kind: "method",
    line_end: node.endPosition.row + 1,
    line_start: node.startPosition.row + 1,
    metadata: JSON.stringify({ async: isAsync, static: isStatic, visibility }),
    name: methodName,
    qualified_name: qn,
    signature: node.childForFieldName("parameters")?.text ?? null,
  });

  extractCalls(node, qn, ctx, config);
}

// Variable declaration extraction

function extractVariableDecl(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  const { hooks } = config;

  const exported = hooks?.isExported
    ? hooks.isExported(node as unknown as SyntaxNode)
    : defaultIsExported(node, config);

  const isConst = node.children.some((c) => c.type === "const");

  for (const declarator of node.children.filter((c) => c.type === "variable_declarator")) {
    const nameNode = declarator.childForFieldName("name");
    const valueNode = declarator.childForFieldName("value");
    if (!nameNode) continue;

    const varName = nameNode.text;
    const qn = `${ctx.filePath}::${varName}`;

    if (
      valueNode &&
      (valueNode.type === "arrow_function" || valueNode.type === "function_expression")
    ) {
      const isAsync = valueNode.children.some((c) => c.type === "async");
      ctx.entities.push({
        is_default_export: defaultIsDefaultExport(node),
        is_exported: exported,
        kind: "function",
        line_end: node.endPosition.row + 1,
        line_start: node.startPosition.row + 1,
        metadata: JSON.stringify({ async: isAsync, generator: false }),
        name: varName,
        qualified_name: qn,
        signature: valueNode.childForFieldName("parameters")?.text ?? null,
      });
      extractCalls(valueNode, qn, ctx, config);
    } else if (exported) {
      ctx.entities.push({
        is_default_export: defaultIsDefaultExport(node),
        is_exported: true,
        kind: "variable",
        line_end: node.endPosition.row + 1,
        line_start: node.startPosition.row + 1,
        metadata: JSON.stringify({ const: isConst }),
        name: varName,
        qualified_name: qn,
        signature: null,
      });
    }
  }
}

// Export statement extraction

function extractExportStatement(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  // Re-exports: export { foo } from './bar' or export * from './bar'
  const sourceNode = node.childForFieldName("source");
  if (sourceNode) {
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
    ctx.importSpecifiers.push({ names, specifier });
  }

  // Continue walking children to pick up exported declarations
  for (const child of node.namedChildren) {
    visitNode(child, ctx, config);
  }
}

// Call extraction

function extractCalls(
  node: Node,
  callerQn: string,
  ctx: WalkerContext,
  config: LanguageConfig,
): void {
  const { nodeKinds, hooks } = config;

  if (nodeKinds.callExpression.includes(node.type)) {
    let calleeName: string | null = null;

    if (hooks?.extractCalleeName) {
      calleeName = hooks.extractCalleeName(node as unknown as SyntaxNode);
    } else {
      calleeName = extractCalleeName(node);
    }

    if (calleeName) {
      ctx.intraEdges.push({
        confidence: 0.8,
        edge_type: "calls",
        source_qualified: callerQn,
        target_qualified: `${ctx.filePath}::${calleeName}`,
      });
    }
  }

  for (const child of node.namedChildren) {
    extractCalls(child, callerQn, ctx, config);
  }
}

/**
 * Extract a readable callee name from a call expression node.
 * Handles TypeScript/JS call_expression (function field),
 * Python call (function field), Java method_invocation (name field),
 * and Bash command (name field / first command_name child).
 */
/** Extract callee name from a 'function' field node (TS/JS/Python). */
function calleeFromFunctionField(fnField: Node): string | null {
  if (fnField.type === "identifier") return fnField.text;
  if (fnField.type === "member_expression" || fnField.type === "optional_chain") {
    const object = fnField.childForFieldName("object");
    const property = fnField.childForFieldName("property");
    if (object && property) return `${object.text}.${property.text}`;
    return fnField.text.slice(0, 120);
  }
  if (fnField.type === "attribute") {
    const attr = fnField.childForFieldName("attribute");
    return attr ? attr.text : fnField.text;
  }
  return null;
}

function extractCalleeName(node: Node): string | null {
  const fnField = node.childForFieldName("function");
  if (fnField) return calleeFromFunctionField(fnField);

  // Java: method_invocation has 'name' field
  const nameField = node.childForFieldName("name");
  if (nameField) return nameField.text;

  // Bash: command has command_name as first child
  const firstChild = node.children[0];
  if (firstChild?.type === "command_name") return firstChild.text;

  return null;
}

// Default import extraction (fallback when no hook provided)

function extractDefaultImport(node: Node, ctx: WalkerContext): void {
  const sourceNode = node.childForFieldName("source");
  if (sourceNode) {
    const specifier = sourceNode.text.replace(/^['"]|['"]$/g, "");
    ctx.importSpecifiers.push({ names: [], specifier });
  }
}

// Export / isExported helpers

/**
 * Default export detection.
 *
 * - If the language has no exportStatement nodes (e.g. Bash, Python),
 *   treat top-level nodes (parent is program/module root) as exported.
 * - Otherwise walk ancestors looking for export_statement.
 */
function defaultIsExported(node: Node, config: LanguageConfig): boolean {
  // Languages without export syntax: treat top-level as exported
  if (config.nodeKinds.exportStatement.length === 0) {
    const parentType = node.parent?.type;
    return parentType === "program" || parentType === "module";
  }

  // TypeScript/JS: look for export_statement ancestor
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === "export_statement") return true;
    if (cur.type === "program" || cur.type === "statement_block" || cur.type === "class_body") {
      break;
    }
    cur = cur.parent;
  }
  return false;
}

function defaultIsDefaultExport(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "export_statement") {
    return parent.children.some((c) => c.type === "default");
  }
  return false;
}
