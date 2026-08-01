import type { Build, Catalog } from "../shared/catalog";

interface ContentShard<T> {
  schemaVersion: 1;
  [collection: string]: 1 | Record<string, T>;
}

async function fetchResponse(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} while loading ${url}`);
  return response;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetchResponse(url);
  return (await response.json()) as T;
}

export async function fetchCompressedJson<T>(url: string): Promise<T> {
  const response = await fetchResponse(url);
  if (response.body === null) throw new Error(`Empty response from ${url}`);
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This browser cannot decompress the archived script data. Please use a current browser.",
    );
  }
  const decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(decompressed).json()) as T;
}

let prefixLength: number | undefined;

function shardPrefixLength(): number {
  if (prefixLength !== undefined) return prefixLength;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="shard-prefix-length"]');
  const value = Number(meta?.content);
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error("Missing or invalid shard-prefix-length");
  }
  prefixLength = value;
  return value;
}

export function shardUrl(directory: string, hash: string): string {
  return `${directory}/${hash.slice(0, shardPrefixLength())}.json.gz`;
}

export async function fetchShardEntry<T>(
  directory: string,
  collection: string,
  hash: string,
): Promise<T> {
  const shard = await fetchCompressedJson<ContentShard<T>>(shardUrl(directory, hash));
  if (shard.schemaVersion !== 1) throw new Error("Unknown shard format");
  const entries = shard[collection] as Record<string, T>;
  const value = entries[hash];
  if (value === undefined) throw new Error("Content missing from shard");
  return value;
}

export function chapterReleases(catalog: Catalog, chapterId: string): Build[] {
  return catalog.builds.filter((build) =>
    build.chapters.some((chapter) => chapter.id === chapterId),
  );
}

export function manifestUrl(catalog: Catalog, chapterId: string, buildId?: string): string {
  if (buildId === undefined) {
    return `/data/pages/${encodeURIComponent(chapterId)}.json.gz`;
  }
  const chapter = catalog.builds
    .find((build) => build.id === buildId)
    ?.chapters.find((item) => item.id === chapterId);
  if (chapter === undefined) throw new Error("Release does not contain chapter");
  return chapter.viewer;
}
