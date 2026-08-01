import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type { R2ObjectStore } from "./object-store";
import { parseRawArchiveCatalog, rawBlobKey, rawCatalogKey } from "./raw-archive";
import type { Release, ReleaseSource } from "./releases";
import { extractionIdentity, sha256File, type Toolchain } from "./toolchain";
import { moveExtractedDirectory, publishExtractedDirectory } from "../commands/extract-depot";
import { run, runOutput } from "../platform/spawn";

interface GmlPreparationSelection {
  source: ReleaseSource;
  releases: Release[];
}

interface GmlPreparationOptions {
  archivePrefix: string;
  cachePrefix: string;
  outputRoot: string;
  utmtCli: string;
  exportScript: string;
  toolchain: Toolchain;
  dryRun?: boolean;
  log?: (message: string) => void;
}

interface GmlPreparationResult {
  chapters: number;
  hits: number;
  rebuilt: number;
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

async function buildChapter(
  archiveStore: R2ObjectStore,
  cacheStore: R2ObjectStore,
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

export async function prepareGml(
  archiveStore: R2ObjectStore,
  cacheStore: R2ObjectStore,
  selections: GmlPreparationSelection[],
  options: GmlPreparationOptions,
): Promise<GmlPreparationResult> {
  const result = { chapters: 0, hits: 0, rebuilt: 0 };
  const log = options.log ?? console.log;
  for (const { source, releases } of selections) {
    for (const release of releases) {
      const catalogKey = rawCatalogKey(options.archivePrefix, source.id, release.id);
      const catalog = parseRawArchiveCatalog(
        JSON.parse(await archiveStore.readText(catalogKey)),
        source,
        release,
      );
      const destination = resolve(options.outputRoot, source.directory, release.id);
      if (options.dryRun === true) {
        for (const [chapter, file] of Object.entries(catalog.files)) {
          const rawHash = file.blob.slice(7);
          const key = gmlCacheKey(options.cachePrefix, options.toolchain, rawHash);
          log(
            `${(await cacheStore.exists(key)) ? "Cache hit" : "Would rebuild"} ${source.id} ${release.id} ${chapter}`,
          );
          result.chapters += 1;
        }
        continue;
      }

      await mkdir(dirname(destination), { recursive: true });
      const staging = await mkdtemp(resolve(dirname(destination), `.${release.id}-gml-`));
      try {
        for (const [chapter, file] of Object.entries(catalog.files)) {
          result.chapters += 1;
          const rawHash = file.blob.slice(7);
          const identity = extractionIdentity(options.toolchain, rawHash);
          const key = gmlCacheKey(options.cachePrefix, options.toolchain, rawHash);
          const working = await mkdtemp(resolve(staging, `.${chapter}-`));
          let exported: string | undefined;
          try {
            if (await cacheStore.exists(key)) {
              const archive = resolve(working, "cached.tar.zst");
              try {
                await cacheStore.download(key, archive);
                const restored = resolve(working, "restored");
                await unpack(archive, restored);
                if (!(await validCacheDirectory(restored, identity))) throw new Error("bad marker");
                exported = restored;
                result.hits += 1;
                log(`Cache hit ${source.id} ${release.id} ${chapter}`);
              } catch {
                log(`Rebuilding corrupt cache ${source.id} ${release.id} ${chapter}`);
              }
            }
            if (exported === undefined) {
              exported = await buildChapter(
                archiveStore,
                cacheStore,
                rawBlobKey(options.archivePrefix, rawHash),
                rawHash,
                file.bytes,
                file.filename,
                key,
                identity,
                working,
                options,
              );
              result.rebuilt += 1;
              log(`Rebuilt ${source.id} ${release.id} ${chapter}`);
            }
            await moveExtractedDirectory(exported, resolve(staging, chapter));
          } finally {
            await rm(working, { recursive: true, force: true });
          }
        }
        await writeFile(
          resolve(staging, ".complete.json"),
          `${JSON.stringify(
            {
              schemaVersion: 1,
              source: source.id,
              release: release.id,
              toolchain: options.toolchain,
              inputs: Object.fromEntries(
                Object.entries(catalog.files).map(([chapter, file]) => [chapter, file.blob]),
              ),
            },
            undefined,
            2,
          )}\n`,
        );
        await publishExtractedDirectory(staging, destination);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
  }
  return result;
}
