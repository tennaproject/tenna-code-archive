import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { R2ObjectStore } from "./object-store";
import {
  parseRawArchiveCatalog,
  rawBlobKey,
  rawCatalogKey,
  type RawArchiveCatalog,
  type RawArchiveFile,
} from "./raw-archive";
import type { Release, ReleaseSource } from "./releases";
import { sha256File } from "./toolchain";
import { publishExtractedDirectory } from "../commands/extract-depot";

interface RestoreSelection {
  source: ReleaseSource;
  releases: Release[];
}

interface RestoreOptions {
  prefix: string;
  root: string;
  dryRun?: boolean;
  log?: (message: string) => void;
}

interface RestoreResult {
  catalogs: number;
  blobs: number;
  downloaded: number;
}

function dataPath(chapter: string, file: RawArchiveFile): string {
  if (chapter === "init" || chapter === "demo" || !/^ch[1-9]\d*$/.test(chapter)) {
    return file.filename;
  }
  const number = chapter.slice(2);
  return file.filename === "data.win"
    ? `chapter${number}_windows/data.win`
    : `chapter${number}_mac/game.ios`;
}

async function verified(file: string, expected: RawArchiveFile): Promise<boolean> {
  try {
    const metadata = await stat(file);
    return metadata.size === expected.bytes && (await sha256File(file)) === expected.blob.slice(7);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function markerFor(catalog: RawArchiveCatalog): object {
  return {
    schemaVersion: 1,
    source: catalog.source.id,
    release: catalog.release.id,
    manifest: catalog.release.manifest,
    files: Object.fromEntries(
      Object.entries(catalog.files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([chapter, file]) => [chapter, { path: dataPath(chapter, file), ...file }]),
    ),
  };
}

async function markerMatches(file: string, marker: object): Promise<boolean> {
  try {
    return JSON.stringify(JSON.parse(await readFile(file, "utf8"))) === JSON.stringify(marker);
  } catch {
    return false;
  }
}

export async function restoreDepots(
  store: R2ObjectStore,
  selections: RestoreSelection[],
  options: RestoreOptions,
): Promise<RestoreResult> {
  const log = options.log ?? console.log;
  const result = { catalogs: 0, blobs: 0, downloaded: 0 };
  for (const { source, releases } of selections) {
    for (const release of releases) {
      const key = rawCatalogKey(options.prefix, source.id, release.id);
      const catalog = parseRawArchiveCatalog(
        JSON.parse(await store.readText(key)),
        source,
        release,
      );
      result.catalogs += 1;
      result.blobs += Object.keys(catalog.files).length;
      const destination = resolve(options.root, source.directory, release.id);
      const marker = markerFor(catalog);
      if (await markerMatches(resolve(destination, ".complete.json"), marker)) {
        let complete = true;
        for (const [chapter, file] of Object.entries(catalog.files)) {
          if (!(await verified(resolve(destination, dataPath(chapter, file)), file)))
            complete = false;
        }
        if (complete) {
          log(`Verified ${source.id} ${release.id}`);
          continue;
        }
      }
      if (options.dryRun === true) {
        log(`Would restore ${source.id} ${release.id}`);
        continue;
      }

      await mkdir(dirname(destination), { recursive: true });
      const staging = await mkdtemp(resolve(dirname(destination), `.${release.id}-restore-`));
      try {
        for (const [chapter, file] of Object.entries(catalog.files)) {
          const output = resolve(staging, dataPath(chapter, file));
          await mkdir(dirname(output), { recursive: true });
          const existing = resolve(destination, dataPath(chapter, file));
          if (await verified(existing, file)) {
            await copyFile(existing, output);
          } else {
            const hash = file.blob.slice(7);
            await store.download(rawBlobKey(options.prefix, hash), output);
            result.downloaded += 1;
          }
          if (!(await verified(output, file))) {
            throw new Error(`Checksum or size mismatch for ${source.id} ${release.id} ${chapter}`);
          }
        }
        await writeFile(
          resolve(staging, ".complete.json"),
          `${JSON.stringify(marker, undefined, 2)}\n`,
        );
        await publishExtractedDirectory(staging, destination);
        log(`Restored ${source.id} ${release.id}`);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
  }
  return result;
}
