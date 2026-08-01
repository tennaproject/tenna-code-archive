import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ASSET_KINDS, type RenumberToken } from "../shared/renumbering";
import { writeGzipJson } from "./shards";

const BUILD_CACHE_MARKER = ".tenna-cache.json";

const CACHE_SCHEMA_VERSION = 2;
const BUILD_CACHE_MARKER_CONTENT = `${JSON.stringify(
  {
    kind: "tenna-gml-viewer-build-cache",
    schemaVersion: CACHE_SCHEMA_VERSION,
  },
  undefined,
  2,
)}\n`;

type CacheMarkerState = "missing" | "valid" | "invalid";

async function cacheMarkerState(directory: string): Promise<CacheMarkerState> {
  const marker = join(directory, BUILD_CACHE_MARKER);
  let info;
  try {
    info = await lstat(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (!info.isFile()) return "invalid";
  try {
    const value = JSON.parse(await readFile(marker, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
    const record = value as Record<string, unknown>;
    if (record.kind !== "tenna-gml-viewer-build-cache") return "invalid";
    if (record.schemaVersion === CACHE_SCHEMA_VERSION) return "valid";
    return "invalid";
  } catch {
    return "invalid";
  }
}

async function prepareCacheDirectory(directory: string): Promise<void> {
  const state = await cacheMarkerState(directory);
  if (state === "valid") return;
  if (state === "invalid") {
    throw new Error(
      `Refusing to use unmarked or invalid build cache: ${directory}. ` +
        "Remove it manually or provide an empty dedicated cache directory.",
    );
  }

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }
  if (entries.length !== 0) {
    throw new Error(
      `Refusing to initialize nonempty unmarked build cache: ${directory}. ` +
        "Remove it manually or provide an empty dedicated cache directory.",
    );
  }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, BUILD_CACHE_MARKER), BUILD_CACHE_MARKER_CONTENT, {
    encoding: "utf8",
    flag: "wx",
  }).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await cacheMarkerState(directory)) !== "valid") throw error;
  });
}

interface CachedScriptMeta {
  hash: string;
  masked: string;
  renumbering: RenumberToken[];
  lines: number;
  search: string[];
  payload: string;
}

export interface ChapterMeta {
  revision: string;
  assetIdentity: string;
  scripts: Record<string, CachedScriptMeta>;
}

export type ShardCollection = "payloads" | "sources";

export interface StoreUsage {
  chapters: Array<{ chapterId: string; revision: string; assetIdentity: string }>;
  catalog: Array<{ buildId: string; chapterId: string; fingerprint: string }>;
  shards: Record<ShardCollection, string[]>;
}

export function emptyUsage(): StoreUsage {
  return {
    chapters: [],
    catalog: [],
    shards: { payloads: [], sources: [] },
  };
}

export interface ArtifactStore {
  readChapter(
    chapterId: string,
    revision: string,
    assetIdentity: string,
  ): Promise<ChapterMeta | undefined>;
  writeChapter(
    chapterId: string,
    revision: string,
    assetIdentity: string,
    meta: ChapterMeta,
  ): Promise<void>;
  putPayload(hash: string, json: string): Promise<void>;
  openPayload(hash: string): Promise<string>;
  readCatalog(
    buildId: string,
    chapterId: string,
    fingerprint: string,
  ): Promise<unknown | undefined>;
  writeCatalog(
    buildId: string,
    chapterId: string,
    fingerprint: string,
    value: unknown,
  ): Promise<void>;
  shardCache(collection: ShardCollection): string | undefined;
  prune(usage: StoreUsage): Promise<void>;
  dispose(): Promise<void>;
}

async function readJsonGz<T>(path: string): Promise<T | undefined> {
  try {
    const compressed = await readFile(path);
    return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(compressed))) as T;
  } catch {
    return undefined;
  }
}

async function writeFileAtomic(path: string, value: string | Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.tenna-write-${randomUUID()}`);
  try {
    await writeFile(temporary, value);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRenumberToken(value: unknown): value is RenumberToken {
  return (
    typeof value === "number" ||
    (Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "string" &&
      ASSET_KINDS.includes(value[1] as (typeof ASSET_KINDS)[number]))
  );
}

function isCachedScriptMeta(value: unknown): value is CachedScriptMeta {
  if (!isRecord(value)) return false;
  return (
    typeof value.hash === "string" &&
    typeof value.masked === "string" &&
    Array.isArray(value.renumbering) &&
    value.renumbering.every(isRenumberToken) &&
    Number.isInteger(value.lines) &&
    (value.lines as number) >= 0 &&
    Array.isArray(value.search) &&
    value.search.every((line) => typeof line === "string") &&
    typeof value.payload === "string"
  );
}

function isChapterMeta(value: unknown): value is ChapterMeta {
  if (
    !isRecord(value) ||
    typeof value.revision !== "string" ||
    typeof value.assetIdentity !== "string" ||
    !isRecord(value.scripts)
  ) {
    return false;
  }
  return Object.values(value.scripts).every(isCachedScriptMeta);
}

function payloadHash(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

class NullStore implements ArtifactStore {
  private staging?: string;

  async readChapter(): Promise<ChapterMeta | undefined> {
    return undefined;
  }

  async writeChapter(): Promise<void> {}

  private async stagingDirectory(): Promise<string> {
    this.staging ??= await mkdtemp(join(tmpdir(), "tenna-gml-payloads-"));
    return this.staging;
  }

  async putPayload(hash: string, json: string): Promise<void> {
    await writeFile(join(await this.stagingDirectory(), hash), json, "utf8");
  }

  async openPayload(hash: string): Promise<string> {
    return readFile(join(await this.stagingDirectory(), hash), "utf8");
  }

  async readCatalog<T>(): Promise<T | undefined> {
    return undefined;
  }

  async writeCatalog(): Promise<void> {}

  shardCache(): string | undefined {
    return undefined;
  }

  async prune(): Promise<void> {}

  async dispose(): Promise<void> {
    if (this.staging === undefined) return;
    await rm(this.staging, { recursive: true, force: true });
    this.staging = undefined;
  }
}

class PersistentStore implements ArtifactStore {
  private readonly payloads = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly renderTag: string,
    private readonly catalogTag: string,
  ) {}

  async load(): Promise<void> {
    await prepareCacheDirectory(this.directory);
    await Promise.all([
      mkdir(join(this.directory, "chapters"), { recursive: true }),
      mkdir(join(this.directory, "catalog"), { recursive: true }),
      mkdir(join(this.directory, "payloads"), { recursive: true }),
    ]);
    for (const entry of await readdir(join(this.directory, "payloads"), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        this.payloads.add(entry.name.slice(0, -".json".length));
      }
    }
  }

  private chapterKey(chapterId: string, revision: string, assetIdentity: string): string {
    return `${chapterId}-${revision.slice(0, 16)}-${assetIdentity.slice(0, 16)}-${this.renderTag}`;
  }

  private chapterDirectory(chapterId: string, revision: string, assetIdentity: string): string {
    return join(this.directory, "chapters", this.chapterKey(chapterId, revision, assetIdentity));
  }

  async readChapter(
    chapterId: string,
    revision: string,
    assetIdentity: string,
  ): Promise<ChapterMeta | undefined> {
    const value = await readJsonGz<unknown>(
      join(this.chapterDirectory(chapterId, revision, assetIdentity), "meta.json.gz"),
    );
    if (
      !isChapterMeta(value) ||
      value.revision !== revision ||
      value.assetIdentity !== assetIdentity
    ) {
      return undefined;
    }
    const missing = Object.values(value.scripts).some(
      (script) => !this.payloads.has(script.payload),
    );
    return missing ? undefined : value;
  }

  async writeChapter(
    chapterId: string,
    revision: string,
    assetIdentity: string,
    meta: ChapterMeta,
  ): Promise<void> {
    const directory = this.chapterDirectory(chapterId, revision, assetIdentity);
    await mkdir(directory, { recursive: true });
    await writeGzipJson(join(directory, "meta.json.gz"), meta);
  }

  private payloadPath(hash: string): string {
    return join(this.directory, "payloads", `${hash}.json`);
  }

  async putPayload(hash: string, json: string): Promise<void> {
    if (payloadHash(json) !== hash) {
      throw new Error(`Payload contents do not match hash ${hash}`);
    }
    if (this.payloads.has(hash)) {
      try {
        const cached = await readFile(this.payloadPath(hash), "utf8");
        if (payloadHash(cached) === hash) return;
      } catch {
        // no cache entry
      }
    }
    await writeFileAtomic(this.payloadPath(hash), json);
    this.payloads.add(hash);
  }

  async openPayload(hash: string): Promise<string> {
    const json = await readFile(this.payloadPath(hash), "utf8");
    if (payloadHash(json) !== hash) {
      this.payloads.delete(hash);
      throw new Error(`Cached payload does not match hash ${hash}`);
    }
    return json;
  }

  private catalogName(key: string, fingerprint: string): string {
    return `${key}-${fingerprint.slice(0, 16)}-${this.catalogTag}.json.gz`;
  }

  private catalogPath(buildId: string, chapterId: string, fingerprint: string): string {
    return join(
      this.directory,
      "catalog",
      this.catalogName(`${buildId}-${chapterId}`, fingerprint),
    );
  }

  async readCatalog(
    buildId: string,
    chapterId: string,
    fingerprint: string,
  ): Promise<unknown | undefined> {
    return readJsonGz<unknown>(this.catalogPath(buildId, chapterId, fingerprint));
  }

  async writeCatalog(
    buildId: string,
    chapterId: string,
    fingerprint: string,
    value: unknown,
  ): Promise<void> {
    await writeGzipJson(this.catalogPath(buildId, chapterId, fingerprint), value);
  }

  shardCache(collection: ShardCollection): string {
    return join(this.directory, "shards", collection);
  }

  async prune(usage: StoreUsage): Promise<void> {
    await this.pruneChapters(usage);
    await this.prunePayloads();
    await this.pruneCatalog(usage);
    await this.pruneShards(usage);
  }

  private async pruneChapters(usage: StoreUsage): Promise<void> {
    const keep = new Set(
      usage.chapters.map((chapter) =>
        this.chapterKey(chapter.chapterId, chapter.revision, chapter.assetIdentity),
      ),
    );
    let entries;
    try {
      entries = await readdir(join(this.directory, "chapters"), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !keep.has(entry.name))
        .map((entry) =>
          rm(join(this.directory, "chapters", entry.name), {
            recursive: true,
            force: true,
          }),
        ),
    );
  }

  private async prunePayloads(): Promise<void> {
    const chapterRoot = join(this.directory, "chapters");
    const referenced = new Set<string>();
    let chapters;
    try {
      chapters = await readdir(chapterRoot, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      chapters
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const value = await readJsonGz<unknown>(join(chapterRoot, entry.name, "meta.json.gz"));
          if (!isChapterMeta(value)) return;
          for (const script of Object.values(value.scripts)) {
            referenced.add(script.payload);
          }
        }),
    );
    const payloadRoot = join(this.directory, "payloads");
    let payloads;
    try {
      payloads = await readdir(payloadRoot, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      payloads
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".json") &&
            !referenced.has(entry.name.slice(0, -".json".length)),
        )
        .map((entry) => rm(join(payloadRoot, entry.name), { force: true })),
    );
  }

  private async pruneCatalog(usage: StoreUsage): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(this.directory, "catalog"));
    } catch {
      return;
    }
    const processedKeys = new Set(
      usage.catalog.map((entry) => `${entry.buildId}-${entry.chapterId}`),
    );
    const keep = new Set(
      usage.catalog.map((entry) =>
        this.catalogName(`${entry.buildId}-${entry.chapterId}`, entry.fingerprint),
      ),
    );
    const stale = entries.filter((name) => {
      if (keep.has(name)) return false;
      const base = name.replace(/\.json\.gz$/, "");
      const match = /^(.*)-[a-f0-9]{16}(?:-[a-f0-9]{8})?$/.exec(base);
      return match?.[1] !== undefined && processedKeys.has(match[1]);
    });
    await Promise.all(
      stale.map((name) => rm(join(this.directory, "catalog", name), { force: true })),
    );
  }

  private async pruneShards(usage: StoreUsage): Promise<void> {
    await Promise.all(
      (["payloads", "sources"] as const).map(async (collection) => {
        const root = this.shardCache(collection);
        const keep = new Set(usage.shards[collection]);
        let buckets;
        try {
          buckets = await readdir(root, { withFileTypes: true });
        } catch {
          return;
        }
        await Promise.all(
          buckets.map(async (bucket) => {
            const path = join(root, bucket.name);
            if (!bucket.isDirectory()) {
              await rm(path, { force: true });
              return;
            }
            const files = await readdir(path, { withFileTypes: true });
            await Promise.all(
              files
                .filter((file) => !file.isFile() || !keep.has(join(bucket.name, file.name)))
                .map((file) =>
                  rm(join(path, file.name), {
                    recursive: file.isDirectory(),
                    force: true,
                  }),
                ),
            );
            if ((await readdir(path)).length === 0) {
              await rm(path, { recursive: true, force: true });
            }
          }),
        );
      }),
    );
  }

  async dispose(): Promise<void> {}
}

interface StoreOptions {
  enabled: boolean;
  directory: string;
  renderStamp: string;
  catalogStamp: string;
}

export async function openStore(options: StoreOptions): Promise<ArtifactStore> {
  if (!options.enabled) return new NullStore();
  const store = new PersistentStore(
    options.directory,
    options.renderStamp.slice(0, 8),
    options.catalogStamp.slice(0, 8),
  );
  await store.load();
  return store;
}
