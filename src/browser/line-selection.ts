interface LineRange {
  start: number;
  end: number;
}

export function parseLineHash(hash: string): LineRange | undefined {
  const match = /^#L(\d+)(?:-(?:L)?(\d+))?$/.exec(hash);
  if (match?.[1] === undefined) return undefined;
  const first = Number(match[1]);
  const second = Number(match[2] ?? match[1]);
  if (first < 1 || second < 1) return undefined;
  return { start: Math.min(first, second), end: Math.max(first, second) };
}

export function formatLineHash(first: number, second = first): string {
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  return start === end ? `#L${start}` : `#L${start}-L${end}`;
}
