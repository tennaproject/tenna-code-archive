import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { inputsForDepot } from "./depot-inputs";
import { depotRoot, provenanceManifestId, type Release, type ReleaseSource } from "./releases";
import { assertSafePathSegment } from "../platform/paths";

export interface RawArchiveFile {
  blob: string;
  bytes: number;
  filename: string;
}

export interface RawArchiveCatalog {
  schemaVersion: 1;
  source: {
    id: string;
    label: string;
    directory: string;
    appId?: string;
    depotId?: string;
  };
  release: {
    id: string;
    date: string;
    label: string;
    manifest?: string;
    branch: string;
    branchHead: boolean;
  };
  files: Record<string, RawArchiveFile>;
}

interface RawArchiveBlob {
  hash: string;
  file: string;
  bytes: number;
}

interface RawArchivePlan {
  catalog: RawArchiveCatalog;
  blobs: RawArchiveBlob[];
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function rawBlobKey(prefix: string, hash: string): string {
  return `${prefix}/blobs/sha256/${hash}`;
}

export function rawCatalogKey(prefix: string, source: string, release: string): string {
  return `${prefix}/catalogs/${source}/${release}.json`;
}

export function r2BucketIsPrivate(devUrlStatus: string, domainStatus: string): boolean {
  return (
    devUrlStatus.includes("r2.dev URL is disabled") && domainStatus.includes("no custom domains")
  );
}

function archiveError(where: string, message: string): never {
  throw new Error(`Invalid raw archive catalog ${where}: ${message}`);
}

export function parseRawArchiveCatalog(
  value: unknown,
  expectedSource?: ReleaseSource,
  expectedRelease?: Release,
): RawArchiveCatalog {
  if (typeof value !== "object" || value === null) archiveError("root", "must be an object");
  const { schemaVersion, source, release, files } = value as Record<string, unknown>;
  if (schemaVersion !== 1) {
    archiveError("root", `unsupported schema version ${String(schemaVersion)}`);
  }
  if (typeof source !== "object" || source === null) archiveError("source", "must be an object");
  if (typeof release !== "object" || release === null) archiveError("release", "must be an object");
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    archiveError("files", "must be an object");
  }
  const parsedSource = source as Record<string, unknown>;
  const parsedRelease = release as Record<string, unknown>;
  for (const field of ["id", "label", "directory"] as const) {
    if (typeof parsedSource[field] !== "string" || parsedSource[field] === "") {
      archiveError("source", `${field} must be a nonempty string`);
    }
  }
  for (const field of ["id", "date", "label", "branch"] as const) {
    if (typeof parsedRelease[field] !== "string" || parsedRelease[field] === "") {
      archiveError("release", `${field} must be a nonempty string`);
    }
  }
  for (const field of ["appId", "depotId"] as const) {
    const identifier = parsedSource[field];
    if (identifier !== undefined && (typeof identifier !== "string" || !/^\d+$/.test(identifier))) {
      archiveError("source", `${field} must be a numeric string`);
    }
  }
  if (
    parsedRelease.manifest !== undefined &&
    (typeof parsedRelease.manifest !== "string" || !/^\d{1,20}$/.test(parsedRelease.manifest))
  ) {
    archiveError("release", "manifest must be a numeric string");
  }
  if (typeof parsedRelease.branchHead !== "boolean") {
    archiveError("release", "branchHead must be a boolean");
  }
  for (const [where, identifier] of [
    ["source.id", parsedSource.id],
    ["source.directory", parsedSource.directory],
    ["release.id", parsedRelease.id],
  ] as const) {
    try {
      assertSafePathSegment(identifier as string, where);
    } catch {
      archiveError(where, "is unsafe");
    }
  }
  if (expectedSource !== undefined) {
    if (
      parsedSource.id !== expectedSource.id ||
      parsedSource.label !== expectedSource.label ||
      parsedSource.directory !== expectedSource.directory ||
      parsedSource.appId !== expectedSource.appId ||
      parsedSource.depotId !== expectedSource.depotId
    ) {
      archiveError("source", `does not match configured source ${expectedSource.id}`);
    }
  }
  if (
    expectedRelease !== undefined &&
    (parsedRelease.id !== expectedRelease.id ||
      parsedRelease.date !== expectedRelease.date ||
      parsedRelease.label !== expectedRelease.label ||
      parsedRelease.branch !== expectedRelease.branch ||
      parsedRelease.branchHead !== expectedRelease.branchHead ||
      parsedRelease.manifest !== provenanceManifestId(expectedRelease))
  ) {
    archiveError("release", `does not match configured release ${expectedRelease.id}`);
  }

  const parsedFiles: Record<string, RawArchiveFile> = {};
  for (const [chapter, file] of Object.entries(files)) {
    try {
      assertSafePathSegment(chapter, "chapter ID");
    } catch {
      archiveError(`files.${chapter}`, "has an unsafe chapter ID");
    }
    if (typeof file !== "object" || file === null) {
      archiveError(`files.${chapter}`, "must be an object");
    }
    const { blob, bytes, filename } = file as Record<string, unknown>;
    if (typeof blob !== "string" || !/^sha256:[a-f0-9]{64}$/.test(blob)) {
      archiveError(`files.${chapter}`, "has an invalid blob hash");
    }
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1) {
      archiveError(`files.${chapter}`, "has an invalid byte size");
    }
    if (filename !== "data.win" && filename !== "game.ios" && filename !== "game.win") {
      archiveError(`files.${chapter}`, "has an unsupported filename");
    }
    parsedFiles[chapter] = { blob, bytes, filename };
  }
  if (Object.keys(parsedFiles).length === 0) archiveError("files", "defines no chapters");
  const singleChapter = expectedRelease?.singleChapter ?? expectedSource?.singleChapter;
  if (
    singleChapter !== undefined &&
    (Object.keys(parsedFiles).length !== 1 || parsedFiles[singleChapter] === undefined)
  ) {
    archiveError("files", `must contain exactly configured chapter ${singleChapter}`);
  }
  if (singleChapter === undefined && expectedSource !== undefined) {
    if (parsedFiles.init === undefined)
      archiveError("files", "is missing chapter-select input init");
    const chapterNumbers = Object.keys(parsedFiles)
      .flatMap((chapter) => (/^ch([1-9]\d*)$/.exec(chapter)?.[1] ? [Number(chapter.slice(2))] : []))
      .sort((left, right) => left - right);
    for (let index = 0; index < chapterNumbers.length; index += 1) {
      if (chapterNumbers[index] !== index + 1) archiveError("files", "has a missing chapter");
    }
  }
  return {
    schemaVersion: 1,
    source: parsedSource as RawArchiveCatalog["source"],
    release: parsedRelease as RawArchiveCatalog["release"],
    files: parsedFiles,
  };
}

export async function planRawArchive(
  source: ReleaseSource,
  release: Release,
  depotParent?: string,
): Promise<RawArchivePlan> {
  const depot = resolve(depotRoot(source, depotParent), release.id);
  const marker = resolve(depot, ".complete.json");
  if (!(await Bun.file(marker).exists())) {
    throw new Error(`${source.id} ${release.id} has not finished downloading`);
  }

  const inputs = await inputsForDepot(depot, release.singleChapter ?? source.singleChapter);
  const files: Record<string, RawArchiveFile> = {};
  const blobs: RawArchiveBlob[] = [];
  for (const { chapter, dataFile } of inputs) {
    const [{ size }, hash] = await Promise.all([stat(dataFile), sha256(dataFile)]);
    files[chapter] = {
      blob: `sha256:${hash}`,
      bytes: size,
      filename: basename(dataFile),
    };
    blobs.push({ hash, file: dataFile, bytes: size });
  }
  const manifest = provenanceManifestId(release);

  return {
    catalog: {
      schemaVersion: 1,
      source: {
        id: source.id,
        label: source.label,
        directory: source.directory,
        appId: source.appId,
        depotId: source.depotId,
      },
      release: {
        id: release.id,
        date: release.date,
        label: release.label,
        ...(manifest === undefined ? {} : { manifest }),
        branch: release.branch,
        branchHead: release.branchHead,
      },
      files,
    },
    blobs,
  };
}
