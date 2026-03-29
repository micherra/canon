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

import type { Tree, Node } from 'web-tree-sitter';
import type { LanguageConfig, SyntaxNode, WalkerContext } from './kg-language-configs.ts';
import type { AdapterResult, IntraFileEdge, EntityKind, EdgeType } from './kg-types.ts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
    return { entities: [], intraFileEdges: [], importSpecifiers: [] };
  }

  const ctx: WalkerContext = {
    filePath,
    entities: [],
    intraEdges: [],
    importSpecifiers: [],
    classStack: [],
  };

  const root = tree.rootNode;
  if (root) {
    visitNode(root, ctx, config);
  }

  // Build file → entity "contains" edges
  const containsEdges: IntraFileEdge[] = ctx.entities.map((e) => ({
    source_qualified: filePath,
    target_qualified: e.qualified_name,
    edge_type: 'contains' as const,
    confidence: 1.0,
  }));

  // Cast from the looser WalkerContext string types to the strict AdapterResult types.
  // Language configs and hooks use plain string to avoid importing kg-types.ts;
  // the generic walker is the only place that bridges the two type systems.
  return {
    entities: ctx.entities.map((e) => ({
      ...e,
      kind: e.kind as EntityKind,
    })),
    intraFileEdges: [
      ...containsEdges,
      ...ctx.intraEdges.map((edge) => ({
        ...edge,
        edge_type: edge.edge_type as EdgeType,
      })),
    ],
    importSpecifiers: ctx.importSpecifiers,
  };
}

// ---------------------------------------------------------------------------
// Core recursive visitor
// ---------------------------------------------------------------------------

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
    if (
      nodeKinds.importStatement.includes(kind) ||
      nodeKinds.importStatement.length === 0
    ) {
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

// ---------------------------------------------------------------------------
// Entity extraction helpers
// ---------------------------------------------------------------------------

function extractFunctionEntity(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  const { hooks } = config;
  const name = hooks?.getEntityName
    ? hooks.getEntityName(node as unknown as SyntaxNode)
    : (node.childForFieldName('name')?.text ?? null);

  if (!name) return;

  // Language-specific export detection; fallback handles TS export_statement,
  // Python module-level, and languages with exportStatement: [] (Bash).
  const exported = hooks?.isExported
    ? hooks.isExported(node as unknown as SyntaxNode)
    : defaultIsExported(node, config);

  const isDefault = defaultIsDefaultExport(node);
  const isAsync = node.children.some((c) => c.type === 'async');
  const isGenerator = node.type.includes('generator');
  const qn = `${ctx.filePath}::${name}`;

  ctx.entities.push({
    name,
    qualified_name: qn,
    kind: 'function',
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    is_exported: exported,
    is_default_export: isDefault,
    signature: node.childForFieldName('parameters')?.text ?? null,
    metadata: JSON.stringify({ async: isAsync, generator: isGenerator }),
  });

  // Extract calls from function body
  extractCalls(node, qn, ctx, config);
}

function extractClassEntity(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  const { nodeKinds, hooks } = config;
  const name = hooks?.getEntityName
    ? hooks.getEntityName(node as unknown as SyntaxNode)
    : (node.childForFieldName('name')?.text ?? null);

  if (!name) return;

  const exported = hooks?.isExported
    ? hooks.isExported(node as unknown as SyntaxNode)
    : defaultIsExported(node, config);

  const isAbstract = node.type.includes('abstract');
  const qn = `${ctx.filePath}::${name}`;

  ctx.entities.push({
    name,
    qualified_name: qn,
    kind: 'class',
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    is_exported: exported,
    is_default_export: defaultIsDefaultExport(node),
    signature: null,
    metadata: JSON.stringify({ abstract: isAbstract }),
  });

  // Extract extends/implements edges from class children and heritage nodes
  extractHeritageEdges(node, qn, ctx);

  // Walk class body for methods
  ctx.classStack.push(name);

  // Find the body: prefer 'body' field, then look for classBody-typed children
  const bodyNode = node.childForFieldName('body');
  if (bodyNode) {
    if (nodeKinds.classBody.includes(bodyNode.type)) {
      for (const child of bodyNode.namedChildren) {
        visitNode(child, ctx, config);
      }
    } else {
      visitNode(bodyNode, ctx, config);
    }
  } else {
    for (const child of node.children) {
      if (nodeKinds.classBody.includes(child.type)) {
        for (const bodyChild of child.namedChildren) {
          visitNode(bodyChild, ctx, config);
        }
        break;
      }
    }
  }

  ctx.classStack.pop();
}

/**
 * Extract extends/implements edges from a class declaration node.
 *
 * TypeScript: class_heritage > extends_clause / implements_clause
 * Python: superclasses field > argument_list with identifiers
 */
function extractHeritageEdges(node: Node, classQn: string, ctx: WalkerContext): void {
  // TypeScript pattern: class_heritage wrapper
  for (const child of node.children) {
    if (child.type === 'class_heritage') {
      for (const hChild of child.children) {
        if (hChild.type === 'extends_clause') {
          const superName = (
            hChild.childForFieldName('value') ?? hChild.namedChildren[0]
          )?.text;
          if (superName) {
            ctx.intraEdges.push({
              source_qualified: classQn,
              target_qualified: `${ctx.filePath}::${superName}`,
              edge_type: 'extends',
              confidence: 0.9,
            });
          }
        }
        if (hChild.type === 'implements_clause') {
          for (const impl of hChild.namedChildren) {
            if (impl.text) {
              ctx.intraEdges.push({
                source_qualified: classQn,
                target_qualified: `${ctx.filePath}::${impl.text}`,
                edge_type: 'implements',
                confidence: 0.9,
              });
            }
          }
        }
      }
    }

    // Direct children (some grammars may not use class_heritage wrapper)
    if (child.type === 'extends_clause') {
      const superName = (
        child.childForFieldName('value') ?? child.namedChildren[0]
      )?.text;
      if (superName) {
        ctx.intraEdges.push({
          source_qualified: classQn,
          target_qualified: `${ctx.filePath}::${superName}`,
          edge_type: 'extends',
          confidence: 0.9,
        });
      }
    }
    if (child.type === 'implements_clause') {
      for (const impl of child.namedChildren) {
        if (impl.text) {
          ctx.intraEdges.push({
            source_qualified: classQn,
            target_qualified: `${ctx.filePath}::${impl.text}`,
            edge_type: 'implements',
            confidence: 0.9,
          });
        }
      }
    }
  }

  // Python pattern: superclasses field
  const superclassesNode = node.childForFieldName('superclasses');
  if (superclassesNode) {
    for (const baseNode of superclassesNode.namedChildren) {
      if (baseNode.type === 'identifier' || baseNode.type === 'attribute') {
        ctx.intraEdges.push({
          source_qualified: classQn,
          target_qualified: `${ctx.filePath}::${baseNode.text}`,
          edge_type: 'extends',
          confidence: 0.9,
        });
      }
    }
  }
}

function extractMethodEntity(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  const { hooks } = config;
  const enclosingClass = ctx.classStack[ctx.classStack.length - 1];
  if (!enclosingClass) return;

  const methodName = (
    hooks?.getEntityName
      ? hooks.getEntityName(node as unknown as SyntaxNode)
      : (node.childForFieldName('name')?.text ?? null)
  );
  if (!methodName) return;

  const isStatic = node.children.some((c) => c.type === 'static');
  const isAsync = node.children.some((c) => c.type === 'async');

  // Python: check parent for @staticmethod decorator
  let staticFromDecorator = false;
  const parent = node.parent;
  if (parent?.type === 'decorated_definition') {
    for (const dec of parent.namedChildren) {
      if (dec.type === 'decorator' && dec.text.includes('staticmethod')) {
        staticFromDecorator = true;
      }
    }
  }

  // TypeScript: accessibility_modifier child; Java: modifiers child
  let visibility = 'public';
  for (const c of node.children) {
    if (c.type === 'accessibility_modifier') {
      const v = c.text;
      if (v === 'private' || v === 'protected' || v === 'public') {
        visibility = v;
      }
    }
    if (c.type === 'modifiers') {
      for (const mod of c.children) {
        if (mod.type === 'private' || mod.text === 'private') visibility = 'private';
        if (mod.type === 'protected' || mod.text === 'protected') visibility = 'protected';
        if (mod.type === 'public' || mod.text === 'public') visibility = 'public';
      }
    }
  }

  const exported = hooks?.isExported
    ? hooks.isExported(node as unknown as SyntaxNode)
    : false;

  const qn = `${ctx.filePath}::${enclosingClass}.${methodName}`;

  ctx.entities.push({
    name: methodName,
    qualified_name: qn,
    kind: 'method',
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    is_exported: exported,
    is_default_export: false,
    signature: node.childForFieldName('parameters')?.text ?? null,
    metadata: JSON.stringify({
      static: isStatic || staticFromDecorator,
      async: isAsync,
      visibility,
    }),
  });

  // Extract calls from method body
  extractCalls(node, qn, ctx, config);
}

// ---------------------------------------------------------------------------
// Variable declaration extraction
// ---------------------------------------------------------------------------

function extractVariableDecl(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  const { hooks } = config;

  const exported = hooks?.isExported
    ? hooks.isExported(node as unknown as SyntaxNode)
    : defaultIsExported(node, config);

  const isConst = node.children.some((c) => c.type === 'const');

  for (const declarator of node.children.filter((c) => c.type === 'variable_declarator')) {
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (!nameNode) continue;

    const varName = nameNode.text;
    const qn = `${ctx.filePath}::${varName}`;

    if (
      valueNode &&
      (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')
    ) {
      const isAsync = valueNode.children.some((c) => c.type === 'async');
      ctx.entities.push({
        name: varName,
        qualified_name: qn,
        kind: 'function',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        is_exported: exported,
        is_default_export: defaultIsDefaultExport(node),
        signature: valueNode.childForFieldName('parameters')?.text ?? null,
        metadata: JSON.stringify({ async: isAsync, generator: false }),
      });
      extractCalls(valueNode, qn, ctx, config);
    } else if (exported) {
      ctx.entities.push({
        name: varName,
        qualified_name: qn,
        kind: 'variable',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        is_exported: true,
        is_default_export: defaultIsDefaultExport(node),
        signature: null,
        metadata: JSON.stringify({ const: isConst }),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Export statement extraction
// ---------------------------------------------------------------------------

function extractExportStatement(node: Node, ctx: WalkerContext, config: LanguageConfig): void {
  // Re-exports: export { foo } from './bar' or export * from './bar'
  const sourceNode = node.childForFieldName('source');
  if (sourceNode) {
    const specifier = sourceNode.text.replace(/^['"]|['"]$/g, '');
    const names: string[] = [];
    const exportClause = node.children.find(
      (c) => c.type === 'export_clause' || c.type === 'namespace_export',
    );
    if (exportClause) {
      for (const spec of exportClause.namedChildren) {
        const localName = spec.childForFieldName('name') ?? spec.namedChildren[0];
        if (localName) names.push(localName.text);
      }
    }
    ctx.importSpecifiers.push({ specifier, names });
  }

  // Continue walking children to pick up exported declarations
  for (const child of node.namedChildren) {
    visitNode(child, ctx, config);
  }
}

// ---------------------------------------------------------------------------
// Call extraction
// ---------------------------------------------------------------------------

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
        source_qualified: callerQn,
        target_qualified: `${ctx.filePath}::${calleeName}`,
        edge_type: 'calls',
        confidence: 0.8,
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
function extractCalleeName(node: Node): string | null {
  // TypeScript/JS: call_expression has 'function' field
  const fnField = node.childForFieldName('function');
  if (fnField) {
    if (fnField.type === 'identifier') return fnField.text;
    if (fnField.type === 'member_expression' || fnField.type === 'optional_chain') {
      const object = fnField.childForFieldName('object');
      const property = fnField.childForFieldName('property');
      if (object && property) return `${object.text}.${property.text}`;
      return fnField.text.slice(0, 120);
    }
    // Python: attribute access (obj.method)
    if (fnField.type === 'attribute') {
      const attr = fnField.childForFieldName('attribute');
      return attr ? attr.text : fnField.text;
    }
    if (fnField.type === 'identifier') return fnField.text;
    return null;
  }

  // Java: method_invocation has 'name' field
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text;

  // Bash: command has command_name as first child or 'name' field
  const firstChild = node.children[0];
  if (firstChild?.type === 'command_name') return firstChild.text;

  return null;
}

// ---------------------------------------------------------------------------
// Default import extraction (fallback when no hook provided)
// ---------------------------------------------------------------------------

function extractDefaultImport(node: Node, ctx: WalkerContext): void {
  const sourceNode = node.childForFieldName('source');
  if (sourceNode) {
    const specifier = sourceNode.text.replace(/^['"]|['"]$/g, '');
    ctx.importSpecifiers.push({ specifier, names: [] });
  }
}

// ---------------------------------------------------------------------------
// Export / isExported helpers
// ---------------------------------------------------------------------------

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
    return parentType === 'program' || parentType === 'module';
  }

  // TypeScript/JS: look for export_statement ancestor
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'export_statement') return true;
    if (
      cur.type === 'program' ||
      cur.type === 'statement_block' ||
      cur.type === 'class_body'
    ) {
      break;
    }
    cur = cur.parent;
  }
  return false;
}

function defaultIsDefaultExport(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'export_statement') {
    return parent.children.some((c) => c.type === 'default');
  }
  return false;
}
