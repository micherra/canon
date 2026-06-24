/**
 * dead-wire-internal-use.mjs — parse-aware same-file internal-use classifier
 *
 * SYNOPSIS
 *   node dead-wire-internal-use.mjs <file> <symbol>
 *
 * INPUTS
 *   <file>   Absolute or relative path to a TypeScript (.ts) or TSX (.tsx) file.
 *   <symbol> Identifier name to count code-identifier occurrences of.
 *
 * OUTPUT (stdout)
 *   A single integer: the count of CODE-identifier occurrences of <symbol> in <file>.
 *   Code identifiers are leaf nodes of type:
 *     identifier | property_identifier | type_identifier | shorthand_property_identifier
 *   Comment leaves (comment), string content (string_fragment), and regex content
 *   (regex_pattern, regex) are NOT counted.
 *   Template substitutions (${...}) ARE counted — the walker recurses uniformly
 *   and keys on the leaf's own type, NOT on ancestor node type.
 *
 * EXIT CODES
 *   0  Success: count printed to stdout. Count = 0 means symbol not found.
 *   1  Any error: bad args, file unreadable, grammar missing, parse failure,
 *      web-tree-sitter init failure.
 *      A short "CANON ..." diagnostic is printed to stderr on every error path.
 *
 * FAIL-CLOSED GUARANTEE
 *   ANY error causes exit 1 so the caller (dead-wire-gate.sh) treats the symbol
 *   as DEAD (over-flag). Exit 0 with a printed count is the ONLY success path.
 *   WIRED status REQUIRES a successful run with a count ≥ 1.
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
 *   Code-identifier types:
 *     identifier, property_identifier, type_identifier, shorthand_property_identifier
 *   Non-code types (ignored):
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

/** Leaf node types that constitute a CODE reference to the symbol. */
const CODE_IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "type_identifier",
  "shorthand_property_identifier",
]);

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
 * Walk the CST and count leaf occurrences of `symbol` that are code identifiers.
 *
 * Recurses uniformly through all node types — including template_string and
 * template_substitution — so that ${symbol()} inside a template literal is
 * counted as a code reference. Leaf classification is by the leaf node's OWN
 * type, never inherited from ancestors.
 *
 * @param {import('web-tree-sitter').SyntaxNode} node - Current node to visit.
 * @param {string} symbol - The symbol name to search for.
 * @returns {number} Count of code-identifier occurrences of `symbol`.
 */
function countCodeRefs(node, symbol) {
  let count = 0;

  if (node.childCount === 0) {
    // Leaf node: classify by own type
    if (CODE_IDENTIFIER_TYPES.has(node.type) && node.text === symbol) {
      count += 1;
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

  // Walk CST and count code references
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
