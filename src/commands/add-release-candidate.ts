import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadReleaseSource } from "../archive/releases";
import { projectRoot } from "../platform/paths";

const values = new Map<string, string>();
for (let index = 0; index < Bun.argv.slice(2).length; index += 2) {
  const option = Bun.argv.slice(2)[index];
  const value = Bun.argv.slice(2)[index + 1];
  if (option === undefined || value === undefined || !option.startsWith("--")) {
    throw new Error(
      "Usage: bun run release:candidate --source <id> --date <YYYY-MM-DD> --manifest <id> --branch <branch> [--note <text>]",
    );
  }
  values.set(option.slice(2), value);
}
const sourceId = values.get("source");
const date = values.get("date");
const manifest = values.get("manifest");
const branch = values.get("branch") ?? "public";
if (sourceId === undefined || date === undefined || manifest === undefined) {
  throw new Error("source, date, and manifest are required");
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,20}$/.test(manifest)) {
  throw new Error("Invalid date or manifest ID");
}
if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
  throw new Error("Invalid calendar date");
}
if (!/^[A-Za-z0-9._-]+$/.test(branch)) throw new Error("Invalid branch name");
const source = await loadReleaseSource(sourceId);
if (source.appId === undefined || source.depotId === undefined) {
  throw new Error(`${sourceId} is not a Steam archive source`);
}
if (source.releases.some((release) => release.id === date || release.manifest === manifest)) {
  throw new Error("The release date or manifest already exists");
}
const file = resolve(projectRoot, "data", "releases.json");
const data = JSON.parse(await readFile(file, "utf8")) as Record<
  string,
  { releases: Record<string, unknown>[] }
>;
data[sourceId]!.releases.unshift({
  date,
  manifest,
  ...(branch === "public" ? {} : { branch }),
  ...(values.get("note") === undefined ? {} : { note: values.get("note") }),
});
await writeFile(file, `${JSON.stringify(data, undefined, 2)}\n`);
