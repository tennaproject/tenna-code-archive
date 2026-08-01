import type { HighlightedDiffRow } from "./diff";

export type DiffWorkerResponse =
  { id: number; rows: HighlightedDiffRow[] } | { id: number; error: string };

const DIFF_KINDS = new Set(["equal", "insert", "delete", "change"]);

function optionalLineNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  );
}

function optionalHtml(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isHighlightedDiffRow(value: unknown): value is HighlightedDiffRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.kind === "string" &&
    DIFF_KINDS.has(row.kind) &&
    optionalLineNumber(row.leftNumber) &&
    optionalLineNumber(row.rightNumber) &&
    optionalHtml(row.leftHtml) &&
    optionalHtml(row.rightHtml) &&
    (row.renumbering === undefined || row.renumbering === true)
  );
}

export function diffResponseId(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function parseDiffWorkerResponse(value: unknown): DiffWorkerResponse {
  const id = diffResponseId(value);
  if (id === undefined) throw new Error("Invalid diff worker response");
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") return { id, error: record.error };
  if (
    record.error !== undefined ||
    !Array.isArray(record.rows) ||
    !record.rows.every(isHighlightedDiffRow)
  ) {
    throw new Error("Invalid diff worker response");
  }
  return { id, rows: record.rows as HighlightedDiffRow[] };
}
