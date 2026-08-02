import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "../../game-data";
import type { TemplateRenderer } from "../../platform/templates";
import { writeGzipJson } from "../shards";
import type { AssetManifest } from "./assets";

interface PageMeta {
  title: string;
  description: string;
  url: string;
}

const DEFAULT_META: PageMeta = {
  title: "Tenna Code Archive",
  description: "Browse DELTARUNE™ game script across releases.",
  url: "/",
};

function absolute(config: Config, path: string): string {
  return `${config.siteUrl ?? "https://code.tennaproject.com"}${path}`;
}

function chrome(
  config: Config,
  assets: AssetManifest,
  meta: PageMeta = DEFAULT_META,
): Record<string, unknown> {
  const title =
    meta.title === "Tenna Code Archive" ? meta.title : `${meta.title} - Tenna Code Archive`;
  return {
    game: config.game,
    links: Object.entries(config.links),
    footer: config.footer ?? null,
    assets,
    page_title: title,
    og_title: title,
    og_description: meta.description,
    og_url: absolute(config, meta.url),
    og_image: absolute(config, "/static/meta-banner.png"),
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
          ...chrome(config, assets, {
            title: chapterLabel,
            description: `DELTARUNE™ game script for ${chapterLabel}.`,
            url: `/${chapterId}/`,
          }),
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
  const scriptMeta = chrome(config, assets, {
    title: "Script",
    description: "Browse DELTARUNE™ game script across releases.",
    url: "/script.html",
  });
  const sourceMeta = chrome(config, assets, {
    title: "Raw source",
    description: "Raw DELTARUNE™ source code.",
    url: "/source.html",
  });
  const compareMeta = chrome(config, assets, {
    title: "Compare releases",
    description: "Compare DELTARUNE™ releases side by side.",
    url: "/compare.html",
  });
  await Promise.all([
    writeFile(
      join(outputDirectory, "script.html"),
      renderTemplate("script.html", {
        ...scriptMeta,
        chaptered: true,
      }),
      "utf8",
    ),
    writeFile(
      join(outputDirectory, "source.html"),
      renderTemplate("source.html", { ...sourceMeta, assets }),
      "utf8",
    ),
    writeFile(join(outputDirectory, "index.html"), renderTemplate("timeline.html", shared), "utf8"),
    writeFile(
      join(outputDirectory, "compare.html"),
      renderTemplate("compare.html", compareMeta),
      "utf8",
    ),
  ]);
}
