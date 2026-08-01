import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RenderedChapter } from "../render";
import { writeGzipJson } from "../shards";

interface ScriptAlias {
  canonical: string;
  chapters: string[];
}

function buildAliasMap(chapters: RenderedChapter[]): Record<string, ScriptAlias> {
  const aggregate = new Map<string, string[]>();
  for (const chapter of chapters) {
    for (const script of chapter.scripts) {
      let chapterIds = aggregate.get(script);
      if (chapterIds === undefined) {
        chapterIds = [];
        aggregate.set(script, chapterIds);
      }
      if (!chapterIds.includes(chapter.id)) chapterIds.push(chapter.id);
    }
  }

  const scripts: Record<string, ScriptAlias> = {};
  for (const [script, chapterIds] of aggregate) {
    scripts[script] = { canonical: script, chapters: chapterIds };
  }

  const normalizedAliases = new Map<string, string | undefined>();
  for (const script of aggregate.keys()) {
    const normalized = script.replace(/_{2,}/g, "_");
    if (normalized === script || aggregate.has(normalized)) continue;
    if (!normalizedAliases.has(normalized)) {
      normalizedAliases.set(normalized, script);
    } else if (normalizedAliases.get(normalized) !== script) {
      normalizedAliases.set(normalized, undefined);
    }
  }
  for (const [normalized, canonical] of normalizedAliases) {
    if (canonical === undefined) continue;
    const chapters = aggregate.get(canonical);
    if (chapters !== undefined) scripts[normalized] = { canonical, chapters };
  }
  return scripts;
}

export async function writeRouting(
  chapters: RenderedChapter[],
  routableChapterIds: string[],
  outputDirectory: string,
): Promise<void> {
  const dataDirectory = join(outputDirectory, "data");
  await mkdir(dataDirectory, { recursive: true });
  await writeGzipJson(join(dataDirectory, "aliases.json.gz"), {
    schemaVersion: 2,
    scripts: buildAliasMap(chapters),
  });

  const rewrites = routableChapterIds.map((chapterId) => `/${chapterId}/gml_* /script 200`);
  await writeFile(
    join(outputDirectory, "_redirects"),
    `${[...rewrites, "/gml_* /script 200"].join("\n")}\n`,
    "utf8",
  );
}
