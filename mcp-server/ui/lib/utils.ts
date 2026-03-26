import { SEVERITY_COLORS } from "./constants";

export function splitFilePath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  return {
    dir: idx >= 0 ? path.slice(0, idx + 1) : "",
    name: idx >= 0 ? path.slice(idx + 1) : path,
  };
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

export function getSeverityColor(severity: string): string {
  return SEVERITY_COLORS[severity] ?? "#636a80";
}
