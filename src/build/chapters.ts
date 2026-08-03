import { join } from "node:path";

import { isDirectory } from "../platform/paths";
import { extractGameVersion } from "../gml/game-version";
import type { Build, Catalog, Chapter } from "../shared/catalog";
import { analyzeChapter, searchUrlForChapter } from "./analyze";
import type { BuildLog, BuildPlan } from "./plan";
import {
  assetTablesPath,
  assetTablesUrl,
  type ChapterJob,
  type RenderContext,
  type RenderedChapter,
  renderChapter,
  viewerManifestPath,
  viewerUrl,
} from "./render";

export interface CatalogStats {
  computed: number;
  cached: number;
}

interface BuildContext extends RenderContext {
  catalogStats: CatalogStats;
  fingerprint(directory: string): Promise<string>;
  log?: BuildLog;
}

interface ArchiveResult {
  catalog: Catalog;
  routingChapters: RenderedChapter[];
  sourcePaths: Map<string, string>;
}

export async function buildArchive(plan: BuildPlan, context: BuildContext): Promise<ArchiveResult> {
  const log: BuildLog = context.log ?? (() => {});
  const publicBuilds: Build[] = [];
  const routingChapters: RenderedChapter[] = [];
  const sourcePaths = new Map<string, string>();
  const canonicalChapterIds = new Set<string>();
  const searchTargets = new Set<string>();

  for (const [releaseIndex, release] of plan.releases.entries()) {
    const releaseLabel =
      release.label === undefined ? release.id : `${release.label} (${release.id})`;
    log(`Release ${releaseIndex + 1}/${plan.releases.length}: ${releaseLabel}`);
    const publicChapters: Chapter[] = [];
    for (const [chapterId, chapterLabel] of plan.chapters) {
      const inputDirectory = join(release.root, chapterId);
      if (!(await isDirectory(inputDirectory))) {
        log(`  ${chapterLabel} (${chapterId}): skipped, input not found.`);
        continue;
      }

      const fingerprint = await context.fingerprint(inputDirectory);
      context.usage.catalog.push({
        buildId: release.id,
        chapterId,
        fingerprint,
      });
      const { analysis, cached } = await analyzeChapter(
        { buildId: release.id, chapterId, inputDirectory, fingerprint },
        context.store,
      );
      context.catalogStats[cached ? "cached" : "computed"] += 1;
      log(
        `  ${chapterLabel} (${chapterId}): ${analysis.scripts.length} scripts, ` +
          `catalog ${cached ? "cache hit" : "computed"}.`,
      );

      for (const script of analysis.scripts) {
        if (sourcePaths.has(script.hash)) continue;
        sourcePaths.set(script.hash, join(inputDirectory, `${script.name}.gml`));
      }

      const isCanonical = !canonicalChapterIds.has(chapterId);
      if (isCanonical) canonicalChapterIds.add(chapterId);
      const search = searchUrlForChapter(chapterId, analysis.revision, plan.stamps.render);

      const job = planJob({
        plan,
        releaseId: release.id,
        chapterId,
        chapterLabel,
        inputDirectory,
        revision: analysis.revision,
        isCanonical,
        search,
        searchTargets,
      });
      const renderedBefore = context.stats.rendered;
      const cachedBefore = context.stats.cached;
      const result = await renderChapter(job, context, analysis.index);
      log(
        `  ${chapterLabel} (${chapterId}): ` +
          `${context.stats.rendered - renderedBefore} scripts rendered, ` +
          `${context.stats.cached - cachedBefore} cached.`,
      );
      routingChapters.push(result);

      publicChapters.push({
        id: chapterId,
        label: chapterLabel,
        revision: analysis.revision,
        gameVersion: await extractGameVersion(inputDirectory),
        viewer: viewerUrl(release.id, chapterId),
        search,
        ...(result.assetTables ? { assets: assetTablesUrl(release.id, chapterId) } : {}),
      });
    }
    if (publicChapters.length > 0) {
      publicBuilds.push({
        id: release.id,
        label: release.label ?? release.id,
        depotId: release.depotId,
        manifestId: release.manifestId,
        publishedAt: release.publishedAt,
        chapters: publicChapters,
      });
      log(`  Included ${publicChapters.length} chapter(s) in the public catalog.`);
    } else {
      log("  No configured chapters found in this release.");
    }
  }
  if (routingChapters.length === 0) {
    throw new Error(
      `No chapter directories found under ${plan.releases
        .map((release) => release.root)
        .join(", ")}`,
    );
  }

  return {
    catalog: {
      schemaVersion: 1,
      game: plan.config.game,
      builds: publicBuilds,
      timelineRelationships: plan.config.timelineRelationships,
    },
    routingChapters,
    sourcePaths,
  };
}

interface JobRequest {
  plan: BuildPlan;
  releaseId: string;
  chapterId: string;
  chapterLabel: string;
  inputDirectory: string;
  revision: string;
  isCanonical: boolean;
  search: string;
  searchTargets: Set<string>;
}

function planJob(request: JobRequest): ChapterJob {
  const { plan, chapterId } = request;
  const directory = join(plan.outputDirectory, chapterId);
  const viewerDataDirectory = join(plan.outputDirectory, "data", "pages");
  const filename = request.search.split("/").at(-1) ?? "index.json.gz";
  const target = join(directory, filename);
  const claimed = request.searchTargets.has(target);
  request.searchTargets.add(target);

  return {
    buildId: request.releaseId,
    chapterId,
    chapterLabel: request.chapterLabel,
    inputDirectory: request.inputDirectory,
    revision: request.revision,
    viewerManifestPaths: [
      ...(request.isCanonical ? [join(viewerDataDirectory, `${chapterId}.json.gz`)] : []),
      viewerManifestPath(viewerDataDirectory, request.releaseId, chapterId),
    ],
    assetTablesPath: assetTablesPath(viewerDataDirectory, request.releaseId, chapterId),
    searchIndexes: [
      ...(claimed ? [] : [{ directory, filename }]),
      ...(request.isCanonical ? [{ directory, filename: "index.json.gz" }] : []),
    ],
  };
}
