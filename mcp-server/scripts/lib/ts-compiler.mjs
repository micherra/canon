/**
 * ts-compiler.mjs — the ONE place Canon's lint tooling obtains a TypeScript
 * compiler API.
 *
 * FAIL-CLOSED CONTRACT: this module either returns a fully-functional API or
 * terminates the process with a non-zero exit. It must NEVER return a
 * partial, stubbed, or degraded API, and must never swallow an import
 * failure — a linter that cannot parse must fail, not pass.
 * (fail-closed-by-default)
 *
 * Why an alias: TypeScript 7 is the Go port; `import "typescript"` yields
 * only { version, versionMajorMinor } — the entire JS compiler API is gone
 * from the main entry. The parser API lives on in typescript@6 via the
 * `typescript-parser` alias declared in mcp-server/package.json. See
 * docs/adr/0056-typescript-7-tooling-parser-split.md.
 *
 * MODULE RESOLUTION
 *   The bare specifier below is resolved by Node relative to THIS file's
 *   own location (ESM bare-specifier resolution walks up from the importing
 *   module, not cwd) — this module must stay under mcp-server/ so it
 *   resolves against mcp-server/node_modules/typescript-parser.
 */
const PARSER_SPECIFIER = "typescript-parser";

function fail(scriptName, msg) {
  process.stderr.write(`CANON ERROR [${scriptName}]: ${msg}\n`);
  process.exit(1); // fail-closed: no fallback, no return
}

/**
 * Loads the pinned TypeScript compiler API and asserts that every entry of
 * `requiredApis` is present on the resolved module.
 *
 * @param scriptName - Name of the calling script, used in error messages
 *   (e.g. "workflows-lint").
 * @param requiredApis - Array of top-level `ts.` member names the caller
 *   dereferences (e.g. "createSourceFile", "ScriptTarget"). Each caller
 *   declares its own surface so a partial API is caught here, at load time,
 *   rather than as a cryptic `undefined` deref mid-walk.
 * @returns The resolved TypeScript API object. This function either returns
 *   a fully-asserted API or terminates the process — there is no other
 *   return path.
 */
export async function loadTsCompiler(scriptName, requiredApis) {
  let mod;
  try {
    mod = await import(PARSER_SPECIFIER);
  } catch (err) {
    fail(scriptName, `cannot import '${PARSER_SPECIFIER}': ${err.message}`);
  }
  const ts = mod.default ?? mod;
  // POSITIVE assertion of the surface — not a try/catch, not an optional
  // chain. This is what turns TS7's "undefined reading 'Latest'" into a
  // named, actionable failure.
  const missing = requiredApis.filter((k) => ts?.[k] === undefined);
  if (missing.length > 0) {
    fail(
      scriptName,
      `'${PARSER_SPECIFIER}' API surface incomplete — missing: ${missing.join(", ")}. ` +
        `The parser dependency is wrong or degraded; refusing to parse. ` +
        `(TypeScript 7 removed the JS compiler API from the 'typescript' main entry — see docs/adr/0056.)`,
    );
  }

  // BEHAVIORAL probe: parseDiagnostics is a property of the object
  // createSourceFile RETURNS, not a top-level `ts.*` member — the surface
  // assertion above cannot see it. It is also absent from typescript-parser's
  // public .d.ts (an internal, undocumented API), so it is exactly the class
  // of API that can silently vanish across an alias bump — which is this
  // seam's whole premise. Every caller that actually parses (workflows-lint,
  // dead-wire-internal-use, tool-surfacing-extract) depends on
  // parseDiagnostics to detect malformed input; a parser whose
  // createSourceFile never reports it must be refused, not silently
  // accepted. Positive assertion: parse a KNOWN-malformed source and require
  // a populated parseDiagnostics array — not a try/catch, not an optional
  // chain over the result.
  //
  // Gate: on `createSourceFile` ALONE. A caller that declared createSourceFile
  // parses, and therefore depends on parseDiagnostics — that is the actual
  // condition, not a proxy for it. `ScriptKind` is an OPTIONAL parameter of
  // createSourceFile (a caller can parse without ever declaring it), so
  // requiring it in the gate would be STRICTER than "does this caller
  // parse?" and would leave a real caller shape unprobed — a narrower
  // version of the exact silent-pass hole this probe exists to close. Do
  // not add ScriptKind (or anything else) back into this gate.
  if (requiredApis.includes("createSourceFile")) {
    // The probe needs ts.ScriptTarget.Latest to construct its own call,
    // regardless of whether the CALLER declared "ScriptTarget" — asserted
    // explicitly (positive presence check, not a fallback) because a caller
    // that parses without ever declaring ScriptTarget is itself a contract
    // violation worth failing on loudly, not a case to route around.
    if (ts?.ScriptTarget?.Latest === undefined) {
      fail(
        scriptName,
        `cannot run the parseDiagnostics probe: '${PARSER_SPECIFIER}' is missing ScriptTarget.Latest, ` +
          `required to construct a probe call to createSourceFile. This caller declared createSourceFile ` +
          `but the parser dependency lacks a member the probe itself needs to verify it.`,
      );
    }
    // ScriptKind is intentionally omitted — it is optional on
    // createSourceFile, and TypeScript infers it from the probe's own
    // filename extension (".js") when omitted.
    const probe = ts.createSourceFile(
      "__canon_parse_probe__.js",
      "const x = ;",
      ts.ScriptTarget.Latest,
      true,
    );
    if (!Array.isArray(probe.parseDiagnostics) || probe.parseDiagnostics.length === 0) {
      fail(
        scriptName,
        `'${PARSER_SPECIFIER}' createSourceFile does not report parseDiagnostics for known-malformed ` +
          `input — refusing to run (fail-closed). parseDiagnostics is an internal API absent from the ` +
          `public .d.ts; re-verify this probe after any typescript-parser version bump — see docs/adr/0056.`,
      );
    }
  }

  return ts;
}
