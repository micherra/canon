import { randomBytes } from "node:crypto";

/** Generate a prefixed ID with date stamp and random suffix. */
export function generateId(prefix: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${prefix}_${y}${m}${d}_${randomBytes(8).toString("hex")}`;
}
