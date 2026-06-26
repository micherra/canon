/**
 * dead-wire-internal-use.mjs — TypeScript-compiler binding-resolver
 *   for same-file internal-use detection.
 *
 * SYNOPSIS
 *   node dead-wire-internal-use.mjs <file> <symbol>
 *
 * INPUTS
 *   <file>   Absolute or relative path to a TypeScript (.ts) or TSX (.tsx) file.
 *   <symbol> Identifier name to count RESOLVED-BINDING uses of.
 *
 * OUTPUT (stdout)
 *   A single integer: the count of occurrences of <symbol> in <file> that
 *   RESOLVE (via the TypeScript compiler's binding/scope resolution) to the
 *   top-level exported declaration of <symbol>.  Only occurrences that the
 *   type-checker confirms reference the export binding are counted.
 *
 *   A genuine USE is an identifier whose resolved symbol (via
 *   `checker.getSymbolAtLocation`, with `getShorthandAssignmentValueSymbol`
 *   for shorthand-property contexts) equals the top-level export symbol AND
 *   whose position falls OUTSIDE the target symbol's own declaration node.
 *   References lexically contained within the target declaration are excluded —
 *   this closes the recursive-export false-WIRE bypass where a function calling
 *   itself (or referencing itself in a default parameter) would otherwise register
 *   as an internal use even with no external caller.
 *   This means:
 *     - `res.deadFn`  → NOT a use (resolves to property on `res`, not the export)
 *     - `res?.deadFn` → NOT a use (same — optional-chain property)
 *     - `a.b.deadFn`  → NOT a use (nested member property)
 *     - shadowing local `const deadFn = 2; return deadFn` → NOT a use (resolves to local)
 *     - shadowing param `function h(deadFn) { return deadFn }` → NOT a use (resolves to param)
 *     - `function deadFn() { return deadFn(); }` → NOT a use (intra-declaration self-reference)
 *     - `deadFn()`    → IS a use (resolves to the export, outside the declaration)
 *     - `deadFn.bind` → IS a use (deadFn as object, resolves to export)
 *     - `let x: DeadT`→ IS a use (type-reference, resolves to export)
 *     - `{ deadFn }`  → IS a use (shorthand reading the export binding)
 *     - `{ deadFn: 1 }` → NOT a use (key is a property name, not a binding reference)
 *
 * RESOLUTION MECHANISM
 *   Builds a single in-memory `ts.Program` for the one input file with options
 *   `{ noResolve: true, noLib: true, types: [] }` and a minimal CompilerHost —
 *   no tsconfig required.  Binding/scope resolution is purely lexical and does
 *   not need global lib types.  This is the TypeScript compiler's authoritative
 *   name-binding resolver, not a hand-rolled heuristic.
 *
 * FAIL-CLOSED GUARANTEE
 *   ANY error (missing `typescript` module, ENOENT, bad args, parse throw,
 *   checker throw) causes exit 1 so the caller (dead-wire-gate.sh) treats the
 *   symbol as DEAD (over-flag).  Exit 0 with a printed count is the ONLY
 *   success path.  WIRED status REQUIRES a successful run with count ≥ 1.
 *
 * WIRED RULE (caller: dead-wire-gate.sh)
 *   count ≥ 1  → same-file internal use detected → WIRED
 *   count = 0  → no resolved uses found → DEAD
 *
 * MODULE RESOLUTION
 *   This script MUST reside under mcp-server/ so the bare specifier "typescript"
 *   resolves against mcp-server/node_modules (ESM resolves bare specifiers
 *   relative to the importing file, not cwd).
 *
 * EXIT CODES
 *   0  Success: count printed to stdout.
 *   1  Any error: bad args, file unreadable, typescript missing, compiler throw.
 *      A "CANON ERROR [dead-wire-internal-use]" diagnostic is printed to stderr.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const args = process.argv.slice(2);

  // Validate argc: exactly 2 positional args required
  if (args.length !== 2) {
    process.stderr.write(
      `CANON ERROR [dead-wire-internal-use]: expected 2 args (file, symbol), got ${args.length}\n`,
    );
    process.exit(1);
  }

  const [fileArg, symbol] = args;
  const filePath = resolve(fileArg);

  // Read source file (fail-closed: ENOENT → non-zero)
  let src;
  try {
    src = readFileSync(filePath, "utf8");
  } catch (err) {
    process.stderr.write(
      `CANON ERROR [dead-wire-internal-use]: cannot read file '${filePath}': ${err.message}\n`,
    );
    process.exit(1);
  }

  // Import typescript (fail-closed: missing module → non-zero)
  let ts;
  try {
    const mod = await import("typescript");
    ts = mod.default ?? mod;
  } catch (err) {
    process.stderr.write(
      `CANON ERROR [dead-wire-internal-use]: cannot import 'typescript': ${err.message}\n`,
    );
    process.exit(1);
  }

  // Build a single in-memory Program (no tsconfig, no lib files needed)
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const compilerOptions = {
    noResolve: true,
    noLib: true,
    types: [],
    target: ts.ScriptTarget.Latest,
  };

  // Minimal CompilerHost serving only the one file
  const sourceFile = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, scriptKind);
  const defaultHost = ts.createCompilerHost(compilerOptions);
  const customHost = {
    ...defaultHost,
    getSourceFile(name) {
      if (name === filePath) return sourceFile;
      return undefined;
    },
    fileExists(name) {
      return name === filePath;
    },
    readFile(name) {
      if (name === filePath) return src;
      return undefined;
    },
  };

  // Parse-diagnostic guard (fail-closed on malformed input):
  // If the source file has syntactic parse errors, the compiler produces a
  // partial/recovered AST in which a shadowing binding can mis-bind to the
  // exported symbol, yielding a false use-count >= 1 (false-WIRE).
  // Guard against this by checking sourceFile.parseDiagnostics — the
  // syntactic parse-error list populated by the scanner/parser (NOT semantic
  // diagnostics, which would false-DEAD valid files referencing lib types).
  // A non-empty parseDiagnostics list → bail fail-closed (exit 1, DEAD).
  const parseDiags = sourceFile.parseDiagnostics;
  if (parseDiags && parseDiags.length > 0) {
    const firstMsg =
      typeof parseDiags[0]?.messageText === "string"
        ? parseDiags[0].messageText
        : parseDiags[0]?.messageText?.messageText ?? "(unknown)";
    process.stderr.write(
      `CANON ERROR [dead-wire-internal-use]: file '${filePath}' has ${parseDiags.length} syntactic parse error(s); cannot reliably resolve bindings. First error: ${firstMsg}\n`,
    );
    process.exit(1);
  }

  const program = ts.createProgram([filePath], compilerOptions, customHost);
  const checker = program.getTypeChecker();

  // Find the top-level binding for <symbol> — search by exported symbol first,
  // then fall back to any top-level declaration name.  The caller (dead-wire-gate.sh)
  // found this symbol via an `export …` diff line, but the helper does NOT require
  // `export` to be present in the file (test fixtures intentionally omit it to avoid
  // gate fixture-discovery false positives).
  function aliasRoot(sym) {
    let s = sym;
    while (s.flags & ts.SymbolFlags.Alias) {
      const a = checker.getAliasedSymbol(s);
      if (a === s) break;
      s = a;
    }
    return s;
  }

  // Strategy 1: module exports (works when file has actual export declarations)
  let targetSym = null;
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol) {
    const exports = checker.getExportsOfModule(moduleSymbol);
    const exportSym = exports.find((s) => s.getName() === symbol);
    if (exportSym) {
      targetSym = aliasRoot(exportSym);
    }
  }

  // Strategy 2: scan top-level statements for a declaration named <symbol>
  // (handles non-exported declarations in test fixtures and plain scripts)
  if (!targetSym) {
    for (const stmt of sourceFile.statements) {
      let nameNode = null;
      if (
        (ts.isFunctionDeclaration(stmt) ||
          ts.isClassDeclaration(stmt) ||
          ts.isInterfaceDeclaration(stmt) ||
          ts.isTypeAliasDeclaration(stmt) ||
          ts.isEnumDeclaration(stmt) ||
          ts.isModuleDeclaration(stmt)) &&
        stmt.name &&
        ts.isIdentifier(stmt.name) &&
        stmt.name.text === symbol
      ) {
        nameNode = stmt.name;
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === symbol) {
            nameNode = decl.name;
            break;
          }
        }
      }
      if (nameNode) {
        const sym = checker.getSymbolAtLocation(nameNode);
        if (sym) {
          targetSym = aliasRoot(sym);
          break;
        }
      }
    }
  }

  if (!targetSym) {
    // Symbol not found in this file — no same-file internal use possible
    process.stdout.write("0\n");
    return;
  }

  // Collect the declaration node(s) of targetSym so that intra-declaration
  // self-references can be excluded from the use count.  A recursive call
  // inside a function's own body, a default-parameter self-reference, or any
  // other identifier that appears lexically inside the target's own declaration
  // node is NOT an external use and must not increment the count.
  const targetDeclNodes = targetSym.declarations ?? [];

  // Returns true when `node` is lexically contained inside any of the target
  // symbol's own declaration nodes (i.e., the reference is a self-reference).
  // Uses parent-chain walk — O(depth) but depth is bounded by file nesting.
  function isInsideTargetDeclaration(node) {
    if (targetDeclNodes.length === 0) return false;
    let current = node.parent;
    while (current) {
      if (targetDeclNodes.includes(current)) return true;
      current = current.parent;
    }
    return false;
  }

  // Walk every identifier in the file and count uses that resolve to targetSym
  let count = 0;

  function isDeclarationName(node) {
    const parent = node.parent;
    if (!parent) return false;
    // Variable declarator: `const/let/var name = ...` — the name field is a binding
    if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
    // Function/class/interface/type-alias/enum declaration names
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isModuleDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
      parent.name === node
    )
      return true;
    // Parameter: binding name
    if (ts.isParameter(parent) && parent.name === node) return true;
    // Import/export specifier names
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
    return false;
  }

  function visit(node) {
    if (ts.isIdentifier(node) && node.text === symbol) {
      if (!isDeclarationName(node)) {
        let resolved;

        // Shorthand property assignment `{ deadFn }` — the naive getSymbolAtLocation
        // returns the property symbol; getShorthandAssignmentValueSymbol gets the value.
        if (
          ts.isShorthandPropertyAssignment(node.parent) &&
          node.parent.name === node
        ) {
          const shorthandSym = checker.getShorthandAssignmentValueSymbol(node.parent);
          resolved = shorthandSym ? aliasRoot(shorthandSym) : null;
        } else {
          const s = checker.getSymbolAtLocation(node);
          resolved = s ? aliasRoot(s) : null;
        }

        if (resolved && resolved === targetSym && !isInsideTargetDeclaration(node)) {
          count++;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  process.stdout.write(`${count}\n`);
}

// Top-level await; any uncaught error → stderr + non-zero exit (fail-closed)
main().catch((err) => {
  process.stderr.write(
    `CANON ERROR [dead-wire-internal-use]: unexpected error: ${err?.message ?? String(err)}\n`,
  );
  process.exit(1);
});
