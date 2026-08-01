import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Effectively max are 3 char wide shards.
// So total 4096 each for payloads and sources already spends 8192 of the
// deploy's 20000 file cap, and 4 would need 131072
const DEFAULT_SHARD_PREFIX_LENGTH = 2;

export function resolveShardPrefixLength(value?: number): number {
  if (value === undefined) return DEFAULT_SHARD_PREFIX_LENGTH;
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error(`shardPrefixLength must be an integer between 1 and 3, got ${value}`);
  }
  return value;
}

interface SerializedShardEntry {
  hash: string;
  value(): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function valueMatchesHash(collection: string, hash: string, value: unknown): boolean {
  if (collection === "payloads") return hashText(JSON.stringify(value)) === hash;
  if (collection === "sources") return typeof value === "string" && hashText(value) === hash;
  return true;
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

function shardSetKey(collection: string, entries: SerializedShardEntry[]): string {
  const hash = createHash("sha256");
  hash.update("1");
  hash.update("\0");
  hash.update(collection);
  for (const entry of entries) {
    hash.update("\0");
    hash.update(entry.hash);
  }
  return hash.digest("hex");
}

async function serializeBucket(
  path: string,
  collection: string,
  bucket: SerializedShardEntry[],
): Promise<void> {
  const values = await Promise.all(
    bucket.map(async (entry) => {
      const serialized = await entry.value();
      let value: unknown;
      try {
        value = JSON.parse(serialized) as unknown;
      } catch (error) {
        throw new Error(`Invalid serialized ${collection} entry ${entry.hash}`, { cause: error });
      }
      if (!valueMatchesHash(collection, entry.hash, value)) {
        throw new Error(`Serialized ${collection} entry does not match hash ${entry.hash}`);
      }
      return `${JSON.stringify(entry.hash)}:${serialized}`;
    }),
  );
  const json = `{"schemaVersion":1,${JSON.stringify(collection)}:{${values.join(",")}}}`;
  const compressed = Bun.gzipSync(Buffer.from(json, "utf8"));
  await writeFileAtomic(path, compressed);
}

async function validSerializedShard(
  path: string,
  collection: string,
  bucket: SerializedShardEntry[],
): Promise<boolean> {
  let compressed: Buffer;
  try {
    compressed = await readFile(path);
  } catch {
    return false;
  }

  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(compressed))),
    ) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) return false;
    const values = parsed[collection];
    if (!isRecord(values)) return false;
    const expected = bucket.map((entry) => entry.hash).sort();
    const actual = Object.keys(values).sort();
    if (actual.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      const hash = expected[index];
      if (
        hash === undefined ||
        actual[index] !== hash ||
        !valueMatchesHash(collection, hash, values[hash])
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function shardName(hash: string, prefixLength: number): string {
  return hash.slice(0, prefixLength);
}

export async function writeGzipJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const json = JSON.stringify(value);
  await writeFileAtomic(path, Bun.gzipSync(Buffer.from(json, "utf8")));
}

export async function writeSerializedShards(
  directory: string,
  collection: string,
  entries: Iterable<SerializedShardEntry>,
  cacheDirectory?: string,
  prefixLength: number = DEFAULT_SHARD_PREFIX_LENGTH,
): Promise<string[]> {
  const sortedEntries = [...entries].sort((left, right) => left.hash.localeCompare(right.hash));
  const buckets = new Map<string, SerializedShardEntry[]>();
  for (const entry of sortedEntries) {
    const name = shardName(entry.hash, prefixLength);
    const bucket = buckets.get(name) ?? [];
    bucket.push(entry);
    buckets.set(name, bucket);
  }

  const temporary = `${directory}.next`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  if (cacheDirectory !== undefined) await mkdir(cacheDirectory, { recursive: true });

  const usedCacheFiles = await Promise.all(
    [...buckets].map(async ([name, bucket]) => {
      if (cacheDirectory === undefined) {
        await serializeBucket(join(temporary, `${name}.json.gz`), collection, bucket);
        return undefined;
      }

      const key = shardSetKey(collection, bucket);
      const filename = `${key}.json.gz`;
      const bucketCache = join(cacheDirectory, name);
      const cached = join(bucketCache, filename);
      if (!(await validSerializedShard(cached, collection, bucket))) {
        await mkdir(bucketCache, { recursive: true });
        await serializeBucket(cached, collection, bucket);
      }
      await link(cached, join(temporary, `${name}.json.gz`)).catch(() =>
        copyFile(cached, join(temporary, `${name}.json.gz`)),
      );
      return join(name, filename);
    }),
  );
  await rm(directory, { recursive: true, force: true });
  await rename(temporary, directory);
  return usedCacheFiles.filter((path): path is string => path !== undefined);
}
