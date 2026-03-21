import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..", "..");
const bundleDir = path.resolve(__dirname, "..", "bundle");
const srcTgz = path.resolve(repoRoot, "dist", "canon-cursor-everything.tgz");
const dstTgz = path.resolve(bundleDir, "canon-cursor-everything.tgz");

fs.mkdirSync(bundleDir, { recursive: true });

if (!fs.existsSync(srcTgz)) {
  // Publishing should fail loudly if bundle is missing.
  throw new Error(
    `Missing bundle at ${srcTgz}. Run scripts/create-canon-cursor-bundle.sh first.`
  );
}

fs.copyFileSync(srcTgz, dstTgz);
console.log(`Prepared bundle: ${dstTgz}`);

