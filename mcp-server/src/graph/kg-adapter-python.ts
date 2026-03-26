/**
 * Knowledge Graph — Python Language Adapter
 *
 * Parses Python source files using Tree-sitter and extracts entities
 * (functions, classes, methods, constants) and intra-file edges
 * (contains, calls, extends) along with import specifiers.
 */

import Parser from 'tree-sitter';
import PythonLang from 'tree-sitter-python';
import type { LanguageAdapter, AdapterResult, IntraFileEdge, ImportSpecifier } from './kg-types.ts';

// ---------------------------------------------------------------------------
// Module-level parser (reused across calls for performance)
// ---------------------------------------------------------------------------

const parser = new Parser();
parser.setLanguage(PythonLang as unknown as Parser.Language);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the text of the first named child with fieldName, or null. */
function fieldText(node: Parser.SyntaxNode, fieldName: string): string | null {
  const child = node.childForFieldName(fieldName);
  return child ? child.text : null;
}

/** Check whether a node is a direct child of the module root (depth == 1). */
function isTopLevel(node: Parser.SyntaxNode): boolean {
  return node.parent?.type === 'module';
}

/**
 * Walk all descendants of `root` and invoke `visitor` for each node.
 * The visitor can return `false` to skip descending into a node's children.
 */
function walk(
  node: Parser.SyntaxNode,
  visitor: (n: Parser.SyntaxNode) => boolean | void,
): void {
  const proceed = visitor(node);
  if (proceed === false) return;
  for (const child of node.children) {
    walk(child, visitor);
  }
}

/**
 * Extract the callable name from a `call` node's `function` field.
 * Handles `identifier` and `attribute` (i.e. obj.method) forms.
 */
function callName(callNode: Parser.SyntaxNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    return attr ? attr.text : fn.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

function parse(filePath: string, content: string): AdapterResult {
  const tree = parser.parse(content);
  const root = tree.rootNode;

  const entities: AdapterResult['entities'] = [];
  const intraFileEdges: IntraFileEdge[] = [];
  const importSpecifiers: ImportSpecifier[] = [];

  // File entity qualified name (used as source for contains edges)
  const fileQN = filePath;

  // Track current class context for method qualified_name construction.
  // We use a simple stack because classes can be nested (though uncommon).
  const classStack: string[] = [];

  // -------------------------------------------------------------------------
  // Single-pass tree walk
  // -------------------------------------------------------------------------
  walk(root, (node) => {
    // -----------------------------------------------------------------------
    // Import statements
    // -----------------------------------------------------------------------
    if (node.type === 'import_statement') {
      // import foo, bar  OR  import foo.bar
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name' || child.type === 'aliased_import') {
          const nameNode =
            child.type === 'aliased_import'
              ? child.childForFieldName('name')
              : child;
          if (!nameNode) continue;
          const specifier = nameNode.text;
          importSpecifiers.push({ specifier, names: [specifier] });
        }
      }
      return false; // no interesting children
    }

    if (node.type === 'import_from_statement') {
      // from foo import bar, baz  OR  from foo import *
      const moduleNode = node.childForFieldName('module_name');
      const specifier = moduleNode ? moduleNode.text : '';
      const names: string[] = [];

      for (const child of node.namedChildren) {
        if (child === moduleNode) continue;
        if (child.type === 'wildcard_import') {
          names.push('*');
        } else if (child.type === 'dotted_name') {
          names.push(child.text);
        } else if (child.type === 'aliased_import') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) names.push(nameNode.text);
        }
      }

      if (specifier) {
        importSpecifiers.push({ specifier, names: names.length ? names : ['*'] });
      }
      return false;
    }

    // -----------------------------------------------------------------------
    // Class definitions
    // -----------------------------------------------------------------------
    if (node.type === 'class_definition') {
      const nameTxt = fieldText(node, 'name');
      if (!nameTxt) return;

      const qualifiedName = `${filePath}::${nameTxt}`;
      const topLevel = isTopLevel(node);

      // Extract base classes from the `argument_list` inside the class header.
      // In tree-sitter-python the superclasses appear as `argument_list` child
      // of the `class_definition` (before the `:` body block).
      const argList = node.childForFieldName('superclasses');
      if (argList) {
        for (const baseNode of argList.namedChildren) {
          if (baseNode.type === 'identifier' || baseNode.type === 'attribute') {
            intraFileEdges.push({
              source_qualified: qualifiedName,
              target_qualified: `${filePath}::${baseNode.text}`,
              edge_type: 'extends',
              confidence: 0.9,
            });
          }
        }
      }

      entities.push({
        name: nameTxt,
        qualified_name: qualifiedName,
        kind: 'class',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        is_exported: topLevel,
        is_default_export: false,
        signature: null,
        metadata: null,
      });

      // Add contains edge from file
      intraFileEdges.push({
        source_qualified: fileQN,
        target_qualified: qualifiedName,
        edge_type: 'contains',
      });

      // Push class context and walk children, then pop
      classStack.push(nameTxt);
      // We handle children ourselves so we can track class context correctly.
      const bodyNode = node.childForFieldName('body');
      if (bodyNode) {
        for (const child of bodyNode.children) {
          walk(child, (n) => visitInsideClass(n, filePath, fileQN, classStack, entities, intraFileEdges));
        }
      }
      classStack.pop();

      // Tell the outer walk NOT to descend — we already handled the body above.
      return false;
    }

    // -----------------------------------------------------------------------
    // Top-level function definitions (not inside a class)
    // -----------------------------------------------------------------------
    if (node.type === 'function_definition' && classStack.length === 0) {
      if (!isTopLevel(node)) return; // skip nested functions

      const nameTxt = fieldText(node, 'name');
      if (!nameTxt) return;

      const qualifiedName = `${filePath}::${nameTxt}`;
      const isAsync = node.children.some((c) => c.type === 'async' || c.text === 'async');
      const params = fieldText(node, 'parameters') ?? '()';
      const signature = `${nameTxt}${params}`;

      entities.push({
        name: nameTxt,
        qualified_name: qualifiedName,
        kind: 'function',
        line_start: node.startPosition.row + 1,
        line_end: node.endPosition.row + 1,
        is_exported: true,
        is_default_export: false,
        signature,
        metadata: JSON.stringify({ async: isAsync }),
      });

      intraFileEdges.push({
        source_qualified: fileQN,
        target_qualified: qualifiedName,
        edge_type: 'contains',
      });

      // Extract calls within this function body
      const bodyNode = node.childForFieldName('body');
      if (bodyNode) {
        extractCalls(bodyNode, qualifiedName, intraFileEdges);
      }

      return false; // we handled the subtree
    }

    // -----------------------------------------------------------------------
    // Top-level constant assignments (ALL_CAPS variable names)
    // -----------------------------------------------------------------------
    if (node.type === 'expression_statement' && isTopLevel(node)) {
      const assignment = node.firstNamedChild;
      if (assignment?.type === 'assignment') {
        const lhs = assignment.childForFieldName('left');
        if (lhs?.type === 'identifier' && /^[A-Z][A-Z0-9_]*$/.test(lhs.text)) {
          const nameTxt = lhs.text;
          const qualifiedName = `${filePath}::${nameTxt}`;

          entities.push({
            name: nameTxt,
            qualified_name: qualifiedName,
            kind: 'variable',
            line_start: node.startPosition.row + 1,
            line_end: node.endPosition.row + 1,
            is_exported: true,
            is_default_export: false,
            signature: null,
            metadata: null,
          });

          intraFileEdges.push({
            source_qualified: fileQN,
            target_qualified: qualifiedName,
            edge_type: 'contains',
          });
        }
      }
      return false;
    }

    // Continue descending for anything else at the module level
  });

  return { entities, intraFileEdges, importSpecifiers };
}

// ---------------------------------------------------------------------------
// visitInsideClass — handles nodes found inside a class body
// ---------------------------------------------------------------------------

function visitInsideClass(
  node: Parser.SyntaxNode,
  filePath: string,
  fileQN: string,
  classStack: string[],
  entities: AdapterResult['entities'],
  intraFileEdges: IntraFileEdge[],
): boolean | void {
  if (node.type !== 'function_definition') return;

  const className = classStack[classStack.length - 1];
  if (!className) return false;

  const nameTxt = node.childForFieldName('name')?.text;
  if (!nameTxt) return false;

  const qualifiedName = `${filePath}::${className}.${nameTxt}`;
  const classQN = `${filePath}::${className}`;

  // Check for @staticmethod decorator
  let isStatic = false;
  // Decorators appear as siblings before the function_definition in the body,
  // or as decorated_definition parent. Check the decorated_definition pattern.
  const parent = node.parent;
  if (parent?.type === 'decorated_definition') {
    for (const dec of parent.namedChildren) {
      if (dec.type === 'decorator') {
        const decoratorText = dec.text;
        if (decoratorText.includes('staticmethod')) {
          isStatic = true;
        }
      }
    }
  }

  const isAsync = node.children.some((c) => c.type === 'async' || c.text === 'async');
  const params = node.childForFieldName('parameters')?.text ?? '()';
  const signature = `${nameTxt}${params}`;

  entities.push({
    name: nameTxt,
    qualified_name: qualifiedName,
    kind: 'method',
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
    is_exported: true,
    is_default_export: false,
    signature,
    metadata: JSON.stringify({ static: isStatic, async: isAsync }),
  });

  // contains edge: class -> method
  intraFileEdges.push({
    source_qualified: classQN,
    target_qualified: qualifiedName,
    edge_type: 'contains',
  });

  // Extract calls within this method body
  const bodyNode = node.childForFieldName('body');
  if (bodyNode) {
    extractCalls(bodyNode, qualifiedName, intraFileEdges);
  }

  return false; // don't descend further inside the method body from here
}

// ---------------------------------------------------------------------------
// extractCalls — collect call expressions within a subtree
// ---------------------------------------------------------------------------

function extractCalls(
  subtree: Parser.SyntaxNode,
  sourceQN: string,
  edges: IntraFileEdge[],
): void {
  walk(subtree, (node) => {
    if (node.type === 'call') {
      const name = callName(node);
      if (name) {
        edges.push({
          source_qualified: sourceQN,
          target_qualified: name, // unresolved; pipeline will cross-reference
          edge_type: 'calls',
          confidence: 0.8,
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const pythonAdapter: LanguageAdapter = {
  extensions: ['.py'],
  parse,
};
