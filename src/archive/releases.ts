import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertSafePathSegment, projectRoot } from "../platform/paths";

const DEFAULT_BRANCH = "public";

export interface Release {
  id: string;
  date: string;
  label: string;
  manifest?: string;
  branch: string;
  // Some Steam branches just reject manifest-specific downloads -_-
  branchHead: boolean;
  singleChapter?: string;
  path?: string;
}

export interface ReleaseSource {
  id: string;
  label: string;
  directory: string;
  appId?: string;
  depotId?: string;
  singleChapter?: string;
  releases: Release[];
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function labelForDate(date: string, note?: string): string {
  const [year, month, day] = date.split("-");
  const label = `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
  return note === undefined ? label : `${label} (${note})`;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function publishedAt(release: Release): string {
  return `${release.date}T00:00:00Z`;
}

export function provenanceManifestId(
  release: Pick<Release, "branchHead" | "manifest">,
): string | undefined {
  return release.branchHead ? undefined : release.manifest;
}

function fail(file: string, where: string, message: string): never {
  throw new Error(`${file}: ${where} ${message}`);
}

function parseRelease(file: string, where: string, value: unknown): Release {
  if (typeof value !== "object" || value === null) {
    fail(file, where, "must be an object");
  }
  const { id, date, manifest, branch, note, branchHead, singleChapter, path } = value as Record<
    string,
    unknown
  >;
  if (typeof date !== "string" || !isCalendarDate(date)) {
    fail(file, where, "needs a YYYY-MM-DD release date");
  }
  const at = `${where} (${date})`;
  if (id !== undefined && typeof id !== "string") {
    fail(file, at, "has an unsafe id");
  }
  if (typeof id === "string") {
    try {
      assertSafePathSegment(id, "release ID");
    } catch {
      fail(file, at, "has an unsafe id");
    }
  }
  if (manifest !== undefined && (typeof manifest !== "string" || !/^\d{1,20}$/.test(manifest))) {
    fail(file, at, "has a non-numeric manifest ID");
  }
  if (branch !== undefined && (typeof branch !== "string" || !/^[A-Za-z0-9._-]+$/.test(branch))) {
    fail(file, at, "has an unsafe branch name");
  }
  if (note !== undefined && typeof note !== "string") {
    fail(file, at, "has a non-string note");
  }
  if (branchHead !== undefined && typeof branchHead !== "boolean") {
    fail(file, at, "has a non-boolean branchHead");
  }
  if (singleChapter !== undefined && typeof singleChapter !== "string") {
    fail(file, at, "has an unsafe singleChapter");
  }
  if (typeof singleChapter === "string") {
    try {
      assertSafePathSegment(singleChapter, "chapter ID");
    } catch {
      fail(file, at, "has an unsafe singleChapter");
    }
  }
  if (path !== undefined && (typeof path !== "string" || path === "")) {
    fail(file, at, "has an invalid path");
  }
  return {
    id: id ?? date,
    date,
    label: labelForDate(date, note),
    manifest,
    branch: branch ?? DEFAULT_BRANCH,
    branchHead: branchHead ?? false,
    singleChapter,
    path,
  };
}

function parseSource(file: string, id: string, value: unknown): ReleaseSource {
  try {
    assertSafePathSegment(id, "source ID");
  } catch {
    fail(file, `source ${JSON.stringify(id)}`, "has an unsafe ID");
  }
  const where = `source ${id}`;
  if (typeof value !== "object" || value === null) {
    fail(file, where, "must be an object");
  }
  const { label, appId, depotId, directory, singleChapter, releases } = value as Record<
    string,
    unknown
  >;
  if (typeof label !== "string" || label === "") {
    fail(file, where, "needs a label");
  }
  if (appId !== undefined && (typeof appId !== "string" || !/^\d+$/.test(appId))) {
    fail(file, where, "has a non-numeric appId");
  }
  if (depotId !== undefined && (typeof depotId !== "string" || !/^\d+$/.test(depotId))) {
    fail(file, where, "has a non-numeric depotId");
  }
  if (typeof directory !== "string") {
    fail(file, where, "needs a safe directory name");
  }
  try {
    assertSafePathSegment(directory, "source directory");
  } catch {
    fail(file, where, "needs a safe directory name");
  }
  if (singleChapter !== undefined && typeof singleChapter !== "string") {
    fail(file, where, "has an unsafe singleChapter");
  }
  if (typeof singleChapter === "string") {
    try {
      assertSafePathSegment(singleChapter, "chapter ID");
    } catch {
      fail(file, where, "has an unsafe singleChapter");
    }
  }
  if (!Array.isArray(releases) || releases.length === 0) {
    fail(file, where, "needs at least one release");
  }
  const parsed = releases.map((release) => parseRelease(file, where, release));
  if (new Set(parsed.map((release) => release.id)).size !== parsed.length) {
    fail(file, where, "lists two releases with the same id, they can't be the same");
  }
  return {
    id,
    label,
    appId,
    depotId,
    directory,
    singleChapter,
    releases: parsed,
  };
}

export async function loadReleaseSources(root = projectRoot): Promise<ReleaseSource[]> {
  const file = resolve(root, "data", "releases.json");
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    fail(file, "file", "must contain an object");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) fail(file, "file", "defines no sources");
  const parsedSources = entries.map(([id, value]) => parseSource(file, id, value));
  if (new Set(parsedSources.map(({ directory }) => directory)).size !== parsedSources.length) {
    fail(file, "file", "reuses a source directory");
  }
  return parsedSources;
}

export async function loadReleaseSource(id: string, root = projectRoot): Promise<ReleaseSource> {
  const sources = await loadReleaseSources(root);
  const source = sources.find((candidate) => candidate.id === id);
  if (source === undefined) {
    throw new Error(
      `Unknown source ${JSON.stringify(id)}; known sources: ${sources
        .map((candidate) => candidate.id)
        .join(", ")}`,
    );
  }
  return source;
}

export function depotRoot(source: ReleaseSource, parent?: string): string {
  return resolve(parent ?? resolve(projectRoot, "local", "depots"), source.directory);
}

export function decompiledRoot(source: ReleaseSource, parent?: string): string {
  return resolve(parent ?? resolve(projectRoot, "local", "decompiled"), source.directory);
}

export function selectReleases(source: ReleaseSource, wanted?: string): Release[] {
  if (wanted === undefined) return source.releases;
  const release = source.releases.find(
    (candidate) => candidate.id === wanted || candidate.manifest === wanted,
  );
  if (release === undefined) {
    throw new Error(`Unknown ${source.id} release: ${wanted}`);
  }
  return [release];
}
