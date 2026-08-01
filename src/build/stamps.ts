import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const RENDER_SCHEMA = "7";
const CATALOG_SCHEMA = "4";

export async function fingerprintDirectory(directory: string): Promise<string> {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".gml"))
    .map((entry) => entry.name)
    .sort();
  const hash = createHash("sha256");
  const stats = await Promise.all(files.map((file) => stat(join(directory, file))));
  for (const [index, file] of files.entries()) {
    const info = stats[index];
    hash.update(file);
    hash.update("\0");
    hash.update(String(info?.size ?? 0));
    hash.update("\0");
    hash.update(String(info?.mtimeMs ?? 0));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function hashFiles(schema: string, files: string[]): Promise<string> {
  files.sort();
  const hash = createHash("sha256");
  hash.update(schema);
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(await readFile(file));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function computeRenderStamp(root: string): Promise<string> {
  const files = [
    join(root, "src", "game-data.ts"),
    join(root, "src", "gml", "annotations.ts"),
    join(root, "src", "gml", "highlight.ts"),
    join(root, "src", "gml", "source.ts"),
    join(root, "src", "gml", "indexer.ts"),
    join(root, "src", "shared", "renumbering.ts"),
    join(root, "src", "build", "render.ts"),
    join(root, "src", "platform", "templates.ts"),
  ];
  for (const name of [
    "enemies.json",
    "flags.json",
    "lang_en.json",
    "renumbering.json",
    "rooms.json",
  ]) {
    files.push(join(root, "data", name));
  }
  const highlightRoot = join(root, "templates", "highlight");
  for (const entry of await readdir(highlightRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(join(highlightRoot, entry.name));
    }
  }
  return hashFiles(RENDER_SCHEMA, files);
}

export async function computeCatalogStamp(root: string): Promise<string> {
  return hashFiles(CATALOG_SCHEMA, [
    join(root, "src", "build", "analyze.ts"),
    join(root, "src", "gml", "source.ts"),
    join(root, "src", "gml", "indexer.ts"),
  ]);
}
