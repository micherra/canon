import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..", "..");
const bundleDir = path.resolve(__dirname, "..", "bundle");
const srcTgz = path.resolve(repoRoot, "dist", "cursor-canon-everything.tgz");
const dstTgz = path.resolve(bundleDir, "cursor-canon-everything.tgz");

fs.mkdirSync(bundleDir, { recursive: true });

if (!fs.existsSync(srcTgz)) {
  // Publishing should fail loudly if bundle is missing.
  throw new Error(
    `Missing bundle at ${srcTgz}. Run scripts/create-cursor-canon-bundle.sh first.`
  );
}

fs.copyFileSync(srcTgz, dstTgz);
console.log(`Prepared bundle: ${dstTgz}`);

