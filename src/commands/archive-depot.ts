import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  planRawArchive,
  r2BucketIsPrivate,
  rawBlobKey,
  rawCatalogKey,
  type RawArchiveCatalog,
} from "../archive/raw-archive";
import {
  loadReleaseSource,
  loadReleaseSources,
  selectReleases,
  type ReleaseSource,
} from "../archive/releases";
import { projectRoot } from "../platform/paths";
import { runOutput } from "../platform/spawn";
import { R2ObjectStore, r2CredentialsFromEnvironment } from "../archive/object-store";

interface Options {
  bucket?: string;
  depotParent?: string;
  dryRun: boolean;
  jurisdiction?: string;
  prefix: string;
  release?: string;
  source?: string;
}

function localPath(value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
}

function safeBucket(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) {
    throw new Error(`Invalid R2 bucket name: ${value}`);
  }
  return value;
}

function safePrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/g, "");
  if (
    normalized === "" ||
    normalized.split("/").some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))
  ) {
    throw new Error(`Invalid R2 key prefix: ${value}`);
  }
  return normalized;
}

function parseOptions(arguments_: string[]): Options {
  const options: Options = { dryRun: false, prefix: "tenna-raw" };
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (option === undefined || value === undefined) throw new Error(`Missing value for ${option}`);
    index += 1;
    if (option === "--bucket") {
      options.bucket = safeBucket(value);
    } else if (option === "--source") {
      options.source = value;
    } else if (option === "--release") {
      options.release = value;
    } else if (option === "--root") {
      options.depotParent = localPath(value);
    } else if (option === "--prefix") {
      options.prefix = safePrefix(value);
    } else if (option === "--jurisdiction") {
      options.jurisdiction = value;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  if (options.bucket === undefined) throw new Error("Missing --bucket");
  if (options.release !== undefined && options.source === undefined) {
    throw new Error("--release requires --source");
  }
  return options;
}

function wranglerPath(): string {
  const detected = Bun.which("wrangler");
  if (detected !== null) return detected;
  throw new Error("Wrangler was not found; run bun install");
}

async function assertPrivateBucket(
  wrangler: string,
  options: Options & { bucket: string },
): Promise<void> {
  const jurisdiction =
    options.jurisdiction === undefined ? [] : ["--jurisdiction", options.jurisdiction];
  const devUrl = await runOutput(wrangler, [
    "r2",
    "bucket",
    "dev-url",
    "get",
    options.bucket,
    ...jurisdiction,
  ]);
  const domains = await runOutput(wrangler, [
    "r2",
    "bucket",
    "domain",
    "list",
    options.bucket,
    ...jurisdiction,
  ]);
  if (!r2BucketIsPrivate(devUrl, domains)) {
    throw new Error(
      `Refusing to archive raw inputs to R2 bucket ${JSON.stringify(options.bucket)} because it has public access enabled`,
    );
  }
  console.log(`Verified that R2 bucket ${options.bucket} has no public URL or custom domain`);
}

async function selectedSources(options: Options): Promise<ReleaseSource[]> {
  return options.source === undefined
    ? loadReleaseSources()
    : [await loadReleaseSource(options.source)];
}

async function writeCatalog(temporary: string, catalog: RawArchiveCatalog): Promise<string> {
  const file = join(temporary, `${catalog.source.id}-${catalog.release.id}.json`);
  await writeFile(file, `${JSON.stringify(catalog, undefined, 2)}\n`, "utf8");
  return file;
}

const options = parseOptions(Bun.argv.slice(2));
const bucket = options.bucket;
if (bucket === undefined) throw new Error("unreachable: bucket was validated");
const resolvedOptions = { ...options, bucket };
const wrangler = options.dryRun ? undefined : wranglerPath();
if (wrangler !== undefined) await assertPrivateBucket(wrangler, resolvedOptions);
const store = options.dryRun
  ? undefined
  : new R2ObjectStore(bucket, r2CredentialsFromEnvironment("TENNA_ARCHIVE"));
const uploaded = new Set<string>();
const temporary = await mkdtemp(join(tmpdir(), "tenna-raw-archive-"));
let sourceBytes = 0;
let releaseCount = 0;

try {
  for (const source of await selectedSources(options)) {
    for (const release of selectReleases(source, options.release)) {
      console.log(`Planning ${source.label} ${release.label}`);
      const plan = await planRawArchive(source, release, options.depotParent);
      for (const blob of plan.blobs) {
        sourceBytes += blob.bytes;
        if (uploaded.has(blob.hash)) continue;
        uploaded.add(blob.hash);
        const key = rawBlobKey(options.prefix, blob.hash);
        console.log(`${options.dryRun ? "Would upload" : "Uploading"} ${key}`);
        if (store !== undefined) await store.upload(key, blob.file, "application/octet-stream");
      }

      const catalogKey = rawCatalogKey(options.prefix, source.id, release.id);
      console.log(`${options.dryRun ? "Would upload" : "Uploading"} ${catalogKey}`);
      if (store !== undefined) {
        const catalogFile = await writeCatalog(temporary, plan.catalog);
        await store.upload(catalogKey, catalogFile, "application/json");
      }
      releaseCount += 1;
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log(
  `${options.dryRun ? "Planned" : "Archived"} ${releaseCount} releases, ${uploaded.size} unique blobs, ${(sourceBytes / 1024 ** 3).toFixed(2)} GiB of release inputs`,
);
