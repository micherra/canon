import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfigNumber } from "../utils/config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "canon-config-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

async function writeConfig(data: unknown) {
  const dir = join(tmpDir, ".canon");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(data), "utf-8");
}

describe("loadConfigNumber", () => {
  it("returns numeric value for dotted key path", async () => {
    await writeConfig({ review: { max_principles_per_review: 25 } });
    expect(await loadConfigNumber(tmpDir, "review.max_principles_per_review", 10)).toBe(25);
  });

  it("returns default when config file is missing", async () => {
    expect(await loadConfigNumber(tmpDir, "missing", 42)).toBe(42);
  });

  it("returns default for non-numeric value", async () => {
    await writeConfig({ count: "abc" });
    expect(await loadConfigNumber(tmpDir, "count", 7)).toBe(7);
  });

  it("returns default for value less than 1", async () => {
    await writeConfig({ count: 0 });
    expect(await loadConfigNumber(tmpDir, "count", 7)).toBe(7);
  });

  it("floors floating point values", async () => {
    await writeConfig({ count: 3.7 });
    expect(await loadConfigNumber(tmpDir, "count", 1)).toBe(3);
  });
});
