import { createHash } from "node:crypto";

export function sourceLines(source: string): string[] {
  if (source === "") return [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function normalizeSource(source: string): string {
  return sourceLines(source).join("\n");
}

export function hashSourceLines(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
