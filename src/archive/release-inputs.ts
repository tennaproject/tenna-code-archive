import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assertSafePathSegment, isDirectory, projectRoot } from "../platform/paths";
import { loadReleaseSources, provenanceManifestId, publishedAt } from "./releases";

export interface ResolvedRelease {
  id: string;
  label?: string;
  root: string;
  depotId?: string;
  manifestId?: string;
  publishedAt?: string;
}

function assertSafeId(id: string): void {
  assertSafePathSegment(id, "build ID");
}

export async function loadCatalogReleases(
  catalogFile: string | undefined,
  defaultInputRoot: string,
): Promise<ResolvedRelease[]> {
  if (catalogFile === undefined) {
    return [
      {
        id: "current",
        label: "Export",
        root: defaultInputRoot,
      },
    ];
  }

  const absoluteCatalog = resolve(catalogFile);
  const parsed = JSON.parse(await readFile(absoluteCatalog, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${absoluteCatalog} must contain an object`);
  }
  const builds = (parsed as Record<string, unknown>).builds;
  if (!Array.isArray(builds) || builds.length === 0) {
    throw new Error(`${absoluteCatalog} must define at least one build`);
  }

  const ids = new Set<string>();
  return builds.map((value, index) => {
    if (typeof value !== "object" || value === null) {
      throw new Error(`Build ${index + 1} in ${absoluteCatalog} must be an object`);
    }
    const { id, path, label, depotId, manifestId, publishedAt } = value as Record<string, unknown>;
    if (typeof id !== "string" || typeof path !== "string" || path === "") {
      throw new Error(`Every build in ${absoluteCatalog} needs string id and path fields`);
    }
    for (const [field, fieldValue] of Object.entries({
      label,
      depotId,
      manifestId,
      publishedAt,
    })) {
      if (fieldValue !== undefined && typeof fieldValue !== "string") {
        throw new Error(`Build ${id} in ${absoluteCatalog} has a non-string ${field}`);
      }
    }
    assertSafeId(id);
    if (ids.has(id)) throw new Error(`Duplicate build ID: ${id}`);
    ids.add(id);
    return {
      id,
      label: (label as string | undefined) ?? id,
      depotId: depotId as string | undefined,
      manifestId: manifestId as string | undefined,
      publishedAt: publishedAt as string | undefined,
      root: resolve(dirname(absoluteCatalog), path),
    };
  });
}

export async function loadConfiguredReleases(
  gmlRoot: string,
  projectDirectory = projectRoot,
): Promise<ResolvedRelease[]> {
  const sources = await loadReleaseSources(projectDirectory);
  const found: Array<ResolvedRelease & { date: string }> = [];
  const seen = new Map<string, string>();
  for (const source of sources) {
    for (const release of source.releases) {
      const previous = seen.get(release.id);
      if (previous !== undefined) {
        throw new Error(
          `Release ${release.id} is listed by both ${previous} and ${source.id}. They can't be the same`,
        );
      }
      seen.set(release.id, source.id);
      assertSafeId(release.id);
      const releaseRoot =
        release.path === undefined
          ? resolve(gmlRoot, source.directory, release.id)
          : resolve(projectDirectory, release.path);
      if (!(await isDirectory(releaseRoot))) continue;
      const manifestId = provenanceManifestId(release);
      found.push({
        id: release.id,
        label: `${source.label} ${release.label}`,
        root: releaseRoot,
        depotId: source.depotId,
        ...(manifestId === undefined ? {} : { manifestId }),
        publishedAt: publishedAt(release),
        date: release.date,
      });
    }
  }

  found.sort(
    (left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id),
  );
  return found.map(({ date: _date, ...build }) => build);
}
