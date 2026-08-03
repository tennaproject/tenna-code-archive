import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type { ObjectStore } from "./object-store";
import {
  parseRawArchiveCatalog,
  rawBlobKey,
  rawCatalogKey,
  type RawArchiveCatalog,
  type RawArchiveFile,
} from "./raw-archive";
import type { Release, ReleaseSource } from "./releases";
import { extractionIdentity, sha256File, type Toolchain } from "./toolchain";
import { publishExtractedDirectory } from "../commands/extract-depot";
import { run, runOutput } from "../platform/spawn";

export interface GmlPreparationSelection {
  source: ReleaseSource;
  releases: Release[];
}

export interface GmlPreparationOptions {
  archivePrefix: string;
  cachePrefix: string;
  outputRoot: string;
  utmtCli: string;
  exportScript: string;
  toolchain: Toolchain;
  jobs?: number;
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface GmlPreparationResult {
  references: number;
  uniquePackages: number;
  cacheHits: number;
  rebuilt: number;
  corrupt: number;
  localReuses: number;
}

function gmlCacheKey(prefix: string, toolchain: Toolchain, rawHash: string): string {
  return `${prefix}/${extractionIdentity(toolchain, rawHash)}.tar.zst`;
}

async function unpack(archive: string, destination: string): Promise<void> {
  const listing = await runOutput("tar", ["--zstd", "-tf", archive]);
  for (const listed of listing.split("\n")) {
    const path = listed.replace(/^\.\//, "").replace(/\/$/, "");
    if (path === "") continue;
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment === "" || segment === "..")
    ) {
      throw new Error(`Unsafe cache package path: ${JSON.stringify(listed)}`);
    }
  }
  await mkdir(destination, { recursive: true });
  await run("tar", ["--zstd", "-xf", archive, "-C", destination]);
}

async function packageDirectory(source: string, archive: string): Promise<void> {
  await run("tar", ["--zstd", "-cf", archive, "-C", source, "."]);
}

interface CacheFileManifest {
  bytes: number;
  sha256: string;
}

async function cacheFiles(directory: string): Promise<Record<string, CacheFileManifest>> {
  const files: Record<string, CacheFileManifest> = {};
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name !== ".tenna-cache.json") {
        const key = relative(directory, path).split(sep).join("/");
        files[key] = { bytes: (await stat(path)).size, sha256: await sha256File(path) };
      } else if (!entry.isFile()) {
        throw new Error(`Unsupported cache package entry: ${path}`);
      }
    }
  }
  await visit(directory);
  return Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function validCacheDirectory(directory: string, identity: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(resolve(directory, ".tenna-cache.json"), "utf8")) as {
      identity?: unknown;
      files?: unknown;
    };
    if (
      marker.identity !== identity ||
      typeof marker.files !== "object" ||
      marker.files === null ||
      Array.isArray(marker.files)
    ) {
      return false;
    }
    const expected = marker.files as Record<string, unknown>;
    const actual = await cacheFiles(directory);
    if (Object.keys(expected).length !== Object.keys(actual).length) return false;
    for (const [path, value] of Object.entries(expected)) {
      if (
        !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+/.test(path) ||
        typeof value !== "object" ||
        value === null
      ) {
        return false;
      }
      const file = value as Record<string, unknown>;
      if (
        file.bytes !== actual[path]?.bytes ||
        typeof file.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        file.sha256 !== actual[path]?.sha256
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

const LINK_FALLBACK_ERRORS = new Set(["EACCES", "EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP"]);

interface MaterializeOperations {
  link: typeof link;
  copyFile: typeof copyFile;
  stat: typeof stat;
  utimes: typeof utimes;
}

const MATERIALIZE_OPERATIONS: MaterializeOperations = { link, copyFile, stat, utimes };

export async function materializeCacheDirectory(
  source: string,
  destination: string,
  operations: MaterializeOperations = MATERIALIZE_OPERATIONS,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      await materializeCacheDirectory(sourcePath, destinationPath, operations);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported cache package entry: ${sourcePath}`);
    try {
      await operations.link(sourcePath, destinationPath);
    } catch (error) {
      if (!LINK_FALLBACK_ERRORS.has(errorCode(error) ?? "")) throw error;
      const sourceInfo = await operations.stat(sourcePath);
      await operations.copyFile(sourcePath, destinationPath);
      await operations.utimes(destinationPath, sourceInfo.atime, sourceInfo.mtime);
    }
  }
}

async function buildChapter(
  archiveStore: ObjectStore,
  cacheStore: ObjectStore,
  rawKey: string,
  rawHash: string,
  expectedBytes: number,
  filename: string,
  cacheKey: string,
  identity: string,
  working: string,
  options: GmlPreparationOptions,
): Promise<string> {
  const raw = resolve(working, "raw", filename);
  await archiveStore.download(rawKey, raw);
  if (Bun.file(raw).size !== expectedBytes || (await sha256File(raw)) !== rawHash) {
    throw new Error(`Checksum or size mismatch for ${rawKey}`);
  }
  await run(options.utmtCli, ["load", raw, "--scripts", options.exportScript]);
  const generated = resolve(dirname(raw), "Export_Code");
  if (!(await stat(generated).catch(() => undefined))?.isDirectory()) {
    throw new Error(`UTMT did not create ${generated}`);
  }
  await writeFile(
    resolve(generated, ".tenna-cache.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        identity,
        raw: `sha256:${rawHash}`,
        files: await cacheFiles(generated),
      },
      undefined,
      2,
    )}\n`,
  );
  const cacheArchive = resolve(working, "rebuilt.tar.zst");
  await packageDirectory(generated, cacheArchive);
  const verification = resolve(working, "package-verification");
  await unpack(cacheArchive, verification);
  if (!(await validCacheDirectory(verification, identity))) {
    throw new Error(`Generated cache package failed validation for ${identity}`);
  }
  await cacheStore.upload(cacheKey, cacheArchive, "application/zstd");
  return verification;
}

interface ReleasePlan {
  source: ReleaseSource;
  release: Release;
  catalog: RawArchiveCatalog;
  destination: string;
  staging?: string;
}

interface PackageConsumer {
  release: ReleasePlan;
  chapter: string;
}

interface PackagePlan {
  identity: string;
  key: string;
  rawHash: string;
  file: RawArchiveFile;
  consumers: PackageConsumer[];
  message?: string;
}

async function preparationPlans(
  archiveStore: ObjectStore,
  selections: GmlPreparationSelection[],
  options: GmlPreparationOptions,
): Promise<{ releases: ReleasePlan[]; packages: PackagePlan[] }> {
  const releases: ReleasePlan[] = [];
  const packages = new Map<string, PackagePlan>();
  for (const { source, releases: selectedReleases } of selections) {
    for (const release of selectedReleases) {
      const catalogKey = rawCatalogKey(options.archivePrefix, source.id, release.id);
      const catalog = parseRawArchiveCatalog(
        JSON.parse(await archiveStore.readText(catalogKey)),
        source,
        release,
      );
      const releasePlan: ReleasePlan = {
        source,
        release,
        catalog,
        destination: resolve(options.outputRoot, source.directory, release.id),
      };
      releases.push(releasePlan);
      for (const [chapter, file] of Object.entries(catalog.files)) {
        const rawHash = file.blob.slice(7);
        const identity = extractionIdentity(options.toolchain, rawHash);
        const existing = packages.get(identity);
        if (existing !== undefined) {
          if (existing.file.bytes !== file.bytes || existing.file.filename !== file.filename) {
            throw new Error(
              `Conflicting metadata for raw blob sha256:${rawHash}: ` +
                `${existing.file.filename} (${existing.file.bytes} bytes) and ` +
                `${file.filename} (${file.bytes} bytes)`,
            );
          }
          existing.consumers.push({ release: releasePlan, chapter });
          continue;
        }
        packages.set(identity, {
          identity,
          key: gmlCacheKey(options.cachePrefix, options.toolchain, rawHash),
          rawHash,
          file,
          consumers: [{ release: releasePlan, chapter }],
        });
      }
    }
  }
  return { releases, packages: [...packages.values()] };
}

async function workerPool<T>(
  values: T[],
  jobs: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, values.length) }, async () => {
      while (next < values.length) {
        const value = values[next++];
        if (value !== undefined) await worker(value);
      }
    }),
  );
}

function packageLabel(packagePlan: PackagePlan): string {
  const first = packagePlan.consumers[0];
  if (first === undefined) return packagePlan.rawHash;
  const suffix =
    packagePlan.consumers.length === 1 ? "" : ` (${packagePlan.consumers.length} references)`;
  return `${first.release.source.id} ${first.release.release.id} ${first.chapter}${suffix}`;
}

function logSummary(
  result: GmlPreparationResult,
  log: (message: string) => void,
  dryRun: boolean,
  wouldRebuild = 0,
): void {
  log(
    `${dryRun ? "GML dry run" : "GML prepared"}: ${result.references} references, ` +
      `${result.uniquePackages} unique packages`,
  );
  log(
    dryRun
      ? `R2: ${result.cacheHits} hits, ${wouldRebuild} would rebuild`
      : `R2: ${result.cacheHits} hits, ${result.rebuilt} rebuilt, ${result.corrupt} corrupt`,
  );
  log(`Local reuse: ${result.localReuses} references`);
}

export async function prepareGml(
  archiveStore: ObjectStore,
  cacheStore: ObjectStore,
  selections: GmlPreparationSelection[],
  options: GmlPreparationOptions,
): Promise<GmlPreparationResult> {
  const jobs = options.jobs ?? 2;
  if (!Number.isSafeInteger(jobs) || jobs < 1)
    throw new Error("GML preparation jobs must be positive");
  const log = options.log ?? console.log;
  const plans = await preparationPlans(archiveStore, selections, options);
  const result: GmlPreparationResult = {
    references: plans.packages.reduce(
      (total, packagePlan) => total + packagePlan.consumers.length,
      0,
    ),
    uniquePackages: plans.packages.length,
    cacheHits: 0,
    rebuilt: 0,
    corrupt: 0,
    localReuses: plans.packages.reduce(
      (total, packagePlan) => total + packagePlan.consumers.length - 1,
      0,
    ),
  };

  if (options.dryRun === true) {
    let wouldRebuild = 0;
    await workerPool(plans.packages, jobs, async (packagePlan) => {
      if (await cacheStore.exists(packagePlan.key)) {
        result.cacheHits += 1;
        packagePlan.message = `R2 cache hit ${packageLabel(packagePlan)}`;
      } else {
        wouldRebuild += 1;
        packagePlan.message = `Would rebuild ${packageLabel(packagePlan)}`;
      }
    });
    for (const packagePlan of plans.packages) log(packagePlan.message ?? packageLabel(packagePlan));
    logSummary(result, log, true, wouldRebuild);
    return result;
  }

  await mkdir(dirname(options.outputRoot), { recursive: true });
  const workRoot = await mkdtemp(resolve(dirname(options.outputRoot), ".gml-prepare-"));
  try {
    for (const release of plans.releases) {
      await mkdir(dirname(release.destination), { recursive: true });
      release.staging = await mkdtemp(
        resolve(dirname(release.destination), `.${release.release.id}-gml-`),
      );
    }

    await workerPool(plans.packages, jobs, async (packagePlan) => {
      const working = await mkdtemp(resolve(workRoot, ".package-"));
      try {
        let exported: string | undefined;
        let cacheHit = false;
        let wasCorrupt = false;
        if (await cacheStore.exists(packagePlan.key)) {
          const archive = resolve(working, "cached.tar.zst");
          await cacheStore.download(packagePlan.key, archive);
          try {
            const restored = resolve(working, "restored");
            await unpack(archive, restored);
            if (!(await validCacheDirectory(restored, packagePlan.identity))) {
              throw new Error("bad marker");
            }
            exported = restored;
            cacheHit = true;
            result.cacheHits += 1;
          } catch {
            wasCorrupt = true;
            result.corrupt += 1;
          }
        }
        if (exported === undefined) {
          exported = await buildChapter(
            archiveStore,
            cacheStore,
            rawBlobKey(options.archivePrefix, packagePlan.rawHash),
            packagePlan.rawHash,
            packagePlan.file.bytes,
            packagePlan.file.filename,
            packagePlan.key,
            packagePlan.identity,
            working,
            options,
          );
          result.rebuilt += 1;
        }
        for (const consumer of packagePlan.consumers) {
          if (consumer.release.staging === undefined) throw new Error("Missing release staging");
          await materializeCacheDirectory(
            exported,
            resolve(consumer.release.staging, consumer.chapter),
          );
        }
        packagePlan.message = cacheHit
          ? `R2 cache hit ${packageLabel(packagePlan)}`
          : `${wasCorrupt ? "Rebuilt corrupt cache" : "Rebuilt"} ${packageLabel(packagePlan)}`;
      } finally {
        await rm(working, { recursive: true, force: true });
      }
    });

    for (const packagePlan of plans.packages) log(packagePlan.message ?? packageLabel(packagePlan));
    for (const release of plans.releases) {
      if (release.staging === undefined) throw new Error("Missing release staging");
      await writeFile(
        resolve(release.staging, ".complete.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            source: release.source.id,
            release: release.release.id,
            toolchain: options.toolchain,
            inputs: Object.fromEntries(
              Object.entries(release.catalog.files).map(([chapter, file]) => [chapter, file.blob]),
            ),
          },
          undefined,
          2,
        )}\n`,
      );
      await publishExtractedDirectory(release.staging, release.destination);
      release.staging = undefined;
    }
    logSummary(result, log, false);
    return result;
  } finally {
    await Promise.all(
      plans.releases.map(async (release) => {
        if (release.staging !== undefined) {
          await rm(release.staging, { recursive: true, force: true });
        }
      }),
    );
    await rm(workRoot, { recursive: true, force: true });
  }
}
