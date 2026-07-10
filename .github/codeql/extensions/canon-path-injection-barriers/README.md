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
first-party function is a barrier. This pack makes the existing barrier legible to the
scanner so those alerts auto-clear on future scans.

## Trust basis

The barrier's **correctness** — that `isSafeProjectDirInput` genuinely rejects unsafe
project-dir input — is established in
[`docs/adr/0030-untrusted-project-dir-path-injection-allowlist.md`](../../../../docs/adr/0030-untrusted-project-dir-path-injection-allowlist.md).
This model **records an existing, reviewed barrier**; it is not a rubber-stamp or a
suppression. If the barrier were ever weakened, this model would silently mask real flows —
so the ADR-0030 guard logic and this model must be maintained together.

## How to verify

The next CodeQL scan applies the barrier:

- **Default setup auto-detects this pack.** No `.github/workflows/codeql.yml` is required —
  default setup scans `.github/codeql/extensions/` automatically.
- A fresh scan (push to `main`, or a PR scan if PR scanning is enabled) should report
  **0 `js/path-injection` alerts** on `validateAndNormalizeDir`.
- Locally, the pack was **A/B-verified** with the CodeQL CLI (2.26.0, `codeql/javascript-all`
  2.8.0, `codeql/javascript-queries` 2.4.0): the `js/path-injection` query
  (`Security/CWE-022/TaintedPath.ql`) reports **3 alerts** on `validateAndNormalizeDir`
  (session-manager.ts:245–246) in a baseline analysis and **0** when this pack is loaded via
  `--additional-packs <extensions-dir> --model-packs canon/path-injection-barriers`, with no
  other alert suppressed. Local analysis does not auto-detect `.github/codeql/extensions/`
  (that is a default-setup behavior), so the pack must be passed explicitly when reproducing
  locally.

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
