# cursor-canon (npm)

This package installs the Cursor-only Canon runner into the current repo.

## Install / Run

From a target repo root:

```bash
npx -y cursor-canon
```

Use `--force` to overwrite existing files:

```bash
npx -y cursor-canon --force
```

To install from a specific bundle tarball (optional):

```bash
npx -y cursor-canon --bundle-path /path/to/cursor-canon-everything.tgz --force
```

## Publish (maintainer)

Run:

```bash
cd cursor-canon-cli
npm publish
```

The package `prepack` step builds the embedded bundle from the parent repo.

