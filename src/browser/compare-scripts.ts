import type { Manifest, Script } from "../shared/viewer";
import { isRenumberedScript, type RenumberTables } from "../shared/renumbering";

export type ChangeKind = "added" | "removed" | "changed" | "renumbered" | "unchanged";

export type KindFilter = ReadonlySet<ChangeKind>;

export interface ComparedScript {
  name: string;
  kind: ChangeKind;
  left?: Script;
  right?: Script;
}

export function scriptNameParts(script: ComparedScript): {
  prefix: string;
  suffix: string;
} {
  const viewerScript = script.left ?? script.right;
  if (viewerScript === undefined) {
    return { prefix: "", suffix: script.name };
  }
  return {
    prefix: viewerScript.prefix ?? "",
    suffix: viewerScript.suffix,
  };
}

const CHANGE_KINDS: readonly ChangeKind[] = [
  "changed",
  "added",
  "removed",
  "renumbered",
  "unchanged",
];

const DEFAULT_KINDS: readonly ChangeKind[] = ["changed", "added", "removed"];

const MODIFIED_KINDS: readonly ChangeKind[] = ["changed", "added", "removed"];

const LEGACY_FILTERS: Record<string, readonly ChangeKind[]> = {
  all: CHANGE_KINDS,
  modified: MODIFIED_KINDS,
};

export function changeLabel(kind: ChangeKind): string {
  return kind === "removed" ? "deleted" : kind;
}

function isChangeKind(value: string): value is ChangeKind {
  return (CHANGE_KINDS as readonly string[]).includes(value);
}

export function parseKindFilter(value: string | null): Set<ChangeKind> {
  if (value === null || value === "") return new Set(DEFAULT_KINDS);
  if (value === "none") return new Set();
  const legacy = LEGACY_FILTERS[value];
  if (legacy !== undefined) return new Set(legacy);
  const kinds = value.split(",").filter(isChangeKind);
  return kinds.length === 0 ? new Set(DEFAULT_KINDS) : new Set(kinds);
}

export function formatKindFilter(filter: KindFilter): string {
  if (filter.size === 0) return "none";
  if (filter.size === CHANGE_KINDS.length) return "all";
  return CHANGE_KINDS.filter((kind) => filter.has(kind)).join(",");
}

export function compareManifests(
  left: Manifest,
  right: Manifest,
  tables?: RenumberTables,
): ComparedScript[] {
  const names = [...new Set([...Object.keys(left.scripts), ...Object.keys(right.scripts)])].sort();
  return names.map((name) => {
    const leftScript = left.scripts[name];
    const rightScript = right.scripts[name];
    let kind: ChangeKind;
    if (leftScript === undefined) kind = "added";
    else if (rightScript === undefined) kind = "removed";
    else if (leftScript.source === rightScript.source) kind = "unchanged";
    else if (
      tables !== undefined &&
      leftScript.masked === rightScript.masked &&
      leftScript.renumbering !== undefined &&
      rightScript.renumbering !== undefined &&
      isRenumberedScript(leftScript.renumbering, rightScript.renumbering, tables)
    ) {
      kind = "renumbered";
    } else kind = "changed";
    return { name, kind, left: leftScript, right: rightScript };
  });
}

export function formatScriptListForCopy(
  scripts: ComparedScript[],
  scope: string,
  filter: KindFilter = new Set(MODIFIED_KINDS),
): string {
  const byKind = new Map<ChangeKind, string[]>();
  for (const script of scripts) {
    const names = byKind.get(script.kind) ?? [];
    names.push(script.name);
    byKind.set(script.kind, names);
  }

  const blocks: string[] = [scope, ""];
  for (const kind of CHANGE_KINDS.filter((kind) => filter.has(kind))) {
    const names = byKind.get(kind) ?? [];
    names.sort((left, right) => left.localeCompare(right));
    blocks.push(`[${changeLabel(kind)}]`);
    if (names.length > 0) blocks.push(...names);
    blocks.push("");
  }
  return `${blocks.join("\n").trimEnd()}\n`;
}
