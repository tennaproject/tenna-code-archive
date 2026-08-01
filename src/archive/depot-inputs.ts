import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface DepotInput {
  chapter: string;
  dataFile: string;
}

async function dataFileExists(file: string): Promise<boolean> {
  return Bun.file(file).exists();
}

async function resolveDataFile(directory: string): Promise<string | undefined> {
  for (const name of ["data.win", "game.ios"]) {
    const direct = resolve(directory, name);
    if (await dataFileExists(direct)) return direct;
  }
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".app")) continue;
    const bundled = resolve(directory, entry, "Contents", "Resources", "game.ios");
    if (await dataFileExists(bundled)) return bundled;
  }
  return;
}

async function chapterInputs(depot: string): Promise<DepotInput[]> {
  const layouts = new Map<number, { windows?: string; mac?: string }>();
  for (const entry of await readdir(depot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = /^chapter([1-9]\d*)_(windows|mac)$/.exec(entry.name);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const chapter = Number(match[1]);
    const layout = layouts.get(chapter) ?? {};
    if (match[2] === "windows") {
      layout.windows = resolve(depot, entry.name, "data.win");
    } else {
      layout.mac = resolve(depot, entry.name, "game.ios");
    }
    layouts.set(chapter, layout);
  }

  const inputs: DepotInput[] = [];
  for (const [chapter, layout] of [...layouts].sort(([left], [right]) => left - right)) {
    const dataFile =
      layout.windows !== undefined && (await dataFileExists(layout.windows))
        ? layout.windows
        : layout.mac !== undefined && (await dataFileExists(layout.mac))
          ? layout.mac
          : undefined;
    if (dataFile === undefined) {
      throw new Error(`Missing game data for chapter ${chapter} under ${depot}`);
    }
    inputs.push({ chapter: `ch${chapter}`, dataFile });
  }
  return inputs;
}

export async function inputsForDepot(depot: string, singleChapter?: string): Promise<DepotInput[]> {
  const root = await resolveDataFile(depot);
  if (singleChapter !== undefined) {
    if (root === undefined) {
      throw new Error(`Missing data.win or game.ios under ${depot}`);
    }
    return [{ chapter: singleChapter, dataFile: root }];
  }
  const inputs = await chapterInputs(depot);
  if (inputs.length === 0) {
    if (root === undefined) {
      throw new Error(`Missing data.win or game.ios under ${depot}`);
    }
    return [{ chapter: "demo", dataFile: root }];
  }
  if (root === undefined) {
    throw new Error(`Missing chapter-select data.win or game.ios under ${depot}`);
  }
  return [{ chapter: "init", dataFile: root }, ...inputs];
}
