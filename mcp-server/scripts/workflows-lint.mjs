/**
 * workflows-lint.mjs — Node-AST lint helper for Canon workflow scripts.
 *
 * SYNOPSIS
 *   node workflows-lint.mjs [targetDir]
 *
 * INPUTS
 *   [targetDir]  Directory of *.js workflow scripts to lint.
 *                Default: repo-root workflows/ (resolved from this script's location,
 *                NOT from cwd — safe to invoke from any directory).
 *
 * OUTPUT (stdout)
 *   On clean: prints nothing and exits 0.
 *   On violations: prints `FAIL <file>` + `  <line:col> banned: <construct>`
 *   per violation, then exits 1.
 *   On empty or absent targetDir: prints a NOTICE and exits 0 (valid state).
 *
 * BANNED CONSTRUCTS (information-hiding: this is the single source of truth)
 *   - Date.now()          — breaks deterministic resume
 *   - Math.random()       — breaks deterministic resume
 *   - argless new Date()  — breaks deterministic resume (new Date(arg) is OK)
 *   - isolation property  — Canon prohibits isolation as an agent-option key
 *                           (agent-option PROPERTY KEY only; return-value
 *                           or schema-definition uses are NOT banned)
 *   - TS syntax           — InterfaceDeclaration, TypeAliasDeclaration, or
 *                           Parameter/VariableDeclaration/PropertyDeclaration
 *                           carrying a type annotation
 *   - meta non-literal    — export const meta must be a pure object literal;
 *                           MethodDeclaration/GetAccessor/SetAccessor members
 *                           and non-PropertyAssignment members are also banned
 *   - args data access without defensive parse — `args` arrives in the
 *                           Workflow sandbox as a JSON STRING, not a parsed
 *                           object (PR #498). A `PropertyAccessExpression`/
 *                           `ElementAccessExpression` whose base identifier is
 *                           `args` (`args.rung`, `args['x']`), or an
 *                           `ObjectBindingPattern` destructuring `args`
 *                           directly, is banned unless it occurs at or after
 *                           the file's first `JSON.parse(args)` call (the
 *                           defensive-parse guard). See workflows/CLAUDE.md.
 *   - parse error         — malformed JS rejected by the TypeScript parser
 *
 * FAIL-CLOSED GUARANTEE
 *   ANY error (missing typescript, ENOENT, read failure, unexpected throw) causes
 *   exit 1 so the caller (hooks/workflows-lint.sh) treats the check as FAILED.
 *   Hooks-fail-closed: no 2>/dev/null || true silent pass.
 *
 * MODULE RESOLUTION
 *   This script MUST reside under mcp-server/ so the bare specifier "typescript"
 *   resolves against mcp-server/node_modules (ESM resolves bare specifiers
 *   relative to the importing file, not cwd).
 *
 * EXIT CODES
 *   0  All files clean (or targetDir empty/absent).
 *   1  Any violation found, or any internal error (fail-closed).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Resolve paths: this script lives at mcp-server/scripts/workflows-lint.mjs.
// Repo root is two levels up. Default targetDir is workflows/ at repo root.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_TARGET_DIR = join(REPO_ROOT, "workflows");

// ---------------------------------------------------------------------------
// Import TypeScript compiler API (fail-closed: must resolve from mcp-server/)
// ---------------------------------------------------------------------------
let ts;
try {
  const mod = await import("typescript");
  ts = mod.default ?? mod;
} catch (err) {
  process.stderr.write(
    `CANON ERROR [workflows-lint]: cannot import 'typescript': ${err.message}\n`,
  );
  process.exit(1);
}

// TypeScript-only-syntax diagnostic codes — "can only be used in TypeScript files."
// These codes may be emitted as parseDiagnostics in future TypeScript versions even when
// parsing with ScriptKind.JS.  Current TS (6.x) attaches a .type AST node for type
// annotations in JS mode instead of emitting a diagnostic, but a future bump that changes
// this behaviour would relabel TS-syntax violations as generic parse errors.
// Belt-and-suspenders: check for these codes BEFORE the generic parseError early-return.
//   8009 — modifier (abstract, readonly, etc.) can only be used in TypeScript files
//   8010 — type annotations can only be used in TypeScript files
//   8011 — type arguments can only be used in TypeScript files
//   8012 — parameter modifiers can only be used in TypeScript files
//   8013 — non-null assertions can only be used in TypeScript files
const TS_ONLY_SYNTAX_CODES = new Set([8009, 8010, 8011, 8012, 8013]);

/**
 * Returns true if any diagnostic in `diags` belongs to the TS-only-syntax family
 * (codes 8009–8013).  Used to classify such parse-level errors as TS syntax violations
 * rather than generic parse errors.
 */
function hasTsOnlySyntaxDiag(diags) {
  return diags.some((d) => TS_ONLY_SYNTAX_CODES.has(d.code));
}

// ---------------------------------------------------------------------------
// parse — create a TypeScript SourceFile for the given JS content.
// Returns { sf } on success, or { parseError, diags } on failure.
//   parseError — human-readable message from the first parseDiagnostic
//   diags      — raw diagnostic array (always present on error; used by
//                lintFile to distinguish TS-only-syntax errors from generic
//                parse failures via hasTsOnlySyntaxDiag)
// Uses ScriptKind.JS so the TS parser tolerates the workflow sandbox's
// top-level-export + top-level-return + top-level-await module shape.
// ---------------------------------------------------------------------------
function parse(filePath, src) {
  let sf;
  try {
    sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  } catch (err) {
    return { parseError: `internal parse throw: ${err.message}`, diags: [] };
  }

  const diags = sf.parseDiagnostics ?? [];
  if (diags.length > 0) {
    const first = diags[0];
    const msg =
      typeof first.messageText === "string"
        ? first.messageText
        : (first.messageText?.messageText ?? "(unknown)");
    return { parseError: msg, diags };
  }

  return { sf };
}

// ---------------------------------------------------------------------------
// lineCol — convert a node's start position to "line:col" (1-indexed).
// ---------------------------------------------------------------------------
function lineCol(sf, pos) {
  const lc = ts.getLineAndCharacterOfPosition(sf, pos);
  return `${lc.line + 1}:${lc.character + 1}`;
}

// ---------------------------------------------------------------------------
// walkBans — AST-walk a source file, recording banned-construct violations.
// Returns an array of { pos, label } objects.
// ---------------------------------------------------------------------------
function walkBans(sf) {
  const violations = [];

  function visit(node) {
    const SyntaxKind = ts.SyntaxKind;

    // ── Date.now() ──────────────────────────────────────────────────────────
    // CallExpression whose expression is a PropertyAccessExpression with
    // object=Identifier("Date") and name=Identifier("now").
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === "Date" &&
        ts.isIdentifier(expr.name) &&
        expr.name.text === "now"
      ) {
        violations.push({ pos: node.getStart(sf), label: "Date.now()" });
      }

      // ── Math.random() ──────────────────────────────────────────────────────
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === "Math" &&
        ts.isIdentifier(expr.name) &&
        expr.name.text === "random"
      ) {
        violations.push({ pos: node.getStart(sf), label: "Math.random()" });
      }

      // ── isolation property in agent() calls only ──────────────────────────
      // Bans the `isolation` key ONLY when it appears as a DIRECT property key
      // of an object-literal argument to an `agent(...)` call:
      //   agent(prompt, { isolation: 'worktree' })  ← banned
      //   return { isolation: 'x' }                 ← NOT banned
      //   { properties: { isolation: { type:'string' } } } ← NOT banned
      //
      // Scoped to direct properties of each agent() argument — nested objects
      // inside agent args are not inspected (they are schema/data, not options).
      if (ts.isIdentifier(expr) && expr.text === "agent") {
        for (const arg of node.arguments) {
          if (ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (
                (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
                ts.isIdentifier(prop.name) &&
                prop.name.text === "isolation"
              ) {
                violations.push({ pos: prop.getStart(sf), label: "isolation" });
              }
              // Also catch string-literal property key: agent(p, { "isolation": ... })
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isStringLiteral(prop.name) &&
                prop.name.text === "isolation"
              ) {
                violations.push({ pos: prop.getStart(sf), label: "isolation" });
              }
            }
          }
        }
      }
    }

    // ── argless new Date() ───────────────────────────────────────────────────
    // NewExpression whose expression is Identifier("Date") with zero arguments.
    // new Date(arg) with one or more args must NOT be flagged.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      (!node.arguments || node.arguments.length === 0)
    ) {
      violations.push({ pos: node.getStart(sf), label: "argless new Date()" });
    }

    // ── TypeScript syntax ────────────────────────────────────────────────────
    // InterfaceDeclaration or TypeAliasDeclaration
    if (
      node.kind === ts.SyntaxKind.InterfaceDeclaration ||
      node.kind === ts.SyntaxKind.TypeAliasDeclaration
    ) {
      violations.push({ pos: node.getStart(sf), label: "TS syntax (interface/type)" });
    }

    // Parameter, VariableDeclaration, or PropertyDeclaration with a .type node
    if (
      (ts.isParameter(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node)) &&
      node.type
    ) {
      violations.push({ pos: node.getStart(sf), label: "TS syntax (type annotation)" });
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return violations;
}

// ---------------------------------------------------------------------------
// isLiteralValue — return true iff the AST node is a pure literal value
// (string/number/boolean/null, or a nested array/object literal of the same).
// ---------------------------------------------------------------------------
function isLiteralValue(node) {
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      // Computed property keys are banned in meta
      if (ts.isComputedPropertyName(prop.name)) return false;
      // SpreadAssignment is banned
      if (ts.isSpreadAssignment(prop)) return false;
      // Shorthand property is an identifier reference — banned
      if (ts.isShorthandPropertyAssignment(prop)) return false;
      if (ts.isPropertyAssignment(prop)) {
        if (!isLiteralValue(prop.initializer)) return false;
      }
    }
    return true;
  }

  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      if (!isLiteralValue(el)) return false;
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// checkArgsDefensiveParse — flag bare `args` data access that precedes the
// file's defensive `JSON.parse(args)` guard (or is unguarded entirely).
// See workflows/CLAUDE.md "args-is-JSON-string contract".
//
// A file that never references `args` is unaffected (no accesses recorded).
// A file that only reads `args` through the parsed variable (`A.x`, never
// `args.x`) is clean, because the parsed variable is a different identifier.
// ---------------------------------------------------------------------------
function isArgsIdentifier(node) {
  return ts.isIdentifier(node) && node.text === "args";
}

// Recognizes `JSON.parse(args)` — the defensive-parse guard call. This single
// pattern also covers the full
// `typeof args === 'string' ? JSON.parse(args) : (args || {})` idiom, since
// that idiom always contains this call in its true branch.
function isJsonParseArgsCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (
    !ts.isPropertyAccessExpression(expr) ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "JSON" ||
    !ts.isIdentifier(expr.name) ||
    expr.name.text !== "parse"
  ) {
    return false;
  }
  return node.arguments.length === 1 && isArgsIdentifier(node.arguments[0]);
}

function checkArgsDefensiveParse(sf) {
  const accessPositions = [];
  const guardPositions = [];

  function visit(node) {
    // Bare `args.x` / `args['x']`
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isArgsIdentifier(node.expression)
    ) {
      accessPositions.push(node.getStart(sf));
    }

    // Destructuring: const { x } = args
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isArgsIdentifier(node.initializer)
    ) {
      accessPositions.push(node.name.getStart(sf));
    }

    if (isJsonParseArgsCall(node)) {
      guardPositions.push(node.getStart(sf));
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  if (accessPositions.length === 0) return [];

  const firstGuardPos = guardPositions.length > 0 ? Math.min(...guardPositions) : Infinity;

  return accessPositions
    .filter((pos) => pos < firstGuardPos)
    .map((pos) => ({ pos, label: "args data access without defensive parse" }));
}

// ---------------------------------------------------------------------------
// checkMetaLiteral — verify that `export const meta = <init>` exists at the
// top level and that <init> is a pure-literal ObjectLiteralExpression.
// Records violations into the provided array.
// ---------------------------------------------------------------------------
function checkMetaLiteral(sf) {
  const violations = [];

  let metaFound = false;

  for (const stmt of sf.statements) {
    // Look for: export const meta = ...
    if (!ts.isVariableStatement(stmt)) continue;
    const mods = stmt.modifiers ?? [];
    const hasExport = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) continue;

    const decls = stmt.declarationList.declarations;
    for (const decl of decls) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== "meta") continue;
      metaFound = true;

      if (!decl.initializer) {
        violations.push({
          pos: decl.getStart(sf),
          label: "meta: missing initializer",
        });
        continue;
      }

      if (!ts.isObjectLiteralExpression(decl.initializer)) {
        violations.push({
          pos: decl.initializer.getStart(sf),
          label: `meta: initializer must be an object literal (got ${ts.SyntaxKind[decl.initializer.kind]})`,
        });
        continue;
      }

      // Walk the object literal checking each property value for purity.
      // Catch-all: any member that is not a plain PropertyAssignment
      // (MethodDeclaration, GetAccessor, SetAccessor, etc.) is rejected
      // because it embeds executable code in a supposedly pure-literal object.
      const obj = decl.initializer;
      for (const prop of obj.properties) {
        if (ts.isSpreadAssignment(prop)) {
          violations.push({
            pos: prop.getStart(sf),
            label: "meta: spread not allowed in meta literal",
          });
          continue;
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          violations.push({
            pos: prop.getStart(sf),
            label: "meta: shorthand property (identifier reference) not allowed in meta literal",
          });
          continue;
        }
        // MethodDeclaration, GetAccessor, SetAccessor, and any other
        // non-PropertyAssignment member embed executable code — reject all.
        if (!ts.isPropertyAssignment(prop)) {
          const kindName = ts.SyntaxKind[prop.kind];
          violations.push({
            pos: prop.getStart(sf),
            label: `meta: non-literal member (${kindName}) not allowed in meta literal`,
          });
          continue;
        }
        // prop is PropertyAssignment from here
        if (ts.isComputedPropertyName(prop.name)) {
          violations.push({
            pos: prop.name.getStart(sf),
            label: "meta: computed property key not allowed in meta literal",
          });
          continue;
        }
        if (!isLiteralValue(prop.initializer)) {
          const kindName = ts.SyntaxKind[prop.initializer.kind];
          violations.push({
            pos: prop.initializer.getStart(sf),
            label: `meta: non-literal value (${kindName}) in meta property '${ts.isIdentifier(prop.name) ? prop.name.text : "?"}'`,
          });
        }
      }
    }
  }

  if (!metaFound) {
    violations.push({
      pos: 0,
      label: "meta: missing top-level 'export const meta' declaration",
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// lintFile — run all checks on one file. Returns an array of violation strings
// like "  line:col banned: <construct>", or a parse error string.
// ---------------------------------------------------------------------------
function lintFile(filePath) {
  let src;
  try {
    src = readFileSync(filePath, "utf8");
  } catch (err) {
    process.stderr.write(
      `CANON ERROR [workflows-lint]: cannot read '${filePath}': ${err.message}\n`,
    );
    process.exit(1);
  }

  const { sf, parseError, diags = [] } = parse(filePath, src);

  // Belt-and-suspenders TS-syntax detection: if ANY parse diagnostic belongs to the
  // TS-only-syntax family (codes 8009–8013, "can only be used in TypeScript files"),
  // classify this as a TS syntax violation — NOT a generic parse error.
  //
  // Current TypeScript (6.x) attaches a .type AST node for type annotations in JS mode
  // without emitting a diagnostic, so this path is dormant today.  A future TS bump that
  // starts emitting code 8010 ("Type annotations can only be used in TypeScript files")
  // as a parseDiagnostic would otherwise relabel the bad-ts-syntax fixture as a generic
  // "parse error" instead of "TS syntax".  This pre-check ensures the correct label
  // regardless of which TS version is installed.
  if (parseError && hasTsOnlySyntaxDiag(diags)) {
    return [`  1:1 banned: TS syntax (type annotation)`];
  }

  if (parseError) {
    return [`  1:1 banned: parse error: ${parseError}`];
  }

  const banViolations = walkBans(sf);
  const metaViolations = checkMetaLiteral(sf);
  const argsViolations = checkArgsDefensiveParse(sf);

  const all = [
    ...banViolations.map(({ pos, label }) => ({
      lc: lineCol(sf, pos),
      label,
    })),
    ...metaViolations.map(({ pos, label }) => ({
      lc: lineCol(sf, pos),
      label,
    })),
    ...argsViolations.map(({ pos, label }) => ({
      lc: lineCol(sf, pos),
      label,
    })),
  ];

  // Sort by line then column for deterministic output
  all.sort((a, b) => {
    const [al, ac] = a.lc.split(":").map(Number);
    const [bl, bc] = b.lc.split(":").map(Number);
    return al !== bl ? al - bl : ac - bc;
  });

  return all.map(({ lc, label }) => `  ${lc} banned: ${label}`);
}

// ---------------------------------------------------------------------------
// main — CLI entry point
// ---------------------------------------------------------------------------
async function main() {
  // ── Self-test probe: --probe-ts-diagnostic ─────────────────────────────────
  // Invoked by the test suite to verify hasTsOnlySyntaxDiag correctly identifies
  // TS-only-syntax diagnostic codes WITHOUT requiring a TypeScript version that
  // actually emits code 8010 for JS-mode files.
  //
  // This probe tests the DETECTION FUNCTION in isolation by constructing a fake
  // diagnostic array that simulates what a future TS version may emit for
  // `const x: string` in ScriptKind.JS mode.
  if (process.argv[2] === "--probe-ts-diagnostic") {
    // Simulate: future TS emits code 8010 for a type-annotated JS variable.
    const fakeDiags = [
      { code: 8010, messageText: "Type annotations can only be used in TypeScript files." },
    ];
    if (!hasTsOnlySyntaxDiag(fakeDiags)) {
      process.stderr.write(
        "PROBE FAILED: hasTsOnlySyntaxDiag did not detect code 8010\n",
      );
      process.exit(1);
    }
    // Also verify that a non-TS-only code (e.g. 1134) is NOT mis-classified.
    const genericDiags = [{ code: 1134, messageText: "Variable declaration expected." }];
    if (hasTsOnlySyntaxDiag(genericDiags)) {
      process.stderr.write(
        "PROBE FAILED: hasTsOnlySyntaxDiag false-positive on generic code 1134\n",
      );
      process.exit(1);
    }
    process.stdout.write("OK: TS-diagnostic path: TS syntax (type annotation)\n");
    process.exit(0);
  }

  const targetDir = process.argv[2] ?? DEFAULT_TARGET_DIR;

  // Empty or absent directory is valid (no workflows yet)
  if (!existsSync(targetDir)) {
    process.stdout.write(
      `NOTICE [workflows-lint]: target directory does not exist: ${targetDir} — no workflows to lint.\n`,
    );
    process.exit(0);
  }

  let files;
  try {
    files = readdirSync(targetDir)
      .filter((f) => f.endsWith(".js"))
      .sort() // deterministic order
      .map((f) => join(targetDir, f));
  } catch (err) {
    process.stderr.write(
      `CANON ERROR [workflows-lint]: cannot read directory '${targetDir}': ${err.message}\n`,
    );
    process.exit(1);
  }

  if (files.length === 0) {
    process.stdout.write(
      `NOTICE [workflows-lint]: no *.js files in ${targetDir} — nothing to lint.\n`,
    );
    process.exit(0);
  }

  let totalViolations = 0;

  for (const filePath of files) {
    const lines = lintFile(filePath);
    if (lines.length > 0) {
      process.stdout.write(`FAIL ${basename(filePath)}\n`);
      for (const line of lines) {
        process.stdout.write(`${line}\n`);
      }
      totalViolations += lines.length;
    }
  }

  if (totalViolations > 0) {
    process.exit(1);
  }

  // All files clean
  process.exit(0);
}

// Top-level await; any uncaught error → stderr + non-zero exit (fail-closed)
main().catch((err) => {
  process.stderr.write(
    `CANON ERROR [workflows-lint]: unexpected error: ${err?.message ?? String(err)}\n`,
  );
  process.exit(1);
});
