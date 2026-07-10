# canon/path-injection-barriers — CodeQL model pack

A repository-local CodeQL **model pack** that teaches CodeQL's dataflow engine to
recognize `isSafeProjectDirInput` as a `js/path-injection` **barrier guard**.

## What

A declarative [models-as-data](https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-javascript/)
data extension — no query language, no TypeScript, no CI workflow. It registers a
single `barrierGuardModel` tuple:

```yaml
# models/safe-project-dir.model.yml
- ["'@shared/lib/safe-project-dir.ts'", "Member[isSafeProjectDirInput].Argument[0]", "true", "path-injection"]
```

Read as: when `isSafeProjectDirInput(dir)` returns `true`, its argument 0 (`dir`) is a
safe path for the `path-injection` kind. This is a **guard** (validator) model, not a
`barrierModel`: `isSafeProjectDirInput` returns a boolean and is used as
`if (!isSafeProjectDirInput(dir)) return …` — the untransformed `dir` reaches the fs
sink, so a return-value `barrierModel` would be incorrect.

The `type` column is the **module-import specifier** of the first-party module that
defines the guard (`@shared/lib/safe-project-dir.ts`), **wrapped in single quotes**.
The quoting is load-bearing: CodeQL's JS models-as-data splits an unquoted `type` on
`.` into `<package>.<qualifiedName>`, so the `.ts` suffix would be mis-parsed and the
model would silently fail to apply. `"global"` does not work here — the guard is a
first-party ES-module export, not a global. This form was confirmed empirically (see
"How to verify").

## Why

CodeQL default-setup scanning raises `js/path-injection` alerts (#18/#19/#20) on
`validateAndNormalizeDir` in `mcp-server/src/app/mcp-http/session-manager.ts`. These are
**true false positives**: every filesystem sink in that function is already routed behind
the `isSafeProjectDirInput` guard, but CodeQL's built-in library models do not know that
first-party function is a barrier. This pack encodes that barrier as a `barrierGuardModel`
so the CodeQL engine can see it.

**Important — GitHub code-scanning does NOT apply this pack at scan time.** JavaScript/TypeScript
model packs are unsupported by GitHub code scanning: default setup's `.github/codeql/extensions/`
auto-detection is limited to C/C++, C#, Java/Kotlin, Python, Ruby, and Rust (JS/TS excluded at the
product layer), and advanced-setup `codeql-action` treats a config `packs:` entry as a registry
download — a repo-local, unpublished pack 403s. So on GitHub, this pack is **inert**. It applies
**only** via an explicit CodeQL CLI invocation (`--extension-packs` / `--model-packs`), where it was
A/B-verified to take the three alerts from 3 → 0 on the exact default suite GitHub runs. The three
alerts (#18/#19/#20) are handled by **manual false-positive dismissal** (ADR-0030), not by this pack.
The pack is retained as **executable, A/B-verified documentation** of the barrier, and is
**future-ready** for if/when GitHub adds JS/TS model-pack support (or an explicit direct-CLI CodeQL
workflow is added to this repo).

## Trust basis

The barrier's **correctness** — that `isSafeProjectDirInput` genuinely rejects unsafe
project-dir input — is established in
[`docs/adr/0030-untrusted-project-dir-path-injection-allowlist.md`](../../../../docs/adr/0030-untrusted-project-dir-path-injection-allowlist.md).
This model **records an existing, reviewed barrier**; it is not a rubber-stamp or a
suppression. If the barrier were ever weakened, this model would silently mask real flows —
so the ADR-0030 guard logic and this model must be maintained together.

## How to verify

The barrier model is verified **only** by an explicit CodeQL CLI invocation — GitHub
code-scanning scans do NOT apply it (see "Why", and the maintenance note below):

- **A/B-verified** with the CodeQL CLI (2.26.0, `codeql/javascript-all` 2.8.0,
  `codeql/javascript-queries` 2.4.0) against the exact suite GitHub default setup runs
  (`javascript-code-scanning.qls`): the `js/path-injection` query
  (`Security/CWE-022/TaintedPath.ql`) reports **3 alerts** on `validateAndNormalizeDir`
  (session-manager.ts:245–246) in a baseline analysis and **0** when this pack is loaded via
  `--additional-packs <extensions-dir> --model-packs canon/path-injection-barriers` (or the
  equivalent `--extension-packs`), with no other alert suppressed.
- **This does NOT translate to GitHub scans.** There is no auto-detection path — default OR
  advanced — that loads a JavaScript/TypeScript model pack: default-setup `.github/codeql/extensions/`
  auto-detection excludes JS/TS, and `codeql-action`'s config `packs:` 403s on a repo-local
  unpublished pack. The empirical proof of both facts is recorded in the build's
  `PROBE-FINDINGS-advsetup.md`. A GitHub scan therefore still reports the 3 alerts; they are
  **dismissed as false-positive** on the platform (ADR-0030), which is the closure.
- To reproduce the 3 → 0 result you must pass the pack explicitly to a local CLI run — the pack
  is never applied implicitly.

## Maintenance

- If `isSafeProjectDirInput` is **renamed**, update the `Member[isSafeProjectDirInput]`
  segment in `models/safe-project-dir.model.yml`.
- If the module is **moved** (or the import specifier at the call site changes), update the
  `type` column to the new single-quoted specifier. The `type` matches the import specifier
  literally — keep it in sync with `import { … } from "…"` in the consuming file.
- Do **not** remove the single quotes around the specifier — see the model file comment
  (unquoted, the `.ts` suffix is mis-parsed and the barrier silently stops applying).
- If the guard's logic is materially changed, re-confirm with ADR-0030 that it remains a
  sound path-injection barrier before trusting this model.
