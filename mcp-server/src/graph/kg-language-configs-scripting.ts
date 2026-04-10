/**
 * Scripting language configurations for the Generic Tree-sitter Walker.
 *
 * Contains Bash and Java language configs, extracted from kg-language-configs.ts
 * to keep each file under the 600-line limit.
 */

import type { LanguageConfig, SyntaxNode, WalkerContext } from "./kg-language-configs.ts";

// Bash config
// Derived from kg-adapter-bash.ts

export const bashConfig: LanguageConfig = {
  extensions: [".sh"],
  grammarFile: "tree-sitter-bash.wasm",
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
            ctx.importSpecifiers.push({ names: ["*"], specifier });
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
          confidence: 0.9,
          edge_type: "calls",
          source_qualified: sourceQualified,
          target_qualified: targetQualified,
        });
      }
    },
  },
  id: "bash",
  nodeKinds: {
    callExpression: ["command"],
    classBody: [],
    // Bash has no classes, methods, imports, variables, or exports
    classDef: [],
    exportStatement: [],
    functionDef: ["function_definition"],
    // Imports handled via extractImport hook (source/. commands)
    importStatement: [],
    methodDef: [],
    variableDecl: [],
  },
};

// Java config helpers

/** Split a dotted path into specifier and name at the last dot. */
function splitDottedPath(fullPath: string): { specifier: string; name: string } {
  const lastDot = fullPath.lastIndexOf(".");
  return lastDot >= 0
    ? { name: fullPath.slice(lastDot + 1), specifier: fullPath.slice(0, lastDot) }
    : { name: fullPath, specifier: fullPath };
}

/** Extract import parts from Java import_declaration child nodes. */
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

/** Fallback: parse Java import from raw text when tree-sitter doesn't give parts. */
function parseJavaImportFallback(node: SyntaxNode, ctx: WalkerContext): void {
  const raw = node.text
    .replace(/^import\s+/, "")
    .replace(/;$/, "")
    .trim();
  if (!raw) return;
  const { specifier, name } = splitDottedPath(raw);
  ctx.importSpecifiers.push({ names: [name], specifier });
}

// Java config

export const javaConfig: LanguageConfig = {
  extensions: [".java"],
  grammarFile: "tree-sitter-java.wasm",
  hooks: {
    extractImport(node: SyntaxNode, ctx: WalkerContext): void {
      if (node.type !== "import_declaration") return;

      const parts = collectJavaImportParts(node);
      if (parts.length === 0) {
        parseJavaImportFallback(node, ctx);
        return;
      }

      const { specifier, name } = splitDottedPath(parts.join("."));
      ctx.importSpecifiers.push({ names: [name], specifier });
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
          is_default_export: false,
          is_exported: false,
          kind: "interface",
          line_end: node.endPosition.row + 1,
          line_start: node.startPosition.row + 1,
          metadata: JSON.stringify({ annotation: true }),
          name,
          qualified_name: `${ctx.filePath}::@${name}`,
          signature: null,
        });
        return;
      }

      if (node.type === "enum_constant") {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const name = nameNode.text;
        const enclosingClass = ctx.classStack[ctx.classStack.length - 1];
        const qn = enclosingClass
          ? `${ctx.filePath}::${enclosingClass}.${name}`
          : `${ctx.filePath}::${name}`;
        ctx.entities.push({
          is_default_export: false,
          is_exported: true, // enum constants are always accessible
          kind: "variable",
          line_end: node.endPosition.row + 1,
          line_start: node.startPosition.row + 1,
          metadata: JSON.stringify({ enumConstant: true }),
          name,
          qualified_name: qn,
          signature: null,
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
  },
  id: "java",
  nodeKinds: {
    callExpression: ["method_invocation"],
    classBody: ["class_body", "interface_body", "enum_body"],
    classDef: ["class_declaration", "interface_declaration", "enum_declaration"],
    exportStatement: [],
    functionDef: [],
    importStatement: ["import_declaration"],
    methodDef: ["method_declaration", "constructor_declaration"],
    variableDecl: ["field_declaration", "local_variable_declaration"],
  },
};
