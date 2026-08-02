import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { projectRoot } from "../platform/paths";

const output = resolve(Bun.argv[2] ?? resolve(projectRoot, "out", "deltarune"));
const required = [
  "index.html",
  "compare.html",
  "_redirects",
  ".build-stamp",
  "data/catalog.json",
  "data/aliases.json.gz",
  "data/embeds.json.gz",
  "data/build-provenance.json",
];
for (const file of required) {
  if (!(await Bun.file(resolve(output, file)).exists()))
    throw new Error(`Missing build file: ${file}`);
}
const catalog = JSON.parse(await readFile(resolve(output, "data", "catalog.json"), "utf8")) as {
  builds?: { chapters?: { id?: string }[] }[];
};
if (!Array.isArray(catalog.builds) || catalog.builds.length < 1) {
  throw new Error("Build catalog has no historical builds");
}
const chapters = new Set(
  catalog.builds.flatMap((build) => build.chapters ?? []).map((chapter) => chapter.id),
);
for (const chapter of chapters) {
  if (typeof chapter !== "string") continue;
  if (!(await Bun.file(resolve(output, chapter, "index.html")).exists())) {
    throw new Error(`Missing historical chapter URL: /${chapter}/`);
  }
  if (!(await Bun.file(resolve(output, chapter, "index.json.gz")).exists())) {
    throw new Error(`Missing search data for chapter: ${chapter}`);
  }
}
async function countFiles(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    count += entry.isDirectory() ? await countFiles(path) : 1;
  }
  return count;
}
const files = await countFiles(output);
if (files < 20) throw new Error(`Suspiciously small build: ${files} files`);
const bytes = (await stat(resolve(output, "data", "catalog.json"))).size;
console.log(
  `Smoke test passed: ${catalog.builds.length} builds, ${chapters.size} chapters, ${files} files, ${bytes} catalog bytes`,
);
