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
 *   of <symbol> in <file>. Only explicitly recognized use positions are counted.
 *
 *   A genuine USE is an identifier in a RECOGNIZED use position (allowlist):
 *     - call callee: `deadFn(...)` (call_expression function: field)
 *     - new target: `new DeadFn()` (new_expression constructor: field)
 *     - member access: `deadFn.x`, `x.deadFn` (member_expression object: or property: field)
 *     - argument position: `f(deadFn)`, array element `[deadFn]` (expression context)
 *     - template substitution: `${deadFn()}` (always recursed into uniformly)
 *     - heritage: `class C extends DeadFn`, `implements DeadFn`
 *     - decorator: `@deadFn`
 *     - type reference: `let x: DeadFn`, `interface I extends DeadFn`, `typeof deadFn`
 *     - shorthand object value: `const o = { deadFn }` (reading the binding)
 *     - computed key: `{ [deadFn]: 1 }` (expression position)
 *     - export-default value: `export default deadFn`, `export = deadFn`
 *     - assignment/binary/unary expression operand
 *     - return/yield/await expression value
 *
 *   NOT counted (non-use positions — anything not in the above allowlist):
 *     - Declaration-name nodes: function/class/interface/type-alias/enum/namespace/
 *       module declaration names, variable declarator names, method/property definition
 *       names, function overload signature names
 *     - Import specifiers (both name and alias positions)
 *     - Export specifiers (name field — `export { foo }`, re-export `export { foo } from`)
 *     - Every destructuring binding position (object/array/renamed/rest patterns)
 *     - Object property keys (non-computed): `{ deadFn: 1 }` — key is NOT a use
 *     - Enum member names: `enum E { deadFn }`
 *     - Parameter binding names
 *     - Any other position NOT in the recognized-use allowlist (fail-closed default)
 *
 *   Comment leaves (comment), string content (string_fragment), and regex content
 *   (regex_pattern, regex) are NOT code-identifier leaf types and are never counted.
 *   Template chars (template_chars) and escape sequences are also non-code.
 *
 *   Template substitutions (${...}) ARE counted — the walker recurses uniformly
 *   and keys on the leaf's own type, NOT ancestor type.
 *
 * POSTURE — USE-POSITION ALLOWLIST (fail-closed by default)
 *   Only RECOGNIZED use positions are counted. An unrecognized/unclassified position
 *   defaults to NON-use (not counted). This makes incompleteness fail-CLOSED:
 *   a use form the allowlist doesn't cover → not counted → over-flags DEAD → SAFE.
 *   The `// canon:allow-unwired: <reason>` marker provides the escape hatch for
 *   legitimate over-flagging.
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
// USE-POSITION ALLOWLIST
//
// POSTURE: Count an identifier occurrence as a genuine same-file USE **only**
// when its AST role is a RECOGNIZED use position. Every unrecognized /
// unclassified position defaults to NON-use (not counted). This makes
// incompleteness FAIL-CLOSED: a use-form you forgot → not counted → over-flags
// DEAD → safe. The `// canon:allow-unwired: <reason>` escape hatch handles
// legitimate over-flagging.
//
// The implementation uses a two-step approach:
//   1. Check explicit NON-USE positions (fast early exits for the most
//      common binding/key positions that could otherwise be miscounted).
//   2. Check explicit USE positions (allowlist) — if none match, default = NON-use.
//
// This is structurally opposite to the old denylist: the old code returned
// "NOT a use" for known declaration positions and counted everything else.
// The new code returns "IS a use" for known use positions and rejects everything else.
// ---------------------------------------------------------------------------

/**
 * Returns true if `node` (a leaf) is at a RECOGNIZED USE position — meaning
 * it is genuinely reading or referencing the symbol, not just naming it.
 *
 * Incompleteness is FAIL-CLOSED: an unrecognized position returns false
 * (NOT counted), which over-flags DEAD — the safe side for a security gate.
 *
 * This function is called only for leaf nodes whose type is in CODE_IDENTIFIER_TYPES.
 *
 * @param {import('web-tree-sitter').SyntaxNode} node - The leaf node.
 * @returns {boolean} True if this leaf is in a recognized use position.
 */
function isUsePosition(node) {
  const parent = node.parent;
  if (parent === null) return false;

  const parentType = parent.type;

  // -------------------------------------------------------------------------
  // Step 1: Explicit NON-USE positions — fast rejection for common cases.
  //
  // These are the positions that are DEFINITELY not uses. Checking them
  // first provides clarity and prevents reaching the allowlist for obvious
  // non-use positions.
  // -------------------------------------------------------------------------

  // Declaration name positions: function/class/interface/type/enum/namespace/method/field names.
  // The `name:` field of any declaration-producing node type is a binding, not a use.
  const nameField = tryGetField(parent, "name");
  if (nameField !== null && nameField.startIndex === node.startIndex) {
    if (DECLARATION_NODE_TYPES_WITH_NAME_FIELD.has(parentType)) {
      return false; // declaration name — NOT a use
    }
  }

  // variable_declarator name: the `name:` field (may be a pattern)
  if (parentType === "variable_declarator") {
    const nameFieldVD = tryGetField(parent, "name");
    if (nameFieldVD !== null && nameFieldVD.startIndex === node.startIndex) {
      return false; // binding in `const/let/var name = ...` — NOT a use
    }
  }

  // Parameter binding: `pattern:` field of required_parameter / optional_parameter
  if (parentType === "required_parameter" || parentType === "optional_parameter") {
    const patternField = tryGetField(parent, "pattern");
    if (patternField !== null && patternField.startIndex === node.startIndex) {
      return false; // parameter name binding — NOT a use
    }
  }

  // import_specifier: both the name binding and alias binding are NOT uses.
  // `import { Foo }` — Foo is the local binding.
  // `import { Foo as Bar }` — Bar is the local binding; Foo is an external ref (NOT same-file use).
  if (parentType === "import_specifier") {
    return false; // all import specifier positions are bindings — NOT a use
  }

  // export_specifier: `export { foo }` or `export { foo } from './m'`
  // Both the name field (foo) and alias field (bar in `foo as bar`) are NOT internal uses.
  // `export { foo }` — foo is being re-exported, not called/used internally.
  if (parentType === "export_specifier") {
    return false; // export specifier name/alias — NOT an internal use
  }

  // Object property key (non-computed): `{ deadFn: 1 }` — the key is NOT a use.
  // Tree-sitter: in a `pair` node, the `key:` field is the property name.
  // A non-computed key is a property_identifier or identifier, not a value read.
  if (parentType === "pair") {
    const keyField = tryGetField(parent, "key");
    if (keyField !== null && keyField.startIndex === node.startIndex) {
      // This is the key position in { key: value }
      // Non-computed keys are not uses; computed keys are handled in the allowlist below.
      // Check if this is a computed key (has [ ] wrapper) — if not, it's NOT a use.
      // In tree-sitter, a computed property key has node type `computed_property_name`
      // wrapping the expression. A bare identifier/property_identifier key is non-computed.
      if (
        node.type === "identifier" ||
        node.type === "property_identifier" ||
        node.type === "string" ||
        node.type === "type_identifier"
      ) {
        return false; // non-computed property key — NOT a use
      }
    }
  }

  // Enum member name: `enum E { deadFn }` — the member name is a binding, not a use.
  // Tree-sitter: enum_body contains enum_assignment nodes (name: field) or bare identifiers.
  if (
    parentType === "enum_body" ||
    (parentType === "enum_assignment" &&
      (() => {
        const enumNameField = tryGetField(parent, "name");
        return enumNameField !== null && enumNameField.startIndex === node.startIndex;
      })())
  ) {
    return false; // enum member name — NOT a use
  }

  // Destructuring patterns — all binding positions, NOT uses:
  //   array_pattern: `const [deadFn] = x`
  //   object_pattern: `const { deadFn } = x` (shorthand binding)
  //   pair_pattern: `const { x: deadFn } = y` (renamed binding, value field)
  //   rest_pattern: `const [...deadFn] = x`, `const { ...deadFn } = x`
  if (
    parentType === "array_pattern" ||
    (parentType === "object_pattern" && node.type === "shorthand_property_identifier") ||
    (parentType === "pair_pattern" &&
      (() => {
        const valueField = tryGetField(parent, "value");
        return valueField !== null && valueField.startIndex === node.startIndex;
      })()) ||
    parentType === "rest_pattern"
  ) {
    return false; // destructuring binding — NOT a use
  }

  // -------------------------------------------------------------------------
  // Step 2: USE-POSITION ALLOWLIST — recognized use positions.
  //
  // If a node reaches here (not rejected above) AND matches one of these
  // explicit use positions, it IS a genuine use. Otherwise: default = NOT a use.
  // -------------------------------------------------------------------------

  // Call expression callee: `deadFn(...)`
  // Tree-sitter: call_expression has function: field for the callee.
  if (parentType === "call_expression") {
    const calleeField = tryGetField(parent, "function");
    if (calleeField !== null && calleeField.startIndex === node.startIndex) {
      return true; // call callee — IS a use
    }
  }

  // New expression constructor: `new DeadFn()`
  if (parentType === "new_expression") {
    const ctorField = tryGetField(parent, "constructor");
    if (ctorField !== null && ctorField.startIndex === node.startIndex) {
      return true; // new target — IS a use
    }
  }

  // Member expression: `deadFn.x` (object:) or `x.deadFn` (property: in accessed position)
  // Both the object and property positions in a member_expression are uses.
  if (parentType === "member_expression") {
    return true; // member access — IS a use
  }

  // Assignment expression: `x = deadFn` or `deadFn = x` — both sides are uses.
  // (Left side could be the symbol being assigned; right side is a value read.)
  if (parentType === "assignment_expression") {
    return true; // assignment operand — IS a use
  }

  // Binary/unary expressions: `deadFn + x`, `!deadFn`, `deadFn === null`
  if (
    parentType === "binary_expression" ||
    parentType === "unary_expression" ||
    parentType === "augmented_assignment_expression" ||
    parentType === "ternary_expression"
  ) {
    return true; // expression operand — IS a use
  }

  // Arguments in a call: `f(deadFn)` — the identifier is an argument.
  // Tree-sitter: arguments node wraps the argument list.
  if (parentType === "arguments") {
    return true; // argument to a call — IS a use
  }

  // Array literal element (NOT array_pattern binding): `[deadFn, x]`
  // Tree-sitter: array node (expression context) vs array_pattern (binding context).
  if (parentType === "array") {
    return true; // array element expression — IS a use
  }

  // Parenthesized expression: `(deadFn)`
  if (parentType === "parenthesized_expression") {
    return true; // parenthesized value — IS a use
  }

  // Return statement value: `return deadFn`
  if (parentType === "return_statement") {
    return true; // return value — IS a use
  }

  // Yield/await expression: `yield deadFn`, `await deadFn`
  if (parentType === "yield_expression" || parentType === "await_expression") {
    return true; // yield/await value — IS a use
  }

  // Spread element: `...deadFn` in expression position
  if (parentType === "spread_element") {
    return true; // spread value — IS a use
  }

  // Shorthand property in an object EXPRESSION (not pattern):
  //   `const o = { deadFn }` — this IS a use (reading the value of deadFn).
  //   Tree-sitter: shorthand_property_identifier inside `object` (expression) vs
  //   inside `object_pattern` (binding — handled above in NON-USE).
  // Note: `object` parent + shorthand_property_identifier = reading the binding value.
  if (node.type === "shorthand_property_identifier" && parentType === "object") {
    return true; // shorthand object property value — IS a use
  }

  // Computed property key: `{ [deadFn]: 1 }` — the expression inside [] is a use.
  // Tree-sitter: computed_property_name wraps the key expression.
  if (parentType === "computed_property_name") {
    return true; // computed key expression — IS a use
  }

  // Heritage clause: `class C extends DeadFn` or `implements DeadFn`
  if (
    parentType === "class_heritage" ||
    parentType === "extends_clause" ||
    parentType === "implements_clause"
  ) {
    return true; // extends/implements target — IS a use
  }

  // Decorator: `@deadFn` or `@deadFn.method`
  if (parentType === "decorator") {
    return true; // decorator reference — IS a use
  }

  // Type annotation (type reference): `: DeadFn`, `as DeadFn`, `DeadFn[]`, etc.
  // Tree-sitter uses many type node types; most have the identifier as a direct child.
  if (
    parentType === "type_annotation" ||
    parentType === "type_identifier" ||
    parentType === "generic_type" ||
    parentType === "array_type" ||
    parentType === "union_type" ||
    parentType === "intersection_type" ||
    parentType === "tuple_type" ||
    parentType === "type_predicate" ||
    parentType === "index_signature" ||
    parentType === "lookup_type" ||
    parentType === "conditional_type" ||
    parentType === "infer_type" ||
    parentType === "mapped_type_clause" ||
    parentType === "type_arguments" ||
    parentType === "constraint" ||
    parentType === "default_type" ||
    parentType === "as_expression" ||
    parentType === "satisfies_expression" ||
    parentType === "type_assertion" ||
    parentType === "non_null_expression"
  ) {
    return true; // type reference — IS a use
  }

  // typeof expression: `typeof deadFn`
  if (parentType === "typeof_expression" || parentType === "type_query") {
    return true; // typeof target — IS a use
  }

  // Expression statement: bare `deadFn;` (uncommon but valid)
  if (parentType === "expression_statement") {
    return true; // bare expression — IS a use
  }

  // Sequence expression: `x, deadFn`
  if (parentType === "sequence_expression") {
    return true; // sequence operand — IS a use
  }

  // Template substitution: `${deadFn}` inside a template literal.
  // The template_substitution node's direct child is the expression.
  if (parentType === "template_substitution") {
    return true; // template substitution expression — IS a use
  }

  // JSX expression container: `{deadFn}` in TSX
  if (parentType === "jsx_expression") {
    return true; // JSX expression — IS a use
  }

  // Object value (non-shorthand): `{ key: deadFn }` — the value is a use.
  // Tree-sitter: pair node, value: field.
  if (parentType === "pair") {
    const valueField = tryGetField(parent, "value");
    if (valueField !== null && valueField.startIndex === node.startIndex) {
      return true; // object property value — IS a use
    }
  }

  // Export statement value: `export default deadFn` or `export = deadFn`
  if (
    parentType === "export_default" ||
    parentType === "export_statement" ||
    parentType === "assignment_expression"
  ) {
    // For export_statement we need to be careful — the symbol name in
    // `export function foo` would have been caught by the declaration name check above.
    // If we reach here, it's a value context (e.g. export = foo).
    return true; // export value — IS a use
  }

  // Variable initializer: `const x = deadFn` — the right-hand side is a use.
  // Tree-sitter: variable_declarator has value: field for the initializer.
  if (parentType === "variable_declarator") {
    const valueFieldVD = tryGetField(parent, "value");
    if (valueFieldVD !== null && valueFieldVD.startIndex === node.startIndex) {
      return true; // variable initializer — IS a use
    }
  }

  // Subscript expression: `x[deadFn]`
  if (parentType === "subscript_expression") {
    return true; // subscript index — IS a use
  }

  // Throw statement: `throw deadFn`
  if (parentType === "throw_statement") {
    return true; // throw value — IS a use
  }

  // Conditional / switch / if / while / for: expression parts
  if (
    parentType === "if_statement" ||
    parentType === "while_statement" ||
    parentType === "do_statement" ||
    parentType === "for_statement" ||
    parentType === "for_in_statement" ||
    parentType === "switch_statement"
  ) {
    return true; // control-flow expression — IS a use
  }

  // -------------------------------------------------------------------------
  // DEFAULT: unrecognized position → NOT a use (FAIL-CLOSED).
  //
  // Any position not explicitly recognized above defaults to NON-use.
  // This is the core of the allowlist posture: incompleteness over-flags
  // DEAD (safe), never false-WIRE (unsafe).
  // -------------------------------------------------------------------------
  return false;
}

/**
 * Declaration node types that have a `name:` field which binds the symbol.
 * Checking the parent type + field name gives us declaration-name positions.
 * These are used by isUsePosition() Step 1 to fast-reject declaration names.
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
 * USE-POSITION ALLOWLIST posture: the walker calls isUsePosition() for every
 * code-identifier leaf to determine whether it is a genuine use. Only recognized
 * use positions are counted; unrecognized positions default to NON-use (fail-closed).
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
      // Only count if this is a recognized USE position (allowlist)
      // Unrecognized positions default to NON-use (fail-closed posture)
      if (isUsePosition(node)) {
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
