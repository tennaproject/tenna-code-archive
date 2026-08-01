import type { HighlightedDiffRow } from "./diff";

interface DiffHunk {
  start: number;
  end: number;
}

export function diffHunks(rows: HighlightedDiffRow[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let start: number | undefined;

  for (const [index, row] of rows.entries()) {
    const changed = row.kind !== "equal" && row.renumbering !== true;
    if (changed && start === undefined) start = index;
    if (!changed && start !== undefined) {
      hunks.push({ start, end: index });
      start = undefined;
    }
  }
  if (start !== undefined) hunks.push({ start, end: rows.length });

  return hunks;
}
