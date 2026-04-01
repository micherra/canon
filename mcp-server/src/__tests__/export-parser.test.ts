import { describe, expect, it } from "vitest";
import { extractExports } from "../graph/export-parser.ts";

describe("extractExports", () => {
  describe("JavaScript/TypeScript", () => {
    it("extracts exported functions", () => {
      const content = `
export function handler() {}
export async function processOrder() {}
function internal() {}
`;
      expect(extractExports(content, "api.ts")).toEqual(["handler", "processOrder"]);
    });

    it("extracts exported classes", () => {
      const content = `export class OrderService {}\nclass Internal {}`;
      expect(extractExports(content, "service.ts")).toEqual(["OrderService"]);
    });

    it("extracts exported interfaces and types", () => {
      const content = `
export interface OrderInput {}
export type OrderOutput = {}
interface Internal {}
`;
      expect(extractExports(content, "types.ts")).toEqual(["OrderInput", "OrderOutput"]);
    });

    it("extracts exported constants", () => {
      const content = `
export const MAX_RETRIES = 3;
export let counter = 0;
export var legacy = true;
const internal = 'nope';
`;
      expect(extractExports(content, "config.ts")).toEqual(["MAX_RETRIES", "counter", "legacy"]);
    });

    it("extracts exported enums", () => {
      const content = `export enum Status { Active, Inactive }`;
      expect(extractExports(content, "enums.ts")).toEqual(["Status"]);
    });

    it("extracts default exports with names", () => {
      const content = `export default function main() {}\nexport default class App {}`;
      expect(extractExports(content, "app.ts")).toEqual(["main", "App"]);
    });

    it("extracts named exports from export blocks", () => {
      const content = `
const a = 1;
const b = 2;
export { a, b };
`;
      expect(extractExports(content, "utils.ts")).toEqual(["a", "b"]);
    });

    it("handles aliased exports", () => {
      const content = `export { internal as publicName, other as otherName };`;
      expect(extractExports(content, "index.ts")).toEqual(["publicName", "otherName"]);
    });

    it("deduplicates exports", () => {
      const content = `
export function handler() {}
export { handler };
`;
      expect(extractExports(content, "api.ts")).toEqual(["handler"]);
    });

    it("returns empty for no exports", () => {
      const content = `const x = 1;\nfunction internal() {}`;
      expect(extractExports(content, "internal.ts")).toEqual([]);
    });
  });

  describe("Python", () => {
    it("extracts top-level functions and classes", () => {
      const content = `
def process_order():
    pass

class OrderService:
    pass

def _internal():
    pass
`;
      expect(extractExports(content, "service.py")).toEqual(["process_order", "OrderService"]);
    });

    it("respects __all__ as authoritative", () => {
      const content = `
__all__ = ['public_func', 'PublicClass']

def public_func():
    pass

def other_func():
    pass

class PublicClass:
    pass
`;
      expect(extractExports(content, "module.py")).toEqual(["public_func", "PublicClass"]);
    });

    it("skips private names (starting with _)", () => {
      const content = `
def public_func():
    pass

def _private_func():
    pass
`;
      expect(extractExports(content, "utils.py")).toEqual(["public_func"]);
    });
  });

  it("returns empty for unsupported extensions", () => {
    expect(extractExports("package main", "main.go")).toEqual([]);
  });
});
