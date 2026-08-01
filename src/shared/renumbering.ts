import { scanSourceLine, scanSourceLines, type ScanState, type SourceScan } from "./source-scanner";

export const ASSET_KINDS = ["sprites", "objects", "rooms", "sounds", "fonts"] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export type AssetTables = Record<AssetKind, string[]>;

export interface RenumberOverrides {
  neverAsset?: string[];
  assetType?: Record<string, AssetKind>;
}

export interface RenumberTables {
  left: AssetTables;
  right: AssetTables;
  overrides: RenumberOverrides;
}

export interface AssetTablesFile {
  schemaVersion: 1;
  tables: AssetTables;
  overrides: RenumberOverrides;
}

const DIGITS = /\d+/g;
const ASSIGNMENT = /^\s*([A-Za-z_][\w.]*)\s*=[^=]/;
const PATTERN_METACHARACTERS = /[.+?^${}()|[\]\\]/g;

export type RenumberToken = number | readonly [value: number, kind: AssetKind];

function maskNumbers(line: string): string {
  return line.replace(DIGITS, "#");
}

export function maskedSource(
  lines: readonly string[],
  overrides: RenumberOverrides,
  scans?: readonly SourceScan[],
): string {
  const never = overrides.neverAsset;
  const lineScans = scans?.length === lines.length ? scans : scanSourceLines(lines);
  return lines
    .map((line, index) => {
      const masked = lineScans[index]?.masked ?? scanSourceLine(line).masked;
      if (never !== undefined && matchesNeverAsset(maskNumbers(line), never)) {
        return line;
      }
      return masked;
    })
    .join("\n");
}

function globToPattern(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(PATTERN_METACHARACTERS, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

const patternCache = new Map<string, RegExp>();

function matchesNeverAsset(masked: string, globs: string[]): boolean {
  for (const glob of globs) {
    let pattern = patternCache.get(glob);
    if (pattern === undefined) {
      pattern = globToPattern(glob);
      patternCache.set(glob, pattern);
    }
    if (pattern.test(masked.trim())) return true;
  }
  return false;
}

function assignmentTarget(line: string): string | undefined {
  const target = ASSIGNMENT.exec(line)?.[1];
  return target === undefined ? undefined : target.split(".").at(-1);
}

export function renumberTokens(
  lines: readonly string[],
  overrides: RenumberOverrides,
  scans?: readonly SourceScan[],
): RenumberToken[] {
  const result: RenumberToken[] = [];
  const lineScans = scans?.length === lines.length ? scans : scanSourceLines(lines);
  for (const [index, line] of lines.entries()) {
    const target = assignmentTarget(line);
    const forced = target === undefined ? undefined : overrides.assetType?.[target];
    for (const number of lineScans[index]?.numbers ?? scanSourceLine(line).numbers) {
      result.push(forced === undefined ? number.value : [number.value, forced]);
    }
  }
  return result;
}

function tokenValue(token: RenumberToken): number {
  return typeof token === "number" ? token : token[0];
}

function tokenKind(token: RenumberToken): AssetKind | undefined {
  return typeof token === "number" ? undefined : token[1];
}

function sharedAssetName(
  tables: RenumberTables,
  before: number,
  after: number,
  forced: AssetKind | undefined,
): string | undefined {
  for (const kind of forced === undefined ? ASSET_KINDS : [forced]) {
    const left = tables.left[kind][before];
    const right = tables.right[kind][after];
    if (left === undefined || right === undefined) continue;
    if (left === "" || right === "") continue;
    if (left === right) return left;
  }
  return undefined;
}

export interface RenumberedAsset {
  position: number;
  name: string;
}

function renumberedAssetsFromScans(
  before: string,
  after: string,
  leftScan: SourceScan,
  rightScan: SourceScan,
  tables: RenumberTables,
): RenumberedAsset[] | undefined {
  if (before === after) return undefined;

  const masked = leftScan.masked;
  if (masked !== rightScan.masked) return undefined;

  const never = tables.overrides.neverAsset;
  if (never !== undefined && matchesNeverAsset(maskNumbers(before), never)) return undefined;

  const target = assignmentTarget(before);
  const forced = target === undefined ? undefined : tables.overrides.assetType?.[target];

  const leftNumbers = leftScan.numbers;
  const rightNumbers = rightScan.numbers;
  if (leftNumbers.length !== rightNumbers.length) return undefined;

  const found: RenumberedAsset[] = [];
  for (let index = 0; index < leftNumbers.length; index += 1) {
    const left = leftNumbers[index];
    const right = rightNumbers[index];
    if (left === undefined || right === undefined) return undefined;
    if (left.raw === right.raw) continue;
    if (left.value === right.value) return undefined;
    const name = sharedAssetName(tables, left.value, right.value, forced);
    if (name === undefined) return undefined;
    found.push({ position: left.position, name });
  }
  return found.length > 0 ? found : undefined;
}

export interface RenumberedLinePair {
  left?: string;
  right?: string;
}

export function renumberedAssetsByLine(
  lines: readonly RenumberedLinePair[],
  tables: RenumberTables,
): Array<RenumberedAsset[] | undefined> {
  const leftState: ScanState = { blockComment: false };
  const rightState: ScanState = { blockComment: false };
  return lines.map(({ left, right }) => {
    const leftScan = left === undefined ? undefined : scanSourceLine(left, leftState);
    const rightScan = right === undefined ? undefined : scanSourceLine(right, rightState);
    if (
      left === undefined ||
      right === undefined ||
      leftScan === undefined ||
      rightScan === undefined
    ) {
      return undefined;
    }
    return renumberedAssetsFromScans(left, right, leftScan, rightScan, tables);
  });
}

export function isRenumberedScript(
  left: readonly RenumberToken[],
  right: readonly RenumberToken[],
  tables: RenumberTables,
): boolean {
  if (left.length !== right.length) return false;
  let changed = false;
  for (let index = 0; index < left.length; index += 1) {
    const before = left[index];
    const after = right[index];
    if (before === undefined || after === undefined) return false;
    const beforeValue = tokenValue(before);
    const afterValue = tokenValue(after);
    if (beforeValue === afterValue) continue;
    const beforeKind = tokenKind(before);
    const afterKind = tokenKind(after);
    if (beforeKind !== afterKind) return false;
    if (sharedAssetName(tables, beforeValue, afterValue, beforeKind) === undefined) return false;
    changed = true;
  }
  return changed;
}
