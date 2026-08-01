export type DiffKind = "equal" | "insert" | "delete";

interface DiffOperation {
  kind: DiffKind;
  line: string;
}

export interface DiffRow {
  kind: "equal" | "insert" | "delete" | "change";
  leftNumber?: number;
  left?: string;
  rightNumber?: number;
  right?: string;
  renumbering?: true;
}

export interface HighlightedDiffRow {
  kind: DiffRow["kind"];
  leftNumber?: number;
  leftHtml?: string;
  rightNumber?: number;
  rightHtml?: string;
  renumbering?: true;
}

function coordinate(path: Map<number, number>, diagonal: number): number {
  return path.get(diagonal) ?? Number.NEGATIVE_INFINITY;
}

function backtrack(
  trace: Map<number, number>[],
  before: string[],
  after: string[],
): DiffOperation[] {
  let x = before.length;
  let y = after.length;
  const operations: DiffOperation[] = [];

  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const path = trace[distance];
    if (path === undefined) throw new Error("Invalid diff trace");
    const diagonal = x - y;
    const insertion =
      diagonal === -distance ||
      (diagonal !== distance && coordinate(path, diagonal - 1) < coordinate(path, diagonal + 1));
    const previousDiagonal = insertion ? diagonal + 1 : diagonal - 1;
    const previousX = path.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      operations.push({ kind: "equal", line: before[x - 1] ?? "" });
      x -= 1;
      y -= 1;
    }
    if (distance === 0) break;
    if (insertion) {
      operations.push({ kind: "insert", line: after[y - 1] ?? "" });
      y -= 1;
    } else {
      operations.push({ kind: "delete", line: before[x - 1] ?? "" });
      x -= 1;
    }
  }

  return operations.reverse();
}

function operations(before: string[], after: string[]): DiffOperation[] {
  const maximumDistance = before.length + after.length;
  const trace: Map<number, number>[] = [];
  const path = new Map<number, number>([[1, 0]]);

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    trace.push(new Map(path));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x: number;
      if (
        diagonal === -distance ||
        (diagonal !== distance && coordinate(path, diagonal - 1) < coordinate(path, diagonal + 1))
      ) {
        x = path.get(diagonal + 1) ?? 0;
      } else {
        x = (path.get(diagonal - 1) ?? 0) + 1;
      }
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      path.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        return backtrack(trace, before, after);
      }
    }
  }
  throw new Error("Unable to calculate diff");
}

export function diffLines(before: string[], after: string[]): DiffRow[] {
  const result: DiffRow[] = [];
  let leftNumber = 1;
  let rightNumber = 1;
  const edits = operations(before, after);

  for (let index = 0; index < edits.length;) {
    const edit = edits[index];
    if (edit?.kind === "equal") {
      result.push({
        kind: "equal",
        leftNumber,
        left: edit.line,
        rightNumber,
        right: edit.line,
      });
      leftNumber += 1;
      rightNumber += 1;
      index += 1;
      continue;
    }

    const deleted: string[] = [];
    const inserted: string[] = [];
    while (index < edits.length && edits[index]?.kind !== "equal") {
      const changed = edits[index];
      if (changed?.kind === "delete") deleted.push(changed.line);
      if (changed?.kind === "insert") inserted.push(changed.line);
      index += 1;
    }
    const rows = Math.max(deleted.length, inserted.length);
    for (let offset = 0; offset < rows; offset += 1) {
      const left = deleted[offset];
      const right = inserted[offset];
      result.push({
        kind:
          left !== undefined && right !== undefined
            ? "change"
            : left !== undefined
              ? "delete"
              : "insert",
        leftNumber: left === undefined ? undefined : leftNumber++,
        left,
        rightNumber: right === undefined ? undefined : rightNumber++,
        right,
      });
    }
  }
  return result;
}
