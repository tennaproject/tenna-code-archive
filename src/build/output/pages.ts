import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "../../game-data";
import type { TemplateRenderer } from "../../platform/templates";
import { writeGzipJson } from "../shards";
import type { AssetManifest } from "./assets";

function chrome(config: Config, assets: AssetManifest): Record<string, unknown> {
  return {
    game: config.game,
    links: Object.entries(config.links),
    footer: config.footer ?? null,
    assets,
  };
}

export async function writeChapterIndex(
  searchIndex: Record<string, string[]>,
  config: Config,
  chapterId: string,
  chapterLabel: string,
  assets: AssetManifest,
  renderTemplate: TemplateRenderer,
  outputDirectory: string,
  searchFilename = "index.json.gz",
): Promise<void> {
  const writes: Promise<void>[] = [
    writeGzipJson(join(outputDirectory, searchFilename), searchIndex),
  ];
  if (searchFilename === "index.json.gz") {
    writes.push(
      writeFile(
        join(outputDirectory, "index.html"),
        renderTemplate("chapter.html", {
          ...chrome(config, assets),
          chapter_id: chapterId,
          chapter_label: chapterLabel,
        }),
        "utf8",
      ),
    );
  }
  await Promise.all(writes);
}

export async function writeRootPages(
  config: Config,
  assets: AssetManifest,
  outputDirectory: string,
  renderTemplate: TemplateRenderer,
): Promise<void> {
  const shared = chrome(config, assets);
  await Promise.all([
    writeFile(
      join(outputDirectory, "script.html"),
      renderTemplate("script.html", {
        ...shared,
        chaptered: true,
      }),
      "utf8",
    ),
    writeFile(
      join(outputDirectory, "source.html"),
      renderTemplate("source.html", { assets }),
      "utf8",
    ),
    writeFile(join(outputDirectory, "index.html"), renderTemplate("timeline.html", shared), "utf8"),
    writeFile(
      join(outputDirectory, "compare.html"),
      renderTemplate("compare.html", shared),
      "utf8",
    ),
  ]);
}
