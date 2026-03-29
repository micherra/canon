/**
 * Bash Tree-sitter Language Adapter
 *
 * Implements LanguageAdapter for Bash/shell scripts (.sh files).
 * Extracts function definitions and source/. commands.
 */

import Parser from 'tree-sitter';
import BashLang from 'tree-sitter-bash';
import type { LanguageAdapter, AdapterResult, IntraFileEdge } from './kg-types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk tree nodes depth-first, yielding each node. */
function* walkTree(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  yield node;
  for (const child of node.children) {
    yield* walkTree(child);
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const bashAdapter: LanguageAdapter = {
  extensions: ['.sh'],

  parse(filePath: string, content: string): AdapterResult {
    const parser = new Parser();
    parser.setLanguage(BashLang as unknown as Parser.Language);
    const tree = parser.parse(content);

    const entities: AdapterResult['entities'] = [];
    const intraFileEdges: IntraFileEdge[] = [];
    const importSpecifiers: AdapterResult['importSpecifiers'] = [];

    // Collect defined function names for call-edge resolution
    const definedFunctions = new Set<string>();

    // First pass: collect function definitions
    for (const node of walkTree(tree.rootNode)) {
      if (node.type === 'function_definition') {
        // tree-sitter-bash: function_definition has a 'name' child node
        const nameNode = node.childForFieldName('name') ?? node.children[0];
        if (!nameNode) continue;
        const funcName = nameNode.text.trim();
        if (!funcName) continue;
        definedFunctions.add(funcName);

        entities.push({
          name: funcName,
          qualified_name: `${filePath}::${funcName}`,
          kind: 'function',
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          is_exported: true, // bash functions are globally available in scope
          is_default_export: false,
          signature: null,
          metadata: null,
        });
      }
    }

    // Intra-file contains edges: file -> each function
    for (const entity of entities) {
      intraFileEdges.push({
        source_qualified: filePath,
        target_qualified: entity.qualified_name,
        edge_type: 'contains',
        confidence: 1.0,
      });
    }

    // Second pass: extract calls and source commands
    for (const node of walkTree(tree.rootNode)) {
      // Source commands: `source ./file.sh` or `. ./file.sh`
      if (node.type === 'command') {
        const nameNode = node.childForFieldName('name') ?? node.children[0];
        if (!nameNode) continue;
        const cmdName = nameNode.text.trim();

        if (cmdName === 'source' || cmdName === '.') {
          // The first argument is the file path
          const argNode = node.childForFieldName('argument') ?? node.children[1];
          if (argNode) {
            const specifier = argNode.text.trim().replace(/^['"]|['"]$/g, '');
            if (specifier) {
              importSpecifiers.push({ specifier, names: ['*'] });
            }
          }
        } else if (definedFunctions.has(cmdName)) {
          // Determine enclosing function for the call edge source
          let ancestor: Parser.SyntaxNode | null = node.parent;
          let enclosingFunc: string | null = null;
          while (ancestor) {
            if (ancestor.type === 'function_definition') {
              const fnNameNode = ancestor.childForFieldName('name') ?? ancestor.children[0];
              if (fnNameNode) {
                enclosingFunc = fnNameNode.text.trim();
              }
              break;
            }
            ancestor = ancestor.parent;
          }

          const sourceQualified = enclosingFunc
            ? `${filePath}::${enclosingFunc}`
            : filePath;
          const targetQualified = `${filePath}::${cmdName}`;

          // Avoid self-calls
          if (sourceQualified !== targetQualified) {
            intraFileEdges.push({
              source_qualified: sourceQualified,
              target_qualified: targetQualified,
              edge_type: 'calls',
              confidence: 0.9,
            });
          }
        }
      }
    }

    return { entities, intraFileEdges, importSpecifiers };
  },
};
