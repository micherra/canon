# canon-cursor (npm)

This package installs the Cursor-only Canon runner into the current repo.

## Install / Run

From a target repo root:

```bash
npx -y canon-cursor
```

Use `--force` to overwrite existing files:

```bash
npx -y canon-cursor --force
```

To install from a specific bundle tarball (optional):

```bash
npx -y canon-cursor --bundle-path /path/to/canon-cursor-everything.tgz --force
```

## Publish (maintainer)

Run:

```bash
cd canon-cursor-cli
npm publish
```

The package `prepack` step builds the embedded bundle from the parent repo.
