/**
 * tool-surfacing-extract.mjs — TypeScript-compiler-API tool-registration
 *   name extractor for the tool-surfacing "dead-affordance" gate (ADR-0048).
 *
 * SYNOPSIS
 *   node tool-surfacing-extract.mjs <file> [<file> ...]
 *
 * INPUTS
 *   <file>  One or more absolute or relative paths to TypeScript registration
 *           files (mcp-server/src/app/register-*.ts, create-server.ts).
 *
 * OUTPUT (stdout)
 *   One "<name>\t<0|1>" row per resolved tool registration, across all input
 *   files, in file-then-source order. <name> is the registered tool name;
 *   the trailing bit is 1 when a `canon:allow-unsurfaced:` marker appears on
 *   the PHYSICAL SOURCE LINE of the name-literal argument, else 0. This is a
 *   drop-in for the shell gate's REG_RAW format. Zero rows (empty stdout) is
 *   a valid success output when no input file contains a matched call.
 *
 * MATCHING RULE
 *   Every `CallExpression` whose callee is:
 *     - the bare identifier `registerTool` or `registerToolWithUi`, OR
 *     - a `PropertyAccessExpression` ending in `.registerTool` or
 *       `.registerToolWithUi` (the `server.registerTool(...)` member form), OR
 *     - an `ElementAccessExpression` whose computed member is a string
 *       literal `"registerTool"` or `"registerToolWithUi"` (the
 *       `server["registerTool"](...)` computed-member form)
 *   is a MATCHED registration call. The name-literal argument is
 *   `arguments[1]` for `registerToolWithUi` (its first positional is the
 *   `server` handle) and `arguments[0]` for `registerTool`.
 *
 *   Because comments and string-literal text are not `CallExpression` nodes,
 *   a `// server.registerTool("x")` comment or a
 *   `"...server.registerTool..."` string mention is never matched — no
 *   regex-based exclusion is needed, unlike the line-parser this replaces.
 *
 *   The `canon:allow-unsurfaced:` marker attaches to a call ONLY if it
 *   appears after that call's name-literal argument and before the next
 *   matched call's start on the same physical line (or before end-of-line
 *   when no further call follows on that line). This prevents a marker
 *   trailing the LAST of several calls packed on one source line from being
 *   inherited by the earlier calls on that same line.
 *
 * FAIL-CLOSED GUARANTEE
 *   ANY error (missing `typescript` module, ENOENT, syntactic parse errors,
 *   or a matched call whose name argument is not a resolvable string
 *   literal matching `^[a-z][a-z0-9_]*$`) causes exit 1 with a
 *   "CANON ERROR [tool-surfacing-extract]" diagnostic naming the file and
 *   position — an unresolvable registration must never be silently dropped
 *   (that is the fail-open class this rewrite closes). Exit 0 with rows
 *   printed to stdout is the ONLY success path.
 *
 * KNOWN LIMITATIONS (out of the accidental-omission threat model, fail-open)
 *   - Aliased-import call forms are NOT resolved:
 *     `import { registerTool as rt } from "..."; rt(...)` requires
 *     TypeScript binding/type-checker resolution (tracing `rt` back to its
 *     import specifier) to catch — deliberately not implemented here, since
 *     this rewrite's threat model is accidental omission via source-form
 *     variation (line-packing, multiline splits, computed-member access),
 *     not deliberate obfuscation of the callee identifier itself.
 *   - Computed string-member access (`server["registerTool"](...)`) IS
 *     handled (see MATCHING RULE above) — this was the one computed-access
 *     gap in scope for this rewrite and is now closed.
 *
 * MODULE RESOLUTION
 *   This script MUST reside under mcp-server/ so the bare specifier
 *   "typescript" resolves against mcp-server/node_modules (ESM resolves bare
 *   specifiers relative to the importing file, not cwd) — identical
 *   constraint to dead-wire-internal-use.mjs.
 *
 * EXIT CODES
 *   0  Success: rows printed to stdout (may be zero rows).
 *   1  Any error: bad args, file unreadable, typescript missing, syntactic
 *      parse error, unresolved name argument.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REGISTRATION_METHODS = new Set(["registerTool", "registerToolWithUi"]);
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MARKER_TEXT = "canon:allow-unsurfaced:";

function fail(message) {
  process.stderr.write(`CANON ERROR [tool-surfacing-extract]: ${message}\n`);
  process.exit(1);
}

// Returns the registration method name ("registerTool" | "registerToolWithUi")
// for a CallExpression's callee, or null if the callee is not a matched form.
function matchedMethodName(ts, callee) {
  if (ts.isIdentifier(callee) && REGISTRATION_METHODS.has(callee.text)) {
    return callee.text;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.name) &&
    REGISTRATION_METHODS.has(callee.name.text)
  ) {
    return callee.name.text;
  }
  if (
    ts.isElementAccessExpression(callee) &&
    callee.argumentExpression &&
    ts.isStringLiteral(callee.argumentExpression) &&
    REGISTRATION_METHODS.has(callee.argumentExpression.text)
  ) {
    return callee.argumentExpression.text;
  }
  return null;
}

async function main() {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    fail("expected at least 1 file argument, got 0");
  }

  let ts;
  try {
    const mod = await import("typescript");
    ts = mod.default ?? mod;
  } catch (err) {
    fail(`cannot import 'typescript': ${err.message}`);
  }

  const rows = [];

  for (const fileArg of files) {
    const filePath = resolve(fileArg);

    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch (err) {
      fail(`cannot read file '${filePath}': ${err.message}`);
    }

    const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      filePath,
      src,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    // Parse-diagnostic guard (fail-closed on malformed input): a syntactically
    // broken file can produce a partial/recovered AST where registration
    // calls silently fail to resolve as CallExpression nodes — the same
    // false-DEAD risk dead-wire-internal-use.mjs guards against.
    const parseDiags = sourceFile.parseDiagnostics;
    if (parseDiags && parseDiags.length > 0) {
      const firstMsg =
        typeof parseDiags[0]?.messageText === "string"
          ? parseDiags[0].messageText
          : (parseDiags[0]?.messageText?.messageText ?? "(unknown)");
      fail(
        `file '${filePath}' has ${parseDiags.length} syntactic parse error(s); cannot reliably extract registrations. First error: ${firstMsg}`,
      );
    }

    // Returns the physical source line's text containing `pos`.
    function lineTextAt(pos) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(pos);
      const lines = src.split(/\r?\n/);
      return lines[line] ?? "";
    }

    // Returns 1 iff MARKER_TEXT appears strictly after `nameArg`'s own
    // position and strictly before the next matched call's start ON THE
    // SAME PHYSICAL LINE (or before end-of-line when no further call
    // follows on that line). Narrows marker attachment to the call it
    // actually trails — two calls packed on one line no longer both inherit
    // a marker meant only for the second (Finding 2).
    function hasMarkerFor(nameArg, nextCallNode) {
      const startPos = nameArg.getStart();
      const { line: startLine, character: startChar } =
        sourceFile.getLineAndCharacterOfPosition(startPos);
      const lineText = lineTextAt(startPos);
      let windowEndChar = lineText.length;
      if (nextCallNode) {
        const { line: nextLine, character: nextChar } = sourceFile.getLineAndCharacterOfPosition(
          nextCallNode.getStart(),
        );
        if (nextLine === startLine) {
          windowEndChar = nextChar;
        }
      }
      if (startChar >= windowEndChar) {
        return 0;
      }
      return lineText.slice(startChar, windowEndChar).includes(MARKER_TEXT) ? 1 : 0;
    }

    const matches = [];

    function visit(node) {
      if (ts.isCallExpression(node)) {
        const methodName = matchedMethodName(ts, node.expression);
        if (methodName) {
          const nameArgIndex = methodName === "registerToolWithUi" ? 1 : 0;
          const nameArg = node.arguments[nameArgIndex];
          if (!nameArg || !ts.isStringLiteral(nameArg) || !NAME_PATTERN.test(nameArg.text)) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(
              node.getStart(),
            );
            fail(
              `unresolvable registration in '${filePath}' at line ${line + 1}, column ${character + 1} — ${methodName}(...) name argument is not a resolvable string literal`,
            );
          }
          matches.push({ node, nameArg });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    for (let i = 0; i < matches.length; i++) {
      const { nameArg } = matches[i];
      const nextCallNode = matches[i + 1] ? matches[i + 1].node : null;
      const hasMarker = hasMarkerFor(nameArg, nextCallNode);
      rows.push(`${nameArg.text}\t${hasMarker}`);
    }
  }

  process.stdout.write(rows.length > 0 ? rows.join("\n") + "\n" : "");
}

main().catch((err) => {
  fail(`unexpected error: ${err?.message ?? String(err)}`);
});
