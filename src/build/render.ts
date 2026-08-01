import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Config, DeltaruneData } from "../game-data";
import { annotateLine, annotateScript, type AnnotationContext } from "../gml/annotations";
import {
  indexGmlDirectory,
  type ScriptIndex,
  type Section,
  sectionsFromNames,
} from "../gml/indexer";
import { hashSourceLines } from "../gml/source";
import type { TemplateRenderer } from "../platform/templates";
import {
  ASSET_KINDS,
  type AssetTables,
  type AssetTablesFile,
  maskedSource,
  renumberTokens,
  type RenumberOverrides,
} from "../shared/renumbering";
import { type ScriptPayload, type Manifest, type Script } from "../shared/viewer";
import type { AssetManifest } from "./output/assets";
import { writeChapterIndex } from "./output/pages";
import { writeGzipJson } from "./shards";
import type { ArtifactStore, ChapterMeta, StoreUsage } from "./store";

export interface ChapterJob {
  buildId: string;
  chapterId: string;
  chapterLabel: string;
  inputDirectory: string;
  revision: string;
  viewerManifestPaths: string[];
  assetTablesPath?: string;
  searchIndexes: Array<{ directory: string; filename: string }>;
}

export interface RenderStats {
  rendered: number;
  cached: number;
}

export interface RenderContext {
  data: DeltaruneData;
  config: Config;
  renumberOverrides: RenumberOverrides;
  renderTemplate: TemplateRenderer;
  store: ArtifactStore;
  payloads: Set<string>;
  assets: AssetManifest;
  stats: RenderStats;
  usage: StoreUsage;
}

export interface RenderedChapter {
  id: string;
  scripts: string[];
  assetTables: boolean;
}

interface AssetInput {
  identity: string;
  tables?: AssetTables;
}

function serializePayload(lines: string[]): { hash: string; json: string } {
  const payload: ScriptPayload = { schemaVersion: 1, lines };
  const json = JSON.stringify(payload);
  return {
    hash: createHash("sha256").update(json).digest("hex"),
    json,
  };
}

async function annotateChapter(
  job: ChapterJob,
  context: RenderContext,
  preloaded: ScriptIndex | undefined,
  assetInput: AssetInput,
): Promise<{ sections: Section[]; meta: ChapterMeta }> {
  const index = preloaded ?? (await indexGmlDirectory(job.inputDirectory));
  const meta: ChapterMeta = {
    revision: job.revision,
    assetIdentity: assetInput.identity,
    scripts: {},
  };
  const annotationContext: AnnotationContext = {
    data: context.data,
    renderTemplate: context.renderTemplate,
    chapterId: job.chapterId,
    assets: assetInput.tables,
    assetTypes: context.renumberOverrides.assetType,
  };

  for (const [scriptName, lines] of index.text) {
    const sourceHash = index.hashes.get(scriptName);
    if (sourceHash === undefined) {
      throw new Error(`Missing source hash for ${scriptName}`);
    }
    const scans = index.scans.get(scriptName);
    const [search, annotated] = await Promise.all([
      Promise.all(lines.map((line) => annotateLine(line, context.data))),
      annotateScript(scriptName, index.text, annotationContext, scans),
    ]);
    const payload = serializePayload(annotated);
    await context.store.putPayload(payload.hash, payload.json);
    meta.scripts[scriptName] = {
      hash: sourceHash,
      masked: hashSourceLines([maskedSource(lines, context.renumberOverrides, scans)]).slice(0, 16),
      renumbering: renumberTokens(lines, context.renumberOverrides, scans),
      lines: lines.length,
      search,
      payload: payload.hash,
    };
    context.stats.rendered += 1;
  }

  await context.store.writeChapter(job.chapterId, job.revision, assetInput.identity, meta);
  return { sections: index.sections, meta };
}

function replayChapter(meta: ChapterMeta): {
  sections: Section[];
  meta: ChapterMeta;
} {
  const sections = sectionsFromNames(
    Object.entries(meta.scripts).map(
      ([name, script]) => [name, script.lines, script.hash] as const,
    ),
  );
  return { sections, meta };
}

function scriptsForViewer(
  sections: Section[],
  payloads: Record<
    string,
    { hash: string; masked: string; renumbering: Script["renumbering"]; payload: string }
  >,
): Record<string, Script> {
  const scripts: Record<string, Script> = {};
  for (const section of sections) {
    for (const group of section.groups) {
      for (const entry of group.entries) {
        const meta = payloads[entry.name];
        if (meta === undefined) {
          throw new Error(`Missing viewer payload for ${entry.name}`);
        }
        scripts[entry.name] = {
          payload: meta.payload,
          source: meta.hash,
          masked: meta.masked,
          renumbering: meta.renumbering,
          lines: entry.lines,
          type: section.type,
          group: group.name,
          prefix: entry.prefix,
          suffix: entry.suffix,
        };
      }
    }
  }
  return scripts;
}

async function writeViewerManifest(
  job: ChapterJob,
  context: RenderContext,
  sections: Section[],
  meta: ChapterMeta,
): Promise<void> {
  const manifest: Manifest = {
    schemaVersion: 1,
    chapterId: job.chapterId,
    chapterLabel: job.chapterLabel,
    game: context.config.game,
    scripts: scriptsForViewer(sections, meta.scripts),
  };
  await Promise.all(job.viewerManifestPaths.map((path) => writeGzipJson(path, manifest)));
}

function parseAssetTables(raw: string, path: string): AssetTables {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid asset tables in ${path}`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid asset tables in ${path}: expected an object`);
  }

  const record = value as Record<string, unknown>;
  const tables = {} as AssetTables;
  for (const kind of ASSET_KINDS) {
    const entries = record[kind];
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) {
      throw new Error(`Invalid asset tables in ${path}: ${kind} must be an array of strings`);
    }
    tables[kind] = entries;
  }
  return tables;
}

async function readAssetTables(inputDirectory: string): Promise<AssetInput> {
  const path = join(inputDirectory, "assets.json");
  let raw: Buffer | undefined;
  try {
    raw = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const hash = createHash("sha256");
  if (raw === undefined) {
    hash.update("missing\0");
    return { identity: hash.digest("hex") };
  }
  hash.update("present\0");
  hash.update(raw);
  return {
    identity: hash.digest("hex"),
    tables: parseAssetTables(raw.toString("utf8"), path),
  };
}

async function writeAssetTables(
  job: ChapterJob,
  context: RenderContext,
  tables: AssetTables | undefined,
): Promise<boolean> {
  if (job.assetTablesPath === undefined || tables === undefined) return false;
  const file: AssetTablesFile = {
    schemaVersion: 1,
    tables,
    overrides: context.renumberOverrides,
  };
  await writeGzipJson(job.assetTablesPath, file);
  return true;
}

async function writeSearchIndex(
  job: ChapterJob,
  context: RenderContext,
  meta: ChapterMeta,
): Promise<void> {
  if (job.searchIndexes.length === 0) return;
  const searchIndex = Object.fromEntries(
    Object.entries(meta.scripts).map(([name, script]) => [name, script.search]),
  );
  await Promise.all(
    job.searchIndexes.map(async ({ directory, filename }) => {
      await mkdir(directory, { recursive: true });
      await writeChapterIndex(
        searchIndex,
        context.config,
        job.chapterId,
        job.chapterLabel,
        context.assets,
        context.renderTemplate,
        directory,
        filename,
      );
    }),
  );
}

export async function renderChapter(
  job: ChapterJob,
  context: RenderContext,
  preloaded?: ScriptIndex,
): Promise<RenderedChapter> {
  const assetInput = await readAssetTables(job.inputDirectory);
  context.usage.chapters.push({
    chapterId: job.chapterId,
    revision: job.revision,
    assetIdentity: assetInput.identity,
  });

  const hit = await context.store.readChapter(job.chapterId, job.revision, assetInput.identity);
  const chapter =
    hit === undefined
      ? await annotateChapter(job, context, preloaded, assetInput)
      : replayChapter(hit);
  if (hit !== undefined) {
    context.stats.cached += Object.keys(hit.scripts).length;
  }

  for (const script of Object.values(chapter.meta.scripts)) {
    context.payloads.add(script.payload);
  }
  const [, , assetTables] = await Promise.all([
    writeViewerManifest(job, context, chapter.sections, chapter.meta),
    writeSearchIndex(job, context, chapter.meta),
    writeAssetTables(job, context, assetInput.tables),
  ]);

  return {
    id: job.chapterId,
    scripts: Object.keys(chapter.meta.scripts),
    assetTables,
  };
}

export function viewerManifestPath(
  viewerDataDirectory: string,
  buildId: string,
  chapterId: string,
): string {
  return join(viewerDataDirectory, "builds", buildId, `${chapterId}.json.gz`);
}

export function viewerUrl(buildId: string, chapterId: string): string {
  return `/data/pages/builds/${buildId}/${chapterId}.json.gz`;
}

export function assetTablesPath(
  viewerDataDirectory: string,
  buildId: string,
  chapterId: string,
): string {
  return join(viewerDataDirectory, "builds", buildId, `${chapterId}.assets.json.gz`);
}

export function assetTablesUrl(buildId: string, chapterId: string): string {
  return `/data/pages/builds/${buildId}/${chapterId}.assets.json.gz`;
}
