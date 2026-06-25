/**
 * dead-wire-internal-use.mjs — parse-aware same-file internal-use classifier
 *
 * SYNOPSIS
 *   node dead-wire-internal-use.mjs <file> <symbol>
 *
 * INPUTS
 *   <file>   Absolute or relative path to a TypeScript (.ts) or TSX (.tsx) file.
 *   <symbol> Identifier name to count USE-POSITION code-identifier occurrences of.
 *
 * OUTPUT (stdout)
 *   A single integer: the count of genuine USE-POSITION code-identifier occurrences
 *   of <symbol> in <file>. Declaration-name positions are excluded.
 *
 *   A genuine USE is an identifier in expression or type-reference position:
 *     - a call target, new target, member-access subject
 *     - a type annotation reference (e.g. `: Foo`, `as Foo`, `extends Foo`)
 *     - a template substitution reference (${...})
 *     - any other value/type reference that is NOT the name-binding site of a declaration
 *
 *   Excluded (NOT counted as a use):
 *     - Declaration-name nodes: the `name:` field identifier of function/class/interface/
 *       type-alias/enum/namespace/module declarations, variable declarators, method and
 *       property definitions, function overload signatures, import specifiers, and the
 *       names in `export { X }` export specifiers and re-exports.
 *     - Comment leaves (comment), string content (string_fragment), and regex content
 *       (regex_pattern, regex) — these are non-code positions.
 *     - Template chars (template_chars) and escape sequences.
 *
 *   Template substitutions (${...}) ARE counted — the walker recurses uniformly
 *   and keys on the leaf's own type + its declaration-position status, NOT ancestor type.
 *
 * EXIT CODES
 *   0  Success: count printed to stdout. Count = 0 means zero genuine uses.
 *   1  Any error: bad args, file unreadable, grammar missing, parse failure,
 *      web-tree-sitter init failure.
 *      A short "CANON ..." diagnostic is printed to stderr on every error path.
 *
 * FAIL-CLOSED GUARANTEE
 *   ANY error causes exit 1 so the caller (dead-wire-gate.sh) treats the symbol
 *   as DEAD (over-flag). Exit 0 with a printed count is the ONLY success path.
 *   WIRED status REQUIRES a successful run with a count ≥ 1.
 *
 * WIRED RULE (caller: dead-wire-gate.sh)
 *   count ≥ 1  → same-file internal use detected → WIRED
 *   count = 0  → no genuine uses found → DEAD
 *
 * MODULE RESOLUTION
 *   This script MUST reside under mcp-server/ so ESM resolves the bare specifier
 *   "web-tree-sitter" against mcp-server/node_modules. (ESM resolves bare
 *   specifiers relative to the importing file, not cwd — see PROBE-FINDINGS P4.)
 *   Grammar files are resolved relative to this script's location:
 *     mcp-server/grammars/tree-sitter-typescript.wasm  (for .ts files)
 *     mcp-server/grammars/tree-sitter-tsx.wasm          (for .tsx files)
 *   Override the grammar directory with env var DEAD_WIRE_GRAMMARS_DIR (for testing).
 *
 * LEAF-TYPE CLASSIFIER (see DESIGN.md / PROBE-FINDINGS P1/P2)
 *   Code-identifier types (leaf nodes that MAY be a genuine use):
 *     identifier, property_identifier, type_identifier, shorthand_property_identifier
 *   Non-code types (always ignored):
 *     comment, string_fragment, regex_pattern, regex, template_chars, escape_sequence
 *   CRUCIAL: do NOT skip the template_string subtree. template_substitution (${...})
 *   children are real code and must be recursed into. The walker recurses uniformly
 *   and classifies by the leaf's OWN type — it never inherits a "skip" flag.
 *
 * DECLARATION-NAME EXCLUSION (use-position counting)
 *   The walker excludes any code-identifier leaf that sits in the `name:` field of a
 *   declaration node, or is the bound identifier in a variable declarator's pattern,
 *   or appears in an import/export specifier's name position. This is determined by
 *   checking whether a leaf's parent is a known declaration node type AND whether the
 *   child's field name (from the parent's perspective) marks it as the declaration name.
 *   See isDeclarationNameNode() for the full node-type / field-name pairs.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";

// ---------------------------------------------------------------------------
// Leaf-type sets (see PROBE-FINDINGS P1 / DESIGN.md classifier rule)
// ---------------------------------------------------------------------------

/** Leaf node types that MAY constitute a code reference to the symbol. */
const CODE_IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "type_identifier",
  "shorthand_property_identifier",
]);

// ---------------------------------------------------------------------------
// Declaration-name exclusion
//
// These are the (parent.type, child.fieldName) pairs where the child
// identifier is the BINDING NAME of the declaration, not a reference.
// Any CODE_IDENTIFIER_TYPES leaf matching one of these pairs is excluded
// from the use-count.
//
// Node types sourced from the TypeScript tree-sitter grammar:
//   function_declaration, function_signature      → name: identifier
//   class_declaration                              → name: type_identifier
//   interface_declaration                          → name: type_identifier
//   type_alias_declaration                         → name: type_identifier
//   enum_declaration                               → name: identifier
//   module (namespace)                             → name: identifier | string
//   internal_module (namespace block variant)      → name: identifier | string
//   variable_declarator                            → name: identifier (pattern)
//   method_definition, method_signature            → name: property_identifier
//   public_field_definition                        → name: property_identifier
//   import_specifier (named import binding)        → name: identifier
//   export_specifier (named export binding)        → name: identifier
//   required_parameter, optional_parameter         → pattern: identifier
//
// Note: we match on the field name as reported by tree-sitter's
// `node.fields[n].fieldName` via childForFieldName / children iteration.
// Since web-tree-sitter exposes children via .child(i) and field names via
// .childForFieldName(name), we use the parent-child relationship to determine
// whether a leaf is at a declaration-name position.
// ---------------------------------------------------------------------------

/**
 * Returns true if `node` (a leaf) is at a declaration-name position within
 * its parent — meaning it is the identifier that NAMES a declaration, not a
 * reference to an existing name.
 *
 * This function is called only for leaf nodes whose type is in CODE_IDENTIFIER_TYPES.
 *
 * @param {import('web-tree-sitter').SyntaxNode} node - The leaf node.
 * @returns {boolean} True if this leaf is a declaration-name node.
 */
function isDeclarationNameNode(node) {
  const parent = node.parent;
  if (parent === null) return false;

  const parentType = parent.type;

  // For node types that expose a `name` field, check whether this child IS
  // that `name` field.
  //
  // We check identity by comparing startIndex, since web-tree-sitter SyntaxNode
  // objects may not be reference-equal across calls.
  const nameField = tryGetField(parent, "name");
  if (nameField !== null && nameField.startIndex === node.startIndex) {
    // This leaf is the `name:` field of its parent.
    // Now check if the parent is a declaration-producing node type.
    if (DECLARATION_NODE_TYPES_WITH_NAME_FIELD.has(parentType)) {
      return true;
    }
  }

  // variable_declarator: the bound pattern is the `name:` field
  if (parentType === "variable_declarator") {
    const nameFieldVD = tryGetField(parent, "name");
    if (nameFieldVD !== null && nameFieldVD.startIndex === node.startIndex) {
      return true;
    }
  }

  // required_parameter / optional_parameter: `pattern:` field is the binding
  if (parentType === "required_parameter" || parentType === "optional_parameter") {
    const patternField = tryGetField(parent, "pattern");
    if (patternField !== null && patternField.startIndex === node.startIndex) {
      return true;
    }
  }

  // import_specifier: name/alias binding
  // In `import { Foo }`, the identifier `Foo` is the local binding.
  // In `import { Foo as Bar }`, `Bar` is the binding (alias field), `Foo` is reference.
  // We exclude the alias (local binding name) — it's a binding, not a use.
  // We also exclude the name field when no alias is present (it IS the binding).
  if (parentType === "import_specifier") {
    const aliasField = tryGetField(parent, "alias");
    if (aliasField !== null) {
      // `import { Foo as Bar }` — Bar is the local binding (alias), Foo is the import ref
      if (aliasField.startIndex === node.startIndex) {
        return true; // this is the local binding name
      }
      // Foo (name field) is a reference to the imported symbol — count it as a use
    } else {
      // `import { Foo }` — no alias, the name IS the binding
      const nameFieldIS = tryGetField(parent, "name");
      if (nameFieldIS !== null && nameFieldIS.startIndex === node.startIndex) {
        return true;
      }
    }
  }

  // export_specifier: `export { Foo }` or `export { Foo as Bar }`
  // `Foo` in `export { Foo }` is a reference (we READ Foo to export it) — count it
  // But `Bar` in `export { Foo as Bar }` (the exported name) is a renaming, not a use
  if (parentType === "export_specifier") {
    const aliasFieldES = tryGetField(parent, "alias");
    if (aliasFieldES !== null && aliasFieldES.startIndex === node.startIndex) {
      // The `as Bar` part — Bar is the exported name, not a local reference
      return true;
    }
    // The `Foo` part (name field) IS a reference to the local binding — count it
  }

  // shorthand_property_identifier in an object pattern (destructuring) is a binding
  // e.g. `const { foo } = obj` — `foo` here is bound, not a use of `foo` the function.
  // However, shorthand_property_identifier in object EXPRESSION `{ foo }` is a use.
  // Distinguish: parent of shorthand_property_identifier in a pattern is
  // `object_pattern`; in an expression it is `object`.
  if (
    node.type === "shorthand_property_identifier" &&
    (parentType === "object_pattern" || parentType === "pair_pattern")
  ) {
    return true;
  }

  return false;
}

/**
 * Declaration node types that have a `name:` field which binds the symbol.
 * Checking the parent type + field name gives us declaration-name positions.
 */
const DECLARATION_NODE_TYPES_WITH_NAME_FIELD = new Set([
  "function_declaration",
  "function_signature",         // overload signature
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "module",                     // `module "name"` ambient module
  "internal_module",            // `namespace Foo {}` / `module Foo {}`
  "method_definition",
  "method_signature",
  "abstract_method_signature",
  "public_field_definition",
  "property_signature",
]);

/**
 * Safely get a named field from a parent node without throwing.
 * Returns null if the field does not exist on this node type.
 *
 * @param {import('web-tree-sitter').SyntaxNode} parent
 * @param {string} fieldName
 * @returns {import('web-tree-sitter').SyntaxNode | null}
 */
function tryGetField(parent, fieldName) {
  try {
    return parent.childForFieldName(fieldName);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve the absolute path of a grammar WASM file by language key. */
function resolveGrammarPath(language) {
  // Allow override via env var for testing (fail-closed: if dir given but wasm
  // absent, Language.load will throw → non-zero exit).
  const grammarsDir =
    process.env.DEAD_WIRE_GRAMMARS_DIR ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "grammars");
  return join(grammarsDir, `tree-sitter-${language}.wasm`);
}

/** Resolve the absolute path to the web-tree-sitter WASM runtime binary. */
function resolveRuntimeWasm(scriptName) {
  const nodeModulesDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    "web-tree-sitter",
  );
  return join(nodeModulesDir, scriptName);
}

// ---------------------------------------------------------------------------
// CST walker
// ---------------------------------------------------------------------------

/**
 * Walk the CST and count USE-POSITION occurrences of `symbol`.
 *
 * Declaration-name positions are excluded: the walker calls isDeclarationNameNode()
 * for every code-identifier leaf to determine whether it is a binding site. If so,
 * the leaf is skipped even if its text matches the symbol.
 *
 * Recurses uniformly through all node types — including template_string and
 * template_substitution — so that ${symbol()} inside a template literal is
 * counted as a code reference. Leaf classification is by the leaf node's OWN
 * type, never inherited from ancestors.
 *
 * @param {import('web-tree-sitter').SyntaxNode} node - Current node to visit.
 * @param {string} symbol - The symbol name to search for.
 * @returns {number} Count of USE-POSITION code-identifier occurrences of `symbol`.
 */
function countCodeRefs(node, symbol) {
  let count = 0;

  if (node.childCount === 0) {
    // Leaf node: classify by own type
    if (CODE_IDENTIFIER_TYPES.has(node.type) && node.text === symbol) {
      // Only count if this is a USE position, not a declaration-name position
      if (!isDeclarationNameNode(node)) {
        count += 1;
      }
    }
    return count;
  }

  // Internal node: recurse into all children uniformly
  // (NO skip flag inherited through template_string — that is the key invariant)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null) {
      count += countCodeRefs(child, symbol);
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2); // positional args only

  // Validate argc: exactly 2 positional args required
  if (args.length !== 2) {
    process.stderr.write(
      `CANON ERROR [dead-wire-internal-use]: expected 2 args (file, symbol), got ${args.length}\n`,
    );
    process.exit(1);
  }

  const [fileArg, symbol] = args;
  const filePath = resolve(fileArg);

  // Determine grammar by file extension
  const language = filePath.endsWith(".tsx") ? "tsx" : "typescript";
  const grammarPath = resolveGrammarPath(language);

  // Read the source file (fail-closed: ENOENT → non-zero)
  let src;
  try {
    src = readFileSync(filePath, "utf8");
  } catch (err) {
    process.stderr.write(
      `CANON ERROR [dead-wire-internal-use]: cannot read file '${filePath}': ${err.message}\n`,
    );
    process.exit(1);
  }

  // Initialize web-tree-sitter WASM runtime
  try {
    await Parser.init({
      locateFile(scriptName) {
        if (scriptName.endsWith(".wasm")) {
          return resolveRuntimeWasm(scriptName);
        }
        return scriptName;
      },
    });
  } catch (err) {
    process.stderr.write(
      `CANON ERROR [dead-wire-internal-use]: web-tree-sitter init failed: ${err.message}\n`,
    );
    process.exit(1);
  }

  // Load grammar (fail-closed: missing wasm → Language.load throws)
  let lang;
  try {
    lang = await Language.load(grammarPath);
  } catch (err) {
    process.stderr.write(
      `CANON ERROR [dead-wire-internal-use]: grammar load failed for '${grammarPath}': ${err.message}\n`,
    );
    process.exit(1);
  }

  // Parse source
  let tree;
  try {
    const parser = new Parser();
    parser.setLanguage(lang);
    tree = parser.parse(src);
  } catch (err) {
    process.stderr.write(
      `CANON ERROR [dead-wire-internal-use]: parse failed for '${filePath}': ${err.message}\n`,
    );
    process.exit(1);
  }

  // Walk CST and count use-position code references
  const count = countCodeRefs(tree.rootNode, symbol);

  // Success: print count to stdout, exit 0
  process.stdout.write(`${count}\n`);
}

// Top-level await; any uncaught error → stderr + non-zero exit (fail-closed)
main().catch((err) => {
  process.stderr.write(
    `CANON ERROR [dead-wire-internal-use]: unexpected error: ${err?.message ?? String(err)}\n`,
  );
  process.exit(1);
});
