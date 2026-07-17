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
 * docs/adr/0061-typescript-7-tooling-parser-split.md.
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
        `(TypeScript 7 removed the JS compiler API from the 'typescript' main entry — see docs/adr/0061.)`,
    );
  }

  // BEHAVIORAL probes: parseDiagnostics is a property of the object
  // createSourceFile RETURNS, not a top-level `ts.*` member — the surface
  // assertion above cannot see it. It is also absent from typescript-parser's
  // public .d.ts (an internal, undocumented API), so it is exactly the class
  // of API that can silently vanish across an alias bump — which is this
  // seam's whole premise. Every caller that actually parses (workflows-lint,
  // dead-wire-internal-use, tool-surfacing-extract) depends on
  // parseDiagnostics to detect malformed input; a parser whose
  // createSourceFile never reports it must be refused, not silently
  // accepted. Positive assertions throughout: parse KNOWN fixtures and
  // require the exact shape a real parser produces — never a try/catch,
  // never an optional chain over the result.
  //
  // Gate: on `createSourceFile` ALONE, for every probe below. A caller that
  // declared createSourceFile parses, and therefore depends on all of this —
  // that is the actual condition, not a proxy for it. `ScriptKind` is an
  // OPTIONAL parameter of createSourceFile (a caller can parse without ever
  // declaring it), so requiring it in the GATE would be STRICTER than "does
  // this caller parse?" (a prior fix made exactly this mistake). ScriptKind
  // IS used inside the TS-mode probe below, but only after being explicitly
  // asserted present — the assertion is internal to the probe, not a
  // condition on whether the probe runs at all.
  if (requiredApis.includes("createSourceFile")) {
    // ts.ScriptTarget.Latest is needed to construct every probe call below,
    // regardless of whether the CALLER declared "ScriptTarget" — asserted
    // explicitly (positive presence check, not a fallback) because a caller
    // that parses without ever declaring ScriptTarget is itself a contract
    // violation worth failing on loudly, not a case to route around.
    if (ts?.ScriptTarget?.Latest === undefined) {
      fail(
        scriptName,
        `cannot run the parser probes: '${PARSER_SPECIFIER}' is missing ScriptTarget.Latest, ` +
          `required to construct probe calls to createSourceFile. This caller declared createSourceFile ` +
          `but the parser dependency lacks a member the probes themselves need to verify it.`,
      );
    }

    // Probe A — malformed JS. ScriptKind.JS is explicitly asserted present
    // and passed as the 5th createSourceFile argument — matching the real
    // JS caller's exact call shape (workflows-lint.mjs:140 always passes
    // ts.ScriptKind.JS explicitly; it is never omitted in practice, even
    // though the parameter is optional). A probe that omits an argument
    // its real caller always supplies asks a DIFFERENT question of the
    // parser than the one that matters — see the call-shape-parity note
    // above Probe C, which is where this was caught (harden-4).
    if (ts?.ScriptKind?.JS === undefined) {
      fail(
        scriptName,
        `cannot run the JS-mode parseDiagnostics probe: '${PARSER_SPECIFIER}' is missing ScriptKind.JS, ` +
          `required to construct the probe's call to createSourceFile with the same argument vector the ` +
          `real JS caller (workflows-lint.mjs) uses. This caller declared createSourceFile but the parser ` +
          `dependency lacks a member the probe itself needs.`,
      );
    }
    const probeJs = ts.createSourceFile(
      "__canon_parse_probe_js__.js",
      "const x = ;",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    if (!Array.isArray(probeJs.parseDiagnostics) || probeJs.parseDiagnostics.length === 0) {
      fail(
        scriptName,
        `'${PARSER_SPECIFIER}' createSourceFile does not report parseDiagnostics for known-malformed ` +
          `JS input — refusing to run (fail-closed). parseDiagnostics is an internal API absent from the ` +
          `public .d.ts; re-verify this probe after any typescript-parser version bump — see docs/adr/0061.`,
      );
    }

    // Probe B — malformed TS, a structurally DIFFERENT fixture parsed under
    // a DIFFERENT ScriptKind. Probe A alone can be defeated by a stub that
    // special-cases one exact string; defeating both probe A and probe B
    // requires special-casing two unrelated strings across two ScriptKinds,
    // which is outside the version-drift threat model this seam defends
    // against. ScriptKind.TS is explicitly asserted present before use —
    // same discipline as ScriptTarget above, not folded into the outer gate.
    if (ts?.ScriptKind?.TS === undefined) {
      fail(
        scriptName,
        `cannot run the TS-mode parseDiagnostics probe: '${PARSER_SPECIFIER}' is missing ScriptKind.TS, ` +
          `required to construct the probe's TypeScript-mode call to createSourceFile. This caller ` +
          `declared createSourceFile but the parser dependency lacks a member the probe itself needs.`,
      );
    }
    const probeTs = ts.createSourceFile(
      "__canon_parse_probe_ts__.ts",
      "interface Foo { bar: ; }",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    if (!Array.isArray(probeTs.parseDiagnostics) || probeTs.parseDiagnostics.length === 0) {
      fail(
        scriptName,
        `'${PARSER_SPECIFIER}' createSourceFile does not report parseDiagnostics for known-malformed ` +
          `TS input — refusing to run (fail-closed). See docs/adr/0061.`,
      );
    }

    // Probes C+D+E — AST shape, one per ScriptKind the real callers use.
    // A parser could pass both diagnostic probes above (correctly detect
    // malformed input) yet still return a structurally wrong or empty tree
    // for VALID input, silently breaking every downstream ban-walk and
    // binding count even while "looking" healthy. The three real callers
    // span exactly THREE ScriptKinds: workflows-lint parses JS;
    // dead-wire-internal-use and tool-surfacing-extract (both fail-closed
    // safety hooks) branch per file extension to either TS or TSX — a
    // distinct enum value selecting the JSX grammar, not a variant of TS.
    // All three modes are probed on this axis. forEachChild is explicitly
    // asserted present once, shared by all three.
    if (ts?.forEachChild === undefined) {
      fail(
        scriptName,
        `cannot run the AST-shape probes: '${PARSER_SPECIFIER}' is missing forEachChild, required to ` +
          `verify the returned tree is walkable. This caller declared createSourceFile but the parser ` +
          `dependency lacks a member the probes themselves need.`,
      );
    }

    // Probe C — JS shape. Parse a known-valid, single-statement JS source
    // and require both the expected statement count AND a real, walkable
    // tree via the same forEachChild API real callers use for their own
    // AST walks — not just that some object came back.
    //
    // CALL-SHAPE PARITY (harden-4): this probe must issue createSourceFile
    // with the EXACT argument vector its real caller uses, not merely a
    // call that happens to produce the same result today. workflows-lint.mjs
    // line 140 always passes ts.ScriptKind.JS explicitly as the 5th
    // argument — never omits it. A probe that omits ScriptKind (leaving it
    // `undefined`) asks the parser a structurally DIFFERENT question than
    // the real caller does; a drifted/degraded parser can answer those two
    // questions differently even though today's real parser does not. A
    // reviewer proved this executable: a stub correct for every probe
    // call as issued (keyed to `scriptKind === undefined` here) but
    // degenerate for the SAME source under explicit ScriptKind.JS passed
    // this seam cleanly while returning an empty, unwalkable tree when
    // workflows-lint.mjs's own real call shape was replayed against real
    // workflow source. ScriptKind.JS is asserted present once, above (for
    // Probe A), and reused here — not re-asserted.
    const shapeSrcJs = "const y = 1;";
    const shapeProbeJs = ts.createSourceFile(
      "__canon_ast_shape_probe_js__.js",
      shapeSrcJs,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    if (!Array.isArray(shapeProbeJs.statements) || shapeProbeJs.statements.length !== 1) {
      fail(
        scriptName,
        `'${PARSER_SPECIFIER}' returned a structurally wrong AST for a known-valid JS source ` +
          `('${shapeSrcJs}') — expected exactly 1 top-level statement. Refusing to run (fail-closed): a ` +
          `parser that misreports statement structure could silently misfire downstream ban-walks and ` +
          `binding counts even while parseDiagnostics behaves correctly. See docs/adr/0061.`,
      );
    }
    let shapeChildCountJs = 0;
    ts.forEachChild(shapeProbeJs, () => {
      shapeChildCountJs++;
    });
    if (shapeChildCountJs === 0) {
      fail(
        scriptName,
        `'${PARSER_SPECIFIER}' returned a SourceFile whose forEachChild walk reached zero children for ` +
          `a known-valid single-statement JS source ('${shapeSrcJs}') — the tree is not walkable. ` +
          `Refusing to run (fail-closed). See docs/adr/0061.`,
      );
    }

    // Probe D — TS shape, mirroring Probe C. A type-annotated, known-valid
    // TS source parsed under explicit ScriptKind.TS (already asserted
    // present above, for Probe B — reused here, not re-asserted) — one of
    // the two modes dead-wire-internal-use and tool-surfacing-extract
    // actually parse in.
    const shapeSrcTs = "const y: number = 1;";
    const shapeProbeTs = ts.createSourceFile(
      "__canon_ast_shape_probe_ts__.ts",
      shapeSrcTs,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    if (!Array.isArray(shapeProbeTs.statements) || shapeProbeTs.statements.length !== 1) {
      fail(
        scriptName,
        `'${PARSER_SPECIFIER}' returned a structurally wrong AST for a known-valid TS source ` +
          `('${shapeSrcTs}') — expected exactly 1 top-level statement. Refusing to run (fail-closed): a ` +
          `parser that misreports statement structure could silently misfire downstream ban-walks and ` +
          `binding counts even while parseDiagnostics behaves correctly. See docs/adr/0061.`,
      );
    }
    let shapeChildCountTs = 0;
    ts.forEachChild(shapeProbeTs, () => {
      shapeChildCountTs++;
    });
    if (shapeChildCountTs === 0) {
      fail(
        scriptName,
        `'${PARSER_SPECIFIER}' returned a SourceFile whose forEachChild walk reached zero children for ` +
          `a known-valid single-statement TS source ('${shapeSrcTs}') — the tree is not walkable. ` +
          `Refusing to run (fail-closed). See docs/adr/0061.`,
      );
    }

    // Probe E — TSX shape, mirroring Probe D under the JSX grammar.
    // ScriptKind.TSX (4) is a distinct createSourceFile argument from
    // ScriptKind.TS (3) — both real TS-mode callers branch to it for
    // ".tsx" files. Reuses the same JSX-free, type-annotated fixture as
    // Probe D on purpose: the only variable this probe isolates is the
    // ScriptKind argument itself, so a parser that keys correctly off
    // source text but not off ScriptKind cannot pass by accident.
    // ScriptKind.TSX is explicitly asserted present, same discipline as
    // ScriptKind.TS above — not folded into the outer gate.
    if (ts?.ScriptKind?.TSX === undefined) {
      fail(
        scriptName,
        `cannot run the TSX-mode AST-shape probe: '${PARSER_SPECIFIER}' is missing ScriptKind.TSX, ` +
          `required to construct the probe's TSX-mode call to createSourceFile. This caller declared ` +
          `createSourceFile but the parser dependency lacks a member the probe itself needs.`,
      );
    }
    const shapeProbeTsx = ts.createSourceFile(
      "__canon_ast_shape_probe_tsx__.tsx",
      shapeSrcTs,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    if (!Array.isArray(shapeProbeTsx.statements) || shapeProbeTsx.statements.length !== 1) {
      fail(
        scriptName,
        `'${PARSER_SPECIFIER}' returned a structurally wrong AST for a known-valid TSX source ` +
          `('${shapeSrcTs}') — expected exactly 1 top-level statement. Refusing to run (fail-closed): a ` +
          `parser that misreports statement structure could silently misfire downstream ban-walks and ` +
          `binding counts even while parseDiagnostics behaves correctly. See docs/adr/0061.`,
      );
    }
    let shapeChildCountTsx = 0;
    ts.forEachChild(shapeProbeTsx, () => {
      shapeChildCountTsx++;
    });
    if (shapeChildCountTsx === 0) {
      fail(
        scriptName,
        `'${PARSER_SPECIFIER}' returned a SourceFile whose forEachChild walk reached zero children for ` +
          `a known-valid single-statement TSX source ('${shapeSrcTs}') — the tree is not walkable. ` +
          `Refusing to run (fail-closed). See docs/adr/0061.`,
      );
    }
  }

  return ts;
}
