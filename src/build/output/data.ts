import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hashSourceLines, normalizeSource, sourceLines } from "../../gml/source";
import type { Catalog } from "../../shared/catalog";
import { writeSerializedShards } from "../shards";
import type { ArtifactStore, StoreUsage } from "../store";

export async function writeCatalogOutputs(
  catalog: Catalog,
  sourcePaths: Map<string, string>,
  outputDirectory: string,
  store: ArtifactStore,
  usage: StoreUsage,
  shardPrefixLength?: number,
): Promise<void> {
  const dataDirectory = join(outputDirectory, "data");
  const sourceDirectory = join(dataDirectory, "sources");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(join(dataDirectory, "catalog.json"), JSON.stringify(catalog), "utf8");
  usage.shards.sources = await writeSerializedShards(
    sourceDirectory,
    "sources",
    [...sourcePaths].map(([hash, path]) => ({
      hash,
      async value() {
        const source = normalizeSource(await readFile(path, "utf8"));
        if (hashSourceLines(sourceLines(source)) !== hash) {
          throw new Error(`Source changed while building: ${path}`);
        }
        return JSON.stringify(source);
      },
    })),
    store.shardCache("sources"),
    shardPrefixLength,
  );
}

export async function writePayloadShards(
  viewerDataDirectory: string,
  payloads: Set<string>,
  store: ArtifactStore,
  usage: StoreUsage,
  shardPrefixLength?: number,
): Promise<void> {
  usage.shards.payloads = await writeSerializedShards(
    join(viewerDataDirectory, "payloads"),
    "payloads",
    [...payloads].map((hash) => ({
      hash,
      async value() {
        return store.openPayload(hash);
      },
    })),
    store.shardCache("payloads"),
    shardPrefixLength,
  );
}
